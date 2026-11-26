"""Outbound HTTP proxy for connector ``rest`` executors.

Two reasons this lives in the hub rather than in each connector process:

* Credentials stay on the hub.  A connector YAML can say
  ``${secret:TODOIST}`` instead of carrying a token, so the shared document
  never contains a live secret.
* Egress is centralised, which makes it possible to enforce one SSRF policy and
  one rate limit for every instance.

Everything the proxy does is audited into ``runs`` (``kind: "proxy-request"``);
header values are never recorded, because that is where the substituted
secrets end up.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import socket
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlsplit, urlunsplit

from hub.store import Store

logger = logging.getLogger("hub.request")

# Matches the client-side ceiling in lib/hub.js so neither side can be tricked
# into buffering an unbounded response.
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_REQUEST_TIMEOUT_MS = 120_000
MIN_REQUEST_TIMEOUT_MS = 1_000
DEFAULT_REQUEST_TIMEOUT_MS = 20_000
RATE_LIMIT_PER_MINUTE = 60
RATE_LIMIT_WINDOW_SECONDS = 60.0

ALLOWED_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")

SECRET_PATTERN = re.compile(r"\$\{secret:([A-Za-z0-9_.\-]+)\}")
SECRET_FILENAME = "secrets.json"


class ProxyError(Exception):
    """Base class for proxy failures; subclasses carry the envelope reason."""

    status = 400
    reason = "request-error"

    def __init__(self, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.extra = extra


class BlockedTarget(ProxyError):
    status = 403
    reason = "blocked-target"


class InvalidRequest(ProxyError):
    status = 422
    reason = "invalid-request"


class RateLimited(ProxyError):
    status = 429
    reason = "rate-limited"


class ResponseTooLarge(ProxyError):
    status = 502
    reason = "response-too-large"


class UpstreamError(ProxyError):
    status = 502
    reason = "upstream-error"


# ---------------------------------------------------------------------------
# SSRF guard
# ---------------------------------------------------------------------------


def _is_public(address: str) -> bool:
    """True only for addresses that are safe to dial from the hub.

    ``is_global`` alone rejects private, loopback, link-local and reserved
    ranges; multicast is checked separately because Python still reports some
    multicast blocks as global.
    """

    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return bool(ip.is_global and not ip.is_multicast)


def validate_target(url: str) -> tuple[str, str, int]:
    """Validate an outbound URL and return ``(scheme, host, port)``.

    The host is resolved *here* and every returned address is checked, so a
    name that points at a private IP (or the decimal-IP shorthand for
    127.0.0.1) is rejected just like a literal one.  A DNS-rebinding attacker
    could still answer differently for the connection that follows; that gap is
    accepted because the alternative — pinning the resolved IP in the request —
    breaks TLS verification for normal hosts.
    """

    if not isinstance(url, str) or not url.strip():
        raise InvalidRequest("url 不能为空")
    try:
        parts = urlsplit(url.strip())
    except ValueError as error:
        raise InvalidRequest(f"url 不合法：{error}") from error

    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise InvalidRequest(f"只支持 http/https，收到 {scheme or '(空)'}")

    host = parts.hostname
    if not host:
        raise InvalidRequest("url 缺少主机名")
    port = parts.port or (443 if scheme == "https" else 80)

    # Bare-IP literal fast path; a name goes through the resolver below.
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if not _is_public(str(literal)):
            raise BlockedTarget(f"拒绝访问非公网地址 {host}")
        return scheme, host, port

    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise UpstreamError(f"无法解析主机 {host}：{error}") from error

    addresses = sorted({info[4][0] for info in infos})
    if not addresses:
        raise UpstreamError(f"主机 {host} 没有可用地址")
    for address in addresses:
        if not _is_public(address):
            raise BlockedTarget(f"拒绝访问非公网地址 {host} -> {address}")
    return scheme, host, port


# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------


class SecretStore:
    """Read ``secrets.json`` from the hub data directory.

    The file is re-read on every call on purpose: rotating a token should not
    require restarting the hub, and the file is tiny.
    """

    def __init__(self, data_dir: str | os.PathLike[str]) -> None:
        self.path = Path(data_dir).expanduser() / SECRET_FILENAME
        self._warned_mode = False

    def load(self) -> dict[str, str]:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError as error:
            logger.warning("读取 %s 失败：%s", self.path, error)
            return {}

        self._check_mode()
        try:
            parsed = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError as error:
            logger.warning("%s 不是合法 JSON：%s", self.path, error)
            return {}
        if not isinstance(parsed, dict):
            logger.warning("%s 顶层必须是对象", self.path)
            return {}
        return {str(key): str(value) for key, value in parsed.items()}

    def _check_mode(self) -> None:
        if self._warned_mode:
            return
        try:
            mode = self.path.stat().st_mode & 0o777
        except OSError:
            return
        if mode & 0o077:
            self._warned_mode = True
            logger.warning(
                "%s 权限是 %o，建议 chmod 600：里面的值是明文凭据", self.path, mode
            )

    def resolve(self, headers: dict[str, str]) -> tuple[dict[str, str], list[str]]:
        """Substitute ``${secret:ALIAS}`` in header values.

        Returns the new headers plus the aliases that were referenced but not
        found.  A missing alias becomes an empty string rather than a hard
        failure: a broken credential should show up as an upstream 401 in the
        run log, not as an unexplained hub error.
        """

        secrets = self.load()
        warnings: list[str] = []

        def replace(text: str) -> str:
            def one(match: re.Match[str]) -> str:
                alias = match.group(1)
                if alias not in secrets:
                    warnings.append(f"secret alias {alias!r} 未配置")
                    return ""
                return secrets[alias]

            return SECRET_PATTERN.sub(one, text)

        return {key: replace(value) for key, value in headers.items()}, warnings


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


class RateLimiter:
    """Sliding-window limiter, one bucket per connector name."""

    def __init__(
        self,
        limit: int = RATE_LIMIT_PER_MINUTE,
        window_seconds: float = RATE_LIMIT_WINDOW_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.limit = limit
        self.window = window_seconds
        self._clock = clock
        self._buckets: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> None:
        now = self._clock()
        with self._lock:
            bucket = self._buckets.setdefault(key, deque())
            cutoff = now - self.window
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= self.limit:
                retry_after = max(0.0, self.window - (now - bucket[0]))
                raise RateLimited(
                    f"连接器 {key or '(未知)'} 每分钟最多 {self.limit} 次代理请求，请 {int(retry_after) + 1}s 后重试"
                )
            bucket.append(now)


# ---------------------------------------------------------------------------
# The proxy
# ---------------------------------------------------------------------------


class RequestProxy:
    """Execute one outbound request and audit it into the run log."""

    def __init__(
        self,
        store: Store,
        data_dir: str | os.PathLike[str],
        client: Any = None,
        secrets: Optional[SecretStore] = None,
        limiter: Optional[RateLimiter] = None,
        resolver: Callable[[str], tuple[str, str, int]] = validate_target,
    ) -> None:
        self.store = store
        self.data_dir = Path(data_dir).expanduser()
        self.secrets = secrets or SecretStore(self.data_dir)
        self.limiter = limiter or RateLimiter()
        self._resolver = resolver
        self._client = client
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client and self._client is not None:
            self._client.close()
            self._client = None

    def _get_client(self):
        if self._client is None:
            import httpx

            # trust_env=False on purpose: the hub must not inherit the shell's
            # HTTP(S)_PROXY / ALL_PROXY.  A stray ``ALL_PROXY=socks5h://...``
            # would otherwise route an outbound call through an unrelated
            # local proxy (or fail outright when socksio is absent), and the
            # SSRF check would validate a host we never actually connect to.
            self._client = httpx.Client(follow_redirects=False, trust_env=False)
        return self._client

    # -- public entry point -------------------------------------------------

    def send(self, connector: str, payload: dict[str, Any]) -> dict[str, Any]:
        connector = (connector or "").strip()
        started = time.monotonic()
        status: Optional[int] = None
        error_reason: Optional[str] = None
        ok = False
        body: Any = None

        try:
            url = payload.get("url")
            method = str(payload.get("method") or "GET").upper()
            if method not in ALLOWED_METHODS:
                raise InvalidRequest(f"不支持的 method {method!r}")

            self.limiter.check(connector)
            self._resolver(str(url or ""))

            headers = payload.get("headers") or {}
            if not isinstance(headers, dict):
                raise InvalidRequest("headers 必须是对象")
            clean_headers: dict[str, str] = {}
            for key, value in headers.items():
                if not isinstance(key, str) or not isinstance(value, (str, int, float)):
                    raise InvalidRequest("headers 的键必须是字符串、值必须是标量")
                clean_headers[key] = str(value)
            clean_headers, warnings = self.secrets.resolve(clean_headers)

            timeout_ms = _clamp_timeout(payload.get("timeoutMs"))
            content, json_body = _encode_body(payload.get("body"), clean_headers)
            success_codes = payload.get("success")
            if success_codes is not None and not isinstance(success_codes, list):
                raise InvalidRequest("success 必须是状态码数组")

            status, body = self._execute(
                url=str(url),
                method=method,
                headers=clean_headers,
                content=content,
                json_body=json_body,
                timeout_seconds=timeout_ms / 1000.0,
            )
            ok = _is_success(status, success_codes)
            if warnings:
                # Surfaced in the audit record only; the response body must stay
                # the upstream's own payload.
                error_reason = "secret-missing" if not ok else None
        except ProxyError as error:
            error_reason = error.reason
            self._audit(
                connector=connector,
                url=str(payload.get("url") or ""),
                method=str(payload.get("method") or "GET").upper(),
                status=None,
                duration_ms=_elapsed_ms(started),
                ok=False,
                error=error.reason,
                detail=str(error),
            )
            raise
        except Exception as error:  # noqa: BLE001 - audited then re-raised as 502
            logger.exception("proxy request failed")
            self._audit(
                connector=connector,
                url=str(payload.get("url") or ""),
                method=str(payload.get("method") or "GET").upper(),
                status=None,
                duration_ms=_elapsed_ms(started),
                ok=False,
                error="internal",
                detail=str(error),
            )
            raise UpstreamError(f"代理请求失败：{error}") from error

        duration_ms = _elapsed_ms(started)
        self._audit(
            connector=connector,
            url=str(payload.get("url") or ""),
            method=str(payload.get("method") or "GET").upper(),
            status=status,
            duration_ms=duration_ms,
            ok=ok,
            error=error_reason,
            detail=None,
        )
        return {"status": status, "body": body, "durationMs": duration_ms}

    # -- transport ----------------------------------------------------------

    def _execute(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        content: Optional[bytes],
        json_body: Any,
        timeout_seconds: float,
    ) -> tuple[int, Any]:
        import httpx

        client = self._get_client()
        kwargs: dict[str, Any] = {"headers": headers, "timeout": timeout_seconds}
        if json_body is not None:
            kwargs["json"] = json_body
        elif content is not None:
            kwargs["content"] = content

        try:
            with client.stream(method, url, **kwargs) as response:
                status = response.status_code
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > MAX_RESPONSE_BYTES:
                        raise ResponseTooLarge(
                            f"响应体超过 {MAX_RESPONSE_BYTES // (1024 * 1024)} MiB 上限"
                        )
                    chunks.append(chunk)
                raw = b"".join(chunks)
                charset = response.charset_encoding or "utf-8"
        except httpx.TimeoutException as error:
            raise UpstreamError(f"上游超时：{error}") from error
        except httpx.HTTPError as error:
            raise UpstreamError(f"上游请求失败：{error}") from error

        try:
            text = raw.decode(charset, errors="replace")
        except LookupError:
            text = raw.decode("utf-8", errors="replace")
        try:
            return status, json.loads(text) if text.strip() else None
        except json.JSONDecodeError:
            return status, text

    # -- audit --------------------------------------------------------------

    def _audit(
        self,
        connector: str,
        url: str,
        method: str,
        status: Optional[int],
        duration_ms: int,
        ok: bool,
        error: Optional[str],
        detail: Optional[str],
    ) -> None:
        record: dict[str, Any] = {
            "kind": "proxy-request",
            "via": "hub",
            "url": _redact_url(url),
            "method": method,
            "status": status,
            "durationMs": duration_ms,
            "ok": ok,
            "at": _utc_now(),
        }
        if error:
            record["error"] = error
        if detail:
            record["detail"] = detail[:500]
        try:
            self.store.add_run(connector, record)
        except Exception:  # noqa: BLE001 - auditing must not mask the real error
            logger.exception("写入 proxy run 记录失败")


def _clamp_timeout(value: Any) -> int:
    if value is None:
        return DEFAULT_REQUEST_TIMEOUT_MS
    try:
        timeout = int(value)
    except (TypeError, ValueError) as error:
        raise InvalidRequest("timeoutMs 必须是整数") from error
    return max(MIN_REQUEST_TIMEOUT_MS, min(MAX_REQUEST_TIMEOUT_MS, timeout))


def _encode_body(body: Any, headers: dict[str, str]) -> tuple[Optional[bytes], Any]:
    """Return either raw bytes or a JSON payload, never both."""

    if body is None:
        return None, None
    if isinstance(body, (dict, list, int, float, bool)):
        return None, body
    if isinstance(body, str):
        if _looks_like_json(headers):
            try:
                return None, json.loads(body)
            except json.JSONDecodeError:
                pass
        return body.encode("utf-8"), None
    raise InvalidRequest("body 必须是对象、数组、字符串或数字")


def _looks_like_json(headers: dict[str, str]) -> bool:
    for key, value in headers.items():
        if key.lower() == "content-type" and "json" in value.lower():
            return True
    return False


def _is_success(status: int, success_codes: Optional[list[Any]]) -> bool:
    if success_codes:
        try:
            return status in [int(code) for code in success_codes]
        except (TypeError, ValueError):
            return 200 <= status < 300
    return 200 <= status < 300


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _redact_url(url: str) -> str:
    """Drop the query string before the URL lands in the run log.

    Query strings routinely carry API tokens (``?access_token=...``) and the
    run log is readable by every instance, so only scheme/host/path survive.
    """

    try:
        parts = urlsplit(url)
    except ValueError:
        return url[:200]
    if not parts.scheme or not parts.netloc:
        return url[:200]
    clean = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    return clean[:200]
