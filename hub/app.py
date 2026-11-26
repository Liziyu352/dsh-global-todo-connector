"""HTTP surface for the optional local Connector Hub.

The hub exists so that several DeepSeek Harness instances (possibly on
different machines) can share one set of todo connector definitions, their
shared sync state, a run log, and a short-lived write lease per connector.

Design notes that matter for correctness:

* Every handler is a plain ``def``: FastAPI runs it in its thread pool, which is
  what allows the synchronous ``sqlite3`` store to be used at all.
* All mutations behind the auth dependency so no route can accidentally be
  exposed without the token check.
* Errors always come back as ``{"ok": false, "reason", "error"}`` with a
  matching HTTP status; success is always ``{"ok": true, "data": ...}``.
"""

from __future__ import annotations

import argparse
import hmac
import ipaddress
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

# Allow both `python -m hub.app` and `python hub/app.py`.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hub.store import (  # noqa: E402  (import after the sys.path bootstrap)
    MAX_CONNECTOR_BYTES,
    MAX_RUN_BYTES,
    Store,
    RevisionConflict,
    LeaseHeld,
    clamp_ttl,
)

HUB_NAME = "dsh-global-todo-connector-hub"
HUB_VERSION = "0.1.0"

# Bodies far above the documented limits are rejected from the header alone,
# before Starlette buffers them in memory.
MAX_REQUEST_BYTES = 2 * 1024 * 1024

# NOTE: no module-level ``app`` object.  A real attribute would shadow
# ``__getattr__`` below and leave uvicorn serving ``None``.
__all__ = ["app", "create_app"]


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class ConnectorPut(BaseModel):
    yaml: str
    owner: Optional[str] = None
    revision: Optional[int] = Field(default=None, ge=0)


class LeaseCreate(BaseModel):
    connector: str = Field(min_length=1, max_length=200)
    instance: str = Field(min_length=1, max_length=200)
    ttlSeconds: Optional[int] = None


class LeaseRenew(BaseModel):
    ttlSeconds: Optional[int] = None


class StatePut(BaseModel):
    # Required, but explicitly nullable: clients must say "clear it" with null
    # rather than forgetting the field and silently wiping shared state.
    state: Any
    revision: Optional[int] = Field(default=None, ge=0)


class RunCreate(BaseModel):
    connector: str = Field(min_length=1, max_length=200)
    run: dict[str, Any]


# ---------------------------------------------------------------------------
# Envelope helpers
# ---------------------------------------------------------------------------


