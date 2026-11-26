"""Hub-side scheduler ("task-watcher").

v1 schedules syncs inside each connector process, so N instances sharing one
connector means N timers firing at roughly the same moment.  The watcher moves
that timer into the hub: the hub itself holds no sync logic, it only decides
*when* to poke an instance and which instance gets to run, reusing the v1 lease
so the "one writer per connector" rule still holds network-wide.

The loop is deliberately dumb: every ``SCAN_INTERVAL_SECONDS`` it asks the
store for due watchers, tries the lease, and fires one HTTP callback.  No retry
on purpose — the next tick is the retry, and a callback that keeps failing is
visible in the run log instead of being hammered.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

from hub.store import MAX_LEASE_TTL, LeaseHeld, Store

logger = logging.getLogger("hub.watcher")

SCAN_INTERVAL_SECONDS = 30.0
CALLBACK_TIMEOUT_SECONDS = 120.0
MIN_EVERY_MINUTES = 1
MAX_EVERY_MINUTES = 24 * 60
WATCHER_INSTANCE = "watcher"


class WatcherError(Exception):
    status = 422
    reason = "invalid-watch"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat()


def clamp_every_minutes(value: Any) -> int:
    try:
        minutes = int(value)
    except (TypeError, ValueError) as error:
        raise WatcherError("everyMinutes 必须是整数") from error
    if minutes < MIN_EVERY_MINUTES or minutes > MAX_EVERY_MINUTES:
        raise WatcherError(
            f"everyMinutes 必须在 {MIN_EVERY_MINUTES}-{MAX_EVERY_MINUTES} 之间"
        )
    return minutes


def validate_callback_url(value: Any) -> str:
    """Accept only http(s) URLs; the target is an instance on this network.

    The public-only SSRF rule used by the request proxy must NOT apply here:
    instances are expected to live on loopback or a LAN address.
    """

    if not isinstance(value, str) or not value.strip():
        raise WatcherError("callbackUrl 不能为空")
    try:
        parts = urlsplit(value.strip())
    except ValueError as error:
        raise WatcherError(f"callbackUrl 不合法：{error}") from error
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise WatcherError("callbackUrl 必须是完整的 http(s) 地址")
    return value.strip()


class WatcherService:
    """Owns the scan thread and the per-tick decision logic."""

    def __init__(
        self,
        store: Store,
        token: str = "",
        dispatch: Optional[Callable[[str, str], tuple[bool, str]]] = None,
        scan_interval: float = SCAN_INTERVAL_SECONDS,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self.store = store
        self.token = token or ""
        self.scan_interval = scan_interval
        self._clock = clock
        self._dispatch = dispatch or self._http_dispatch
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        # daemon=True so a hung callback never keeps the process alive.
        self._thread = threading.Thread(target=self._loop, name="hub-watcher", daemon=True)
        self._thread.start()
        logger.info("watcher thread started (scan every %ss)", self.scan_interval)

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        self._thread = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _loop(self) -> None:
        while not self._stop.wait(self.scan_interval):
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the loop must survive one bad row
                logger.exception("watcher tick failed")

    # -- one scan -----------------------------------------------------------

    def tick(self, inline: bool = False) -> list[dict[str, Any]]:
        """Process every due watcher once.

        ``inline`` exists for tests and for the CLI's one-shot mode: the
        callback is executed on the calling thread instead of in a helper
        thread, which makes the resulting run records deterministic.
        """

        now = self._clock()
        outcomes: list[dict[str, Any]] = []
        for watcher in self.store.due_watchers(_iso(now)):
            outcomes.append(self._handle(watcher, now, inline=inline))
        return outcomes

    def _handle(self, watcher: dict[str, Any], now: datetime, inline: bool) -> dict[str, Any]:
        connector = watcher["connector"]
        every = max(MIN_EVERY_MINUTES, int(watcher["everyMinutes"]))
        next_run = _iso(now + timedelta(minutes=every))

        ttl = min(every * 60, MAX_LEASE_TTL)
        try:
            lease = self.store.acquire_lease(connector, WATCHER_INSTANCE, ttl)
        except LeaseHeld as held:
            # Another instance is mid-sync: this tick is a no-op, but the next
            # one must still be scheduled or the watcher would go silent.
            self.store.set_watcher_next_run(connector, next_run)
            self._record(
                connector,
                "watcher-skip",
                {
                    "reason": "lease-held",
                    "holder": held.holder.get("instance"),
                    "expiresAt": held.holder.get("expiresAt"),
                },
            )
            return {"connector": connector, "action": "skipped", "reason": "lease-held"}

        self.store.set_watcher_next_run(connector, next_run)

        if inline:
            return self._fire(connector, watcher["callbackUrl"], lease, dispatch_now=True)
        threading.Thread(
            target=self._fire,
            args=(connector, watcher["callbackUrl"], lease, True),
            name=f"hub-watch-{connector}",
            daemon=True,
        ).start()
        return {"connector": connector, "action": "dispatched", "inline": False}

    def _fire(
        self,
        connector: str,
        callback_url: str,
        lease: dict[str, Any],
        dispatch_now: bool,
    ) -> dict[str, Any]:
        started = time.monotonic()
        try:
            ok, detail = self._dispatch(connector, callback_url)
        except Exception as error:  # noqa: BLE001 - recorded, never raised
            ok, detail = False, str(error)
        elapsed = int((time.monotonic() - started) * 1000)

        if ok:
            payload = {
                "reason": "dispatched",
                "url": _redact(callback_url),
                "durationMs": elapsed,
                "leaseId": lease.get("leaseId"),
            }
            kind = "watcher-dispatch"
        else:
            payload = {
                "reason": "dispatch-failed",
                "url": _redact(callback_url),
                "durationMs": elapsed,
                "detail": (detail or "")[:500],
            }
            kind = "watcher-skip"
        self._record(connector, kind, payload)
        return {
            "connector": connector,
            "action": "dispatched" if ok else "skipped",
            "reason": payload["reason"],
        }

    def _record(self, connector: str, kind: str, payload: dict[str, Any]) -> None:
        record = {"kind": kind, "via": "watcher", "at": _iso(self._clock()), **payload}
        try:
            self.store.add_run(connector, record)
        except Exception:  # noqa: BLE001 - a failed audit must not kill the tick
            logger.exception("写入 watcher run 记录失败")

    # -- transport ----------------------------------------------------------

    def _http_dispatch(self, connector: str, callback_url: str) -> tuple[bool, str]:
        import httpx

        headers = {"content-type": "application/json"}
        if self.token:
            # Instances validate the same header they accept from clients, so
            # a public hub cannot be tricked into poking arbitrary endpoints by
            # a non-token holder... and a compromised hub can still only reach
            # instances that already trust its token.
            headers["x-hub-token"] = self.token
        body = {"connector": connector, "trigger": "watcher", "at": _iso(self._clock())}
        try:
            # trust_env=False: callbacks point at instances on loopback/LAN, so
            # inheriting the hub host's HTTP(S)_PROXY/ALL_PROXY would both break
            # local delivery and leak the token to an unrelated proxy.
            with httpx.Client(
                timeout=CALLBACK_TIMEOUT_SECONDS,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                response = client.post(callback_url, json=body, headers=headers)
        except httpx.HTTPError as error:
            return False, f"{type(error).__name__}: {error}"
        if response.status_code >= 400:
            return False, f"callback returned HTTP {response.status_code}"
        return True, ""


def _redact(url: str) -> str:
    try:
        parts = urlsplit(url)
    except ValueError:
        return url[:200]
    if not parts.scheme or not parts.netloc:
        return url[:200]
    return f"{parts.scheme}://{parts.netloc}{parts.path}"[:200]
