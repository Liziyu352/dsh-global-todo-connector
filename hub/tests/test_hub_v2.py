"""Tests for the v2 hub features: file-manager, request proxy, task-watcher.

The style matches ``test_hub.py``: a fresh app per test with its database in
``tmp_path``, and the ``ClientHost`` ASGI wrapper so the loopback policy can be
exercised without weakening production code.

No test reaches the network.  Outbound requests go through
``httpx.MockTransport``; DNS is stubbed through the proxy's ``resolver`` hook so
the public-address check stays deterministic.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hub.app import create_app  # noqa: E402
from hub.files import normalize_document, normalize_todo  # noqa: E402
from hub.request import (  # noqa: E402
    BlockedTarget,
    RateLimiter,
    RequestProxy,
    SecretStore,
    validate_target,
)
from hub.store import LeaseHeld, Store, _SCHEMA_V1  # noqa: E402
from hub.watcher import WatcherService, clamp_every_minutes, validate_callback_url  # noqa: E402

TOKEN = "test-token-0123456789"


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


class ClientHost:
    """Pin ``request.client`` to a chosen address (see test_hub.py)."""

    def __init__(self, app, host: str = "127.0.0.1") -> None:
        self.app = app
        self.host = host

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope = dict(scope)
            scope["client"] = (self.host, 50000)
        await self.app(scope, receive, send)


def fastapi_app(client: TestClient):
    """Unwrap ``TestClient -> ClientHost -> FastAPI``."""

    wrapped = client.app
    return getattr(wrapped, "app", wrapped)


def make_client(
    tmp_path: Path,
    token: str | None = TOKEN,
    host: str = "127.0.0.1",
    todo_store: Path | None = None,
) -> TestClient:
    app = create_app(
        data_dir=tmp_path,
        token=token if token is not None else "",
        todo_store=todo_store,
        enable_watcher=False,
    )
    return TestClient(ClientHost(app, host=host))


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return make_client(tmp_path)


def auth() -> dict[str, str]:
    return {"X-Hub-Token": TOKEN}


def todo_doc(*titles: str) -> dict:
    todos = []
    for index, title in enumerate(titles):
        todos.append(
            {
                "id": f"t-{index:08d}",
                "title": title,
                "status": "open",
                "priority": "normal",
                "createdAt": 1_700_000_000_000,
                "updatedAt": 1_700_000_000_000,
            }
        )
    return {"version": 2, "todos": todos, "trash": []}


# ---------------------------------------------------------------------------
# File manager
# ---------------------------------------------------------------------------


def test_file_manager_roundtrip_and_revision(tmp_path: Path) -> None:
    store_path = tmp_path / "todos" / "todos.json"
    client = make_client(tmp_path / "hub", todo_store=store_path)

    # Missing file reads as an empty document at revision 0.
    first = client.get("/v1/files/todo-store", headers=auth())
    assert first.status_code == 200
    data = first.json()["data"]
    assert data["doc"] == {"version": 2, "todos": [], "trash": []}
    # The document is also flattened at the top level (DESIGN-v2 §3.1).
    assert (data["version"], data["todos"], data["trash"]) == (2, [], [])
    assert data["revision"] == 0

    written = client.put(
        "/v1/files/todo-store",
        json={"doc": todo_doc("写周报"), "revision": 0},
        headers=auth(),
    )
    assert written.status_code == 200
    assert written.json()["data"]["revision"] == 1

    # The body really landed on disk as a normal JSON document the upstream
    # plugin can read on its own.
    on_disk = json.loads(store_path.read_text(encoding="utf-8"))
    assert on_disk["todos"][0]["title"] == "写周报"
    assert on_disk["version"] == 2

    again = client.get("/v1/files/todo-store", headers=auth()).json()["data"]
    assert again["revision"] == 1
    assert again["doc"]["todos"][0]["id"] == "t-00000000"
    assert again["todos"][0]["title"] == "写周报"
    assert again["version"] == 2
    assert again["exists"] is True


def test_file_manager_rejects_stale_revision(tmp_path: Path) -> None:
    store_path = tmp_path / "todos.json"
    client = make_client(tmp_path / "hub", todo_store=store_path)

    client.put("/v1/files/todo-store", json={"doc": todo_doc("一"), "revision": 0}, headers=auth())
    conflict = client.put(
        "/v1/files/todo-store",
        json={"doc": todo_doc("二"), "revision": 0},
        headers=auth(),
    )
    assert conflict.status_code == 409
    body = conflict.json()
    assert body["reason"] == "revision-conflict"
    assert body["currentRevision"] == 1

    # A successful write with the right token still works afterwards.
    after = client.put(
        "/v1/files/todo-store",
        json={"doc": todo_doc("三"), "revision": 1},
        headers=auth(),
    )
    assert after.status_code == 200
    assert after.json()["data"]["revision"] == 2


def test_file_manager_salvages_bad_records(tmp_path: Path) -> None:
    store_path = tmp_path / "todos.json"
    client = make_client(tmp_path / "hub", todo_store=store_path)

    doc = {
        "version": 2,
        # Missing title, missing id and a non-object all get dropped; the
        # unknown custom field on the good row must survive.
        "todos": [
            {"id": "t-1", "title": "保留", "customField": {"nested": True}},
            {"id": "t-2"},
            {"title": "没有 id"},
            "not-an-object",
            {"id": "t-1", "title": "重复 id"},
        ],
        "trash": [{"id": "t-9", "title": "已删"}, "junk"],
    }
    response = client.put("/v1/files/todo-store", json={"doc": doc, "revision": 0}, headers=auth())
    assert response.status_code == 200

    stored = client.get("/v1/files/todo-store", headers=auth()).json()["data"]["doc"]
    assert [todo["title"] for todo in stored["todos"]] == ["保留"]
    assert stored["todos"][0]["customField"] == {"nested": True}
    assert len(stored["trash"]) == 1
    # Defaults are filled in for fields the caller omitted.
    assert stored["todos"][0]["status"] == "open"
    assert stored["todos"][0]["priority"] == "normal"


def test_file_manager_rejects_bad_shape_and_unknown_name(tmp_path: Path) -> None:
    client = make_client(tmp_path, todo_store=tmp_path / "todos.json")

    bad_todos = client.put(
        "/v1/files/todo-store",
        json={"doc": {"version": 2, "todos": "nope"}, "revision": 0},
        headers=auth(),
    )
    assert bad_todos.status_code == 422
    assert bad_todos.json()["reason"] == "invalid-document"

    future = client.put(
        "/v1/files/todo-store",
        json={"doc": {"version": 9, "todos": []}, "revision": 0},
        headers=auth(),
    )
    assert future.status_code == 422

    unknown = client.get("/v1/files/secrets", headers=auth())
    assert unknown.status_code == 404
    assert unknown.json()["reason"] == "not-found"

    assert client.put("/v1/files/todo-store", json={"doc": todo_doc()}, headers=auth()).status_code == 422


def test_file_manager_disabled_without_todo_store(client: TestClient) -> None:
    response = client.get("/v1/files/todo-store", headers=auth())
    assert response.status_code == 503
    assert response.json()["reason"] == "file-manager-disabled"


def test_file_manager_requires_token(tmp_path: Path) -> None:
    client = make_client(tmp_path, todo_store=tmp_path / "todos.json")
    # Remote host + no token: the file API must not be an unauthenticated hole.
    remote = make_client(tmp_path, token="", host="203.0.113.5", todo_store=tmp_path / "todos.json")
    assert remote.get("/v1/files/todo-store").status_code == 403
    assert client.get("/v1/files/todo-store").status_code == 401


def test_normalize_document_is_defensive() -> None:
    assert normalize_todo("x") is None
    assert normalize_todo({"id": "", "title": "t"}) is None
    assert normalize_todo({"id": "t-1", "title": "   "}) is None
    doc = normalize_document({"version": 2, "todos": [{"id": "t-1", "title": "ok"}], "trash": []})
    assert doc["todos"][0]["id"] == "t-1"
    # A missing version falls back to the schema this hub understands.
    assert normalize_document({})["version"] == 2


# ---------------------------------------------------------------------------
# Schema migration
# ---------------------------------------------------------------------------


def test_schema_migrates_v1_database_in_place(tmp_path: Path) -> None:
    # Build a genuine v1 database first, exactly as the released hub wrote it.
    db_path = tmp_path / "hub.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA_V1)
    conn.execute(
        "INSERT INTO connectors (name, yaml, revision, hash, owner, updated_at) "
        "VALUES ('legacy', 'a: 1', 3, 'abc', 'old-box', '2026-01-01T00:00:00+00:00')"
    )
    conn.commit()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 1
    conn.close()

    store = Store(tmp_path)

    with sqlite3.connect(db_path) as check:
        assert check.execute("PRAGMA user_version").fetchone()[0] == 2
        tables = {row[0] for row in check.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"files", "watchers"} <= tables

    # Existing data survives the migration untouched.
    legacy = store.get_connector("legacy")
    assert legacy is not None
    assert legacy["revision"] == 3
    assert legacy["yaml"] == "a: 1"

    # And the new tables are usable.
    store.put_watcher("legacy", 15, "http://127.0.0.1:3080/sync", "box-a", "2026-01-01T00:00:00+00:00")
    assert store.count_watchers() == 1


def test_file_revision_is_independent_of_connector_revisions(tmp_path: Path) -> None:
    store = Store(tmp_path)
    assert store.file_revision("todo-store") == 0
    assert store.commit_file("todo-store", 0, lambda: None) == 1
    assert store.commit_file("todo-store", 1, lambda: None) == 2
    try:
        store.commit_file("todo-store", 0, lambda: None)
    except Exception as error:  # noqa: BLE001 - the type is asserted next
        assert type(error).__name__ == "RevisionConflict"
    else:  # pragma: no cover
        pytest.fail("stale revision was accepted")
    assert store.file_revision("todo-store") == 2


# ---------------------------------------------------------------------------
# SSRF guard
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8765/v1/connectors",
        "http://localhost/admin",  # resolves to loopback on every sane host
        "http://[::1]/x",
        "http://10.1.2.3/internal",
        "http://192.168.1.1/",
        "http://172.16.0.9/",
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://0.0.0.0/",
        "http://2130706433/",  # decimal encoding of 127.0.0.1
        "http://[::ffff:127.0.0.1]/",
    ],
)
def test_ssrf_rejects_non_public_targets(url: str) -> None:
    with pytest.raises(BlockedTarget):
        validate_target(url)


@pytest.mark.parametrize(
    "url,reason",
    [
        ("ftp://example.com/x", "invalid-request"),
        ("", "invalid-request"),
        ("http:///nohost", "invalid-request"),
    ],
)
def test_ssrf_rejects_malformed_urls(url: str, reason: str) -> None:
    with pytest.raises(Exception) as caught:
        validate_target(url)
    assert getattr(caught.value, "reason", None) == reason


def test_ssrf_blocks_private_response_through_route(client: TestClient) -> None:
    response = client.post(
        "/v1/request",
        json={"kind": "rest", "url": "http://127.0.0.1:9999/steal", "method": "GET"},
        headers={**auth(), "x-connector": "demo"},
    )
    assert response.status_code == 403
    body = response.json()
    assert body["ok"] is False
    assert body["reason"] == "blocked-target"

    # The attempt is audited even though it never left the box.
    runs = client.get("/v1/runs?connector=demo", headers=auth()).json()["data"]["runs"]
    assert runs[0]["run"]["kind"] == "proxy-request"
    assert runs[0]["run"]["ok"] is False
    assert runs[0]["run"]["error"] == "blocked-target"


def test_ssrf_allows_public_literal_and_keeps_port() -> None:
    schema, host, port = validate_target("https://93.184.216.34/v1/items?x=1")
    assert (schema, host, port) == ("https", "93.184.216.34", 443)

    schema, host, port = validate_target("http://93.184.216.34:8080/x")
    assert (schema, host, port) == ("http", "93.184.216.34", 8080)


def test_ssrf_resolves_hostnames_before_allowing(monkeypatch: pytest.MonkeyPatch) -> None:
    """A name is only allowed when *every* resolved address is public."""

    import hub.request as request_module

    def fake_public(host, port, **kwargs):
        return [(2, 1, 6, "", ("93.184.216.34", port))]

    monkeypatch.setattr(request_module.socket, "getaddrinfo", fake_public)
    assert validate_target("https://api.example.com/v1/items") == ("https", "api.example.com", 443)

    # One private address among the answers is enough to reject the whole name:
    # otherwise a split-horizon DNS record could smuggle the request inside.
    def fake_mixed(host, port, **kwargs):
        return [
            (2, 1, 6, "", ("93.184.216.34", port)),
            (2, 1, 6, "", ("10.0.0.5", port)),
        ]

    monkeypatch.setattr(request_module.socket, "getaddrinfo", fake_mixed)
    with pytest.raises(BlockedTarget):
        validate_target("https://api.example.com/v1/items")


# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------


def test_secret_store_substitutes_aliases(tmp_path: Path) -> None:
    secrets = tmp_path / "secrets.json"
    secrets.write_text(json.dumps({"TODOIST": "Bearer real-token"}), encoding="utf-8")
    secrets.chmod(0o600)

    store = SecretStore(tmp_path)
    headers, warnings = store.resolve({"Authorization": "${secret:TODOIST}", "Accept": "application/json"})
    assert headers["Authorization"] == "Bearer real-token"
    assert headers["Accept"] == "application/json"
    assert warnings == []


def test_secret_store_missing_alias_becomes_empty_and_warns(tmp_path: Path) -> None:
    (tmp_path / "secrets.json").write_text(json.dumps({"OTHER": "x"}), encoding="utf-8")
    headers, warnings = SecretStore(tmp_path).resolve({"Authorization": "Bearer ${secret:NOPE}"})
    assert headers["Authorization"] == "Bearer "
    assert len(warnings) == 1
    assert "NOPE" in warnings[0]


def test_secret_store_absent_file_is_empty(tmp_path: Path) -> None:
    headers, warnings = SecretStore(tmp_path).resolve({"A": "${secret:X}"})
    assert headers == {"A": ""}
    assert warnings


# ---------------------------------------------------------------------------
# Request proxy end to end (mock transport)
# ---------------------------------------------------------------------------


def _proxy_with_transport(client: TestClient, handler) -> RequestProxy:
    proxy = fastapi_app(client).state.proxy
    proxy._client = httpx.Client(transport=httpx.MockTransport(handler))
    proxy._resolver = lambda url: ("https", "api.example.com", 443)
    return proxy


def test_proxy_forwards_and_audits_without_header_values(client: TestClient, tmp_path: Path) -> None:
    (tmp_path / "secrets.json").write_text(json.dumps({"TODOIST": "SECRET-VALUE"}), encoding="utf-8")
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["method"] = request.method
        return httpx.Response(200, json={"items": [1, 2]})

    _proxy_with_transport(client, handler)

    response = client.post(
        "/v1/request",
        json={
            "kind": "rest",
            "url": "https://api.example.com/rest/v2/items?token=leaky",
            "method": "GET",
            "headers": {"Authorization": "${secret:TODOIST}"},
        },
        headers={**auth(), "x-connector": "todoist"},
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["status"] == 200
    assert data["body"] == {"items": [1, 2]}
    assert isinstance(data["durationMs"], int)

    # The secret was substituted on the way out...
    assert seen["auth"] == "SECRET-VALUE"
    assert seen["method"] == "GET"

    # ...and never appears in the run log, not even in the URL query string.
    runs = client.get("/v1/runs?connector=todoist", headers=auth()).json()["data"]["runs"]
    record = runs[0]["run"]
    assert record["kind"] == "proxy-request"
    assert record["status"] == 200
    assert record["ok"] is True
    serialized = json.dumps(record)
    assert "SECRET-VALUE" not in serialized
    assert "leaky" not in serialized
    assert "api.example.com/rest/v2/items" in serialized


def test_proxy_records_upstream_failure_as_ok_false(client: TestClient) -> None:
    _proxy_with_transport(client, lambda request: httpx.Response(503, text="busy"))
    response = client.post(
        "/v1/request",
        json={"kind": "rest", "url": "https://api.example.com/x", "method": "POST", "body": {"a": 1}},
        headers={**auth(), "x-connector": "demo"},
    )
    assert response.status_code == 200
    assert response.json()["data"]["status"] == 503
    assert response.json()["data"]["body"] == "busy"

    record = client.get("/v1/runs?connector=demo", headers=auth()).json()["data"]["runs"][0]["run"]
    assert record["ok"] is False


def test_proxy_honours_success_list(client: TestClient) -> None:
    _proxy_with_transport(client, lambda request: httpx.Response(201, text="created"))
    client.post(
        "/v1/request",
        json={
            "kind": "rest",
            "url": "https://api.example.com/x",
            "method": "POST",
            "success": [200, 201],
        },
        headers={**auth(), "x-connector": "demo"},
    )
    record = client.get("/v1/runs?connector=demo", headers=auth()).json()["data"]["runs"][0]["run"]
    assert record["ok"] is True


def test_proxy_rejects_non_rest_kind(client: TestClient) -> None:
    response = client.post(
        "/v1/request",
        json={"kind": "cmd", "url": "https://api.example.com/x"},
        headers=auth(),
    )
    assert response.status_code == 422
    assert response.json()["reason"] == "invalid-request"


def test_proxy_response_cap(client: TestClient) -> None:
    _proxy_with_transport(client, lambda request: httpx.Response(200, content=b"x" * (9 * 1024 * 1024)))
    response = client.post(
        "/v1/request",
        json={"kind": "rest", "url": "https://api.example.com/big"},
        headers={**auth(), "x-connector": "demo"},
    )
    assert response.status_code == 502
    assert response.json()["reason"] == "response-too-large"


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


def test_rate_limiter_sliding_window() -> None:
    now = [0.0]
    limiter = RateLimiter(limit=2, window_seconds=60.0, clock=lambda: now[0])
    limiter.check("c")
    limiter.check("c")
    with pytest.raises(Exception) as caught:
        limiter.check("c")
    assert getattr(caught.value, "reason", None) == "rate-limited"

    # The window really slides: after it passes the bucket is empty again.
    now[0] = 61.0
    limiter.check("c")


def test_rate_limit_returns_429_through_route(client: TestClient) -> None:
    proxy = _proxy_with_transport(client, lambda request: httpx.Response(200, text="ok"))
    proxy.limiter = RateLimiter(limit=2, window_seconds=60.0, clock=lambda: 0.0)

    for _ in range(2):
        ok_response = client.post(
            "/v1/request",
            json={"kind": "rest", "url": "https://api.example.com/x"},
            headers={**auth(), "x-connector": "flood"},
        )
        assert ok_response.status_code == 200

    throttled = client.post(
        "/v1/request",
        json={"kind": "rest", "url": "https://api.example.com/x"},
        headers={**auth(), "x-connector": "flood"},
    )
    assert throttled.status_code == 429
    assert throttled.json()["reason"] == "rate-limited"

    # The bucket is per connector: a different one is unaffected.
    other = client.post(
        "/v1/request",
        json={"kind": "rest", "url": "https://api.example.com/x"},
        headers={**auth(), "x-connector": "other"},
    )
    assert other.status_code == 200


# ---------------------------------------------------------------------------
# Task watcher
# ---------------------------------------------------------------------------


def test_watcher_route_crud(client: TestClient) -> None:
    missing = client.get("/v1/watch/demo", headers=auth())
    assert missing.status_code == 200
    assert missing.json()["data"]["watcher"] is None

    created = client.put(
        "/v1/watch/demo",
        json={"everyMinutes": 15, "callbackUrl": "http://127.0.0.1:3080/sync", "instance": "box-a"},
        headers=auth(),
    )
    assert created.status_code == 200
    watcher = created.json()["data"]["watcher"]
    assert watcher["everyMinutes"] == 15
    assert watcher["enabled"] is True
    assert watcher["nextRunAt"] is not None

    fetched = client.get("/v1/watch/demo", headers=auth()).json()["data"]["watcher"]
    assert fetched["callbackUrl"] == "http://127.0.0.1:3080/sync"

    deleted = client.delete("/v1/watch/demo", headers=auth())
    assert deleted.json()["data"]["deleted"] is True
    assert client.delete("/v1/watch/demo", headers=auth()).json()["data"]["deleted"] is False


def test_watcher_subscription_alias_route(client: TestClient) -> None:
    """DESIGN-v2 §3.4 names the path with a /subscription suffix; both work."""

    response = client.put(
        "/v1/watch/demo/subscription",
        json={"everyMinutes": 20, "callbackUrl": "http://127.0.0.1:3080/sync", "instance": "box-a"},
        headers=auth(),
    )
    assert response.status_code == 200
    assert response.json()["data"]["watcher"]["everyMinutes"] == 20

    # The alias writes the same row the canonical path reads.
    fetched = client.get("/v1/watch/demo", headers=auth()).json()["data"]["watcher"]
    assert fetched["instance"] == "box-a"


def test_watcher_validation(client: TestClient) -> None:
    too_fast = client.put(
        "/v1/watch/demo",
        json={"everyMinutes": 0, "callbackUrl": "http://127.0.0.1:3080/sync"},
        headers=auth(),
    )
    assert too_fast.status_code == 422

    bad_url = client.put(
        "/v1/watch/demo",
        json={"everyMinutes": 10, "callbackUrl": "file:///etc/passwd"},
        headers=auth(),
    )
    assert bad_url.status_code == 422

    assert clamp_every_minutes(1440) == 1440
    with pytest.raises(Exception):
        clamp_every_minutes(0)
    with pytest.raises(Exception):
        validate_callback_url("javascript:alert(1)")


def test_watcher_tick_dispatches_when_due(tmp_path: Path) -> None:
    store = Store(tmp_path)
    store.put_watcher("demo", 15, "http://127.0.0.1:3080/sync", "box-a", "2020-01-01T00:00:00+00:00")

    calls: list[tuple[str, str]] = []

    def dispatch(connector: str, url: str) -> tuple[bool, str]:
        calls.append((connector, url))
        return True, ""

    service = WatcherService(store, token="tok", dispatch=dispatch)
    outcomes = service.tick(inline=True)

    assert outcomes == [{"connector": "demo", "action": "dispatched", "reason": "dispatched"}]
    assert calls == [("demo", "http://127.0.0.1:3080/sync")]

    # The lease is held by the pseudo-instance so a concurrent instance can't
    # start the same sync.
    with pytest.raises(LeaseHeld):
        store.acquire_lease("demo", "box-b", 60)

    runs = store.list_runs("demo", 10)
    assert runs[0]["run"]["kind"] == "watcher-dispatch"
    assert runs[0]["run"]["via"] == "watcher"

    # next_run_at moved forward, so an immediate second tick is a no-op.
    assert service.tick(inline=True) == []
    watcher = store.get_watcher("demo")
    assert watcher["nextRunAt"] > "2020-01-01T00:00:00+00:00"


def test_watcher_tick_skips_when_lease_held(tmp_path: Path) -> None:
    store = Store(tmp_path)
    store.put_watcher("demo", 15, "http://127.0.0.1:3080/sync", "box-a", "2020-01-01T00:00:00+00:00")
    store.acquire_lease("demo", "box-b", 600)

    service = WatcherService(store, dispatch=lambda c, u: pytest.fail("must not dispatch"))
    outcomes = service.tick(inline=True)

    assert outcomes[0]["action"] == "skipped"
    assert outcomes[0]["reason"] == "lease-held"
    record = store.list_runs("demo", 5)[0]["run"]
    assert record["kind"] == "watcher-skip"
    assert record["holder"] == "box-b"

    # A skipped tick still reschedules, or the watcher would go silent forever.
    assert store.get_watcher("demo")["nextRunAt"] > "2020-01-01T00:00:00+00:00"


def test_watcher_tick_records_dispatch_failure(tmp_path: Path) -> None:
    store = Store(tmp_path)
    store.put_watcher("demo", 10, "http://127.0.0.1:3080/sync", "box-a", "2020-01-01T00:00:00+00:00")
    service = WatcherService(store, dispatch=lambda c, u: (False, "connection refused"))
    outcomes = service.tick(inline=True)

    assert outcomes[0]["action"] == "skipped"
    assert outcomes[0]["reason"] == "dispatch-failed"
    record = store.list_runs("demo", 5)[0]["run"]
    assert record["kind"] == "watcher-skip"
    assert "connection refused" in record["detail"]


def test_watcher_ignores_disabled_and_future_entries(tmp_path: Path) -> None:
    store = Store(tmp_path)
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    store.put_watcher("later", 15, "http://127.0.0.1:1/sync", "box-a", future)
    store.put_watcher("done", 15, "http://127.0.0.1:1/sync", "box-a", "2020-01-01T00:00:00+00:00")
    store.delete_watcher("done")

    service = WatcherService(store, dispatch=lambda c, u: pytest.fail("must not dispatch"))
    assert service.tick(inline=True) == []


def test_watcher_thread_starts_and_stops(tmp_path: Path) -> None:
    store = Store(tmp_path)
    service = WatcherService(store, scan_interval=0.05, dispatch=lambda c, u: (True, ""))
    service.start()
    assert service.running is True
    service.stop()
    assert service.running is False


def test_watcher_callback_ignores_ambient_proxy_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A stray ALL_PROXY in the hub's shell must not hijack a loopback callback.

    Regression: httpx honours ``ALL_PROXY`` by default, so on a developer box a
    callback to 127.0.0.1 was routed into a SOCKS proxy and failed.
    """

    captured: dict = {}

    class FakeResponse:
        status_code = 200

    class FakeClient:
        def __init__(self, **kwargs):
            captured["trust_env"] = kwargs.get("trust_env")

        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def post(self, url, json=None, headers=None):
            captured["url"] = url
            captured["token"] = headers.get("x-hub-token")
            return FakeResponse()

    monkeypatch.setenv("ALL_PROXY", "socks5h://127.0.0.1:7890")
    monkeypatch.setattr(httpx, "Client", FakeClient)

    store = Store(tmp_path)
    service = WatcherService(store, token="tok")
    ok, detail = service._http_dispatch("demo", "http://127.0.0.1:9/sync")

    assert ok is True and detail == ""
    assert captured["trust_env"] is False
    assert captured["token"] == "tok"


def test_proxy_client_ignores_ambient_proxy_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captured: dict = {}

    class FakeClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def close(self):
            pass

    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7890")
    monkeypatch.setattr(httpx, "Client", FakeClient)

    proxy = RequestProxy(Store(tmp_path), tmp_path)
    proxy._get_client()
    assert captured["trust_env"] is False


# ---------------------------------------------------------------------------
# Version / health
# ---------------------------------------------------------------------------


def test_health_reports_v2(client: TestClient) -> None:
    data = client.get("/health").json()["data"]
    assert data["version"] == "0.2.0"