def ok(data: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse({"ok": True, "data": data}, status_code=status_code)


def fail(status_code: int, reason: str, error: str, **extra: Any) -> JSONResponse:
    body = {"ok": False, "reason": reason, "error": error}
    body.update(extra)
    return JSONResponse(body, status_code=status_code)


def _is_loopback(host: Optional[str]) -> bool:
    """True for 127.0.0.0/8, ::1 and IPv4-mapped loopback forms."""

    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # A non-IP client host (unix socket, malformed proxy value) must not be
        # treated as local by accident.
        return False
    if ip.is_loopback:
        return True
    mapped = getattr(ip, "ipv4_mapped", None)
    return bool(mapped and mapped.is_loopback)


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------


def create_app(
    data_dir: str | os.PathLike[str] | None = None,
    token: Optional[str] = None,
) -> FastAPI:
    """Build a hub app.  ``token`` overrides ``GTC_HUB_TOKEN`` when not None."""

    resolved_token = token if token is not None else os.environ.get("GTC_HUB_TOKEN", "")
    resolved_token = resolved_token or ""
    resolved_data = Path(
        data_dir
        if data_dir is not None
        else os.environ.get("GTC_HUB_DATA", "./data")
    ).expanduser()

    store = Store(resolved_data)
    started_at = time.time()

    app = FastAPI(
        title="DSH Global Todo Connector Hub",
        version=HUB_VERSION,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.store = store
    app.state.token = resolved_token

    @app.middleware("http")
    async def limit_body_size(request: Request, call_next):
        # Only guard the API surface; /health never carries a body.
        if request.url.path.startswith("/v1/"):
            length = request.headers.get("content-length")
            if length is not None:
                try:
                    if int(length) > MAX_REQUEST_BYTES:
                        return fail(413, "payload-too-large", "请求体过大（上限 2 MiB）")
                except ValueError:
                    pass
        return await call_next(request)

    def require_auth(request: Request) -> None:
        """Enforce the token / loopback policy for every /v1 route."""

        if resolved_token:
            supplied = request.headers.get("x-hub-token", "")
            # Compare bytes so a non-ASCII token cannot raise TypeError inside
            # hmac.compare_digest (which only accepts ASCII text).
            if not hmac.compare_digest(
                supplied.encode("utf-8", "surrogatepass"),
                resolved_token.encode("utf-8", "surrogatepass"),
            ):
                raise HTTPException(
                    status_code=401,
                    detail={
                        "reason": "unauthorized",
                        "error": "X-Hub-Token 缺失或不正确",
                    },
                )
            return

        if not _is_loopback(request.client.host if request.client else None):
            raise HTTPException(
                status_code=403,
                detail={
                    "reason": "forbidden",
                    "error": "hub 未设置 token，只接受本机请求",
                },
            )

    # -- exception handlers: keep every response inside the envelope --------

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        detail = exc.detail
        if isinstance(detail, dict) and "reason" in detail:
            return fail(exc.status_code, detail["reason"], detail.get("error", ""))
        if exc.status_code == 404:
            return fail(404, "not-found", "资源不存在")
        if exc.status_code == 405:
            return fail(405, "method-not-allowed", "请求方法不被允许")
        return fail(exc.status_code, "http-error", str(detail))

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        location = ".".join(str(part) for part in first.get("loc", ()))
        message = first.get("msg", "invalid request")
        return fail(422, "invalid-request", f"请求参数不合法：{location}: {message}")

    @app.exception_handler(RevisionConflict)
    async def revision_conflict_handler(request: Request, exc: RevisionConflict):
        return fail(
            409,
            "revision-conflict",
            f"revision 不匹配，当前 revision 为 {exc.current_revision}",
        )

    # -- health -------------------------------------------------------------

    @app.get("/health")
    def health():
        # Unauthenticated on purpose: it reveals only counts, and lets a
        # supervisor or load balancer probe the hub without the token.
        return ok(
            {
                "name": HUB_NAME,
                "version": HUB_VERSION,
                "uptimeSeconds": int(time.time() - started_at),
                "connectors": store.count_connectors(),
                "activeLeases": store.count_active_leases(),
                "now": _now(),
            }
        )

    # -- connectors ---------------------------------------------------------

    @app.get("/v1/connectors", dependencies=[Depends(require_auth)])
    def list_connectors():
        return ok({"connectors": store.list_connectors()})

    @app.get("/v1/connectors/{name}", dependencies=[Depends(require_auth)])
    def get_connector(name: str):
        connector = store.get_connector(name)
        if connector is None:
            return fail(404, "not-found", f"连接器 {name!r} 不存在")
        return ok(connector)

    @app.put("/v1/connectors/{name}", dependencies=[Depends(require_auth)])
    def put_connector(name: str, body: ConnectorPut):
        name = name.strip()
        if not name or len(name) > 200:
            return fail(422, "invalid-name", "连接器名称必须为 1-200 个字符")
        if not body.yaml.strip():
            return fail(422, "invalid-yaml", "yaml 不能为空")
        if len(body.yaml.encode("utf-8")) > MAX_CONNECTOR_BYTES:
            return fail(413, "payload-too-large", "yaml 超过 1 MiB 上限")
        result = store.put_connector(name, body.yaml, body.owner, body.revision)
        return ok(result)

    @app.delete("/v1/connectors/{name}", dependencies=[Depends(require_auth)])
    def delete_connector(name: str, revision: Optional[int] = Query(default=None, ge=0)):
        deleted = store.delete_connector(name, revision)
        if not deleted:
            return fail(404, "not-found", f"连接器 {name!r} 不存在")
        return ok({"deleted": True})

    # -- leases -------------------------------------------------------------

    @app.post("/v1/leases", status_code=201, dependencies=[Depends(require_auth)])
    def create_lease(body: LeaseCreate):
        connector = body.connector.strip()
        instance = body.instance.strip()
        if not connector or not instance:
            return fail(422, "invalid-request", "connector 和 instance 不能为空")
        try:
            lease = store.acquire_lease(connector, instance, body.ttlSeconds)
        except LeaseHeld as exc:
            return fail(
                409,
                "lease-held",
                f"连接器 {connector!r} 已被 {exc.holder['instance']!r} 占用",
                holder=exc.holder,
            )
        return ok(lease, status_code=201)

    @app.post("/v1/leases/{lease_id}/renew", dependencies=[Depends(require_auth)])
    def renew_lease(lease_id: str, body: Optional[LeaseRenew] = None):
        ttl = clamp_ttl(body.ttlSeconds if body else None)
        renewed = store.renew_lease(lease_id, ttl)
        if renewed is None:
            return fail(404, "lease-missing", "租约不存在或已过期")
        return ok(renewed)

    @app.delete("/v1/leases/{lease_id}", dependencies=[Depends(require_auth)])
    def release_lease(lease_id: str):
        released = store.release_lease(lease_id)
        # Idempotent by design: a retry after a lost response must not fail.
        return ok({"released": released})

    # -- shared state -------------------------------------------------------

    @app.get("/v1/state/{connector}", dependencies=[Depends(require_auth)])
    def get_state(connector: str):
        return ok(store.get_state(connector))

    @app.put("/v1/state/{connector}", dependencies=[Depends(require_auth)])
    def put_state(connector: str, body: StatePut):
        result = store.put_state(connector, body.state, body.revision)
        return ok(result)

    # -- run log ------------------------------------------------------------

    @app.post("/v1/runs", dependencies=[Depends(require_auth)])
    def add_run(body: RunCreate):
        connector = body.connector.strip()
        if not connector:
            return fail(422, "invalid-request", "connector 不能为空")
        encoded = _encode_size(body.run)
        if encoded > MAX_RUN_BYTES:
            return fail(413, "payload-too-large", "run 超过 64 KiB 上限")
        run_id = store.add_run(connector, body.run)
        return ok({"id": run_id})

    @app.get("/v1/runs", dependencies=[Depends(require_auth)])
    def list_runs(
        connector: Optional[str] = Query(default=None),
        limit: int = Query(default=20, ge=1, le=200),
    ):
        return ok({"runs": store.list_runs(connector, limit)})

    # -- diagnostics --------------------------------------------------------

    @app.get("/v1/stats", dependencies=[Depends(require_auth)])
    def stats():
        return ok(store.stats())

    return app


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _encode_size(value: Any) -> int:
    import json

    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="dsh-connector-hub",
        description="Local Connector Hub for the DSH global todo connector plugin.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="bind port (default: 8765)")
    parser.add_argument(
        "--data",
        default=os.environ.get("GTC_HUB_DATA", "./data"),
        help="data directory for hub.db (default: $GTC_HUB_DATA or ./data)",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="shared token; overrides $GTC_HUB_TOKEN",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> None:
    import uvicorn

    args = _parse_args(argv)
    application = create_app(data_dir=args.data, token=args.token)

    token = application.state.token
    if token:
        auth_mode = "token required (X-Hub-Token) for all /v1 routes"
    else:
        auth_mode = "no token configured; loopback clients only"
    print(f"[hub] {HUB_NAME} {HUB_VERSION} on http://{args.host}:{args.port}")
    print(f"[hub] data: {application.state.store.db_path}")
    print(f"[hub] auth: {auth_mode}", flush=True)

    uvicorn.run(application, host=args.host, port=args.port, log_level="info")


def __getattr__(name: str) -> Any:
    """Expose ``hub.app:app`` lazily.

    Importing the module must stay side-effect free: tests and scripts import
    helpers without wanting a ``./data`` directory.  PEP 562 lazy attributes
    give ``uvicorn hub.app:app`` what it needs without that cost.
    """

    if name == "app":
        global app
        app = create_app()
        return app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


if __name__ == "__main__":
    main()
