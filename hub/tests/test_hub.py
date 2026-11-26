"""End-to-end tests for the optional local Connector Hub.

These tests use ``fastapi.testclient.TestClient`` against a fresh app whose
database lives in a pytest ``tmp_path``, so nothing touches the real ``./data``
directory.  The only non-public touch point is a direct sqlite UPDATE used to
age a lease into the past; waiting 15 real seconds to test lease expiry would
make the suite unusably slow.
"""

from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Ensure the repository root is importable when pytest is invoked from anywhere.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from hub.app import create_app  # noqa: E402
from hub.store import content_hash  # noqa: E402

TOKEN = "test-token-0123456789"


class ClientHost:
    """ASGI wrapper that pins ``request.client`` to a chosen address.

    Starlette's TestClient always reports ``("testclient", 50000)``; the auth
    policy cares about real addresses, so the wrapper rewrites the scope.  This
    keeps production code free of any test-only loopback bypass.
    """

    def __init__(self, app, host: str = "127.0.0.1") -> None:
        self.app = app
        self.host = host

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            scope = dict(scope)
            scope["client"] = (self.host, 50000)
        await self.app(scope, receive, send)


def make_client(tmp_path: Path, token: str | None = None, host: str = "127.0.0.1") -> TestClient:
    app = create_app(data_dir=tmp_path, token=token or "")
    return TestClient(ClientHost(app, host=host))


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return make_client(tmp_path, token=TOKEN)


@pytest.fixture()
def token_client(tmp_path: Path) -> TestClient:
    return make_client(tmp_path, token=TOKEN)


def auth() -> dict[str, str]:
    return {"X-Hub-Token": TOKEN}


# ---------------------------------------------------------------------------
# Health & envelopes
# ---------------------------------------------------------------------------


def test_health_is_public_and_reports_counts(tmp_path: Path) -> None:
    # Even with a token configured, /health must stay usable without one.
    client = make_client(tmp_path, token=TOKEN, host="10.9.9.9")
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    data = body["data"]
    assert data["name"] == "dsh-global-todo-connector-hub"
    assert data["version"] == "0.2.0"
    assert isinstance(data["uptimeSeconds"], int)
    assert data["connectors"] == 0
    assert data["activeLeases"] == 0
    assert data["now"].endswith("+00:00")


def test_unknown_route_uses_error_envelope(client: TestClient) -> None:
    response = client.get("/v1/nope", headers=auth())
    assert response.status_code == 404
    body = response.json()
    assert body["ok"] is False
    assert body["reason"] == "not-found"
    assert "error" in body


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------


def test_token_mode_rejects_missing_and_wrong_token(tmp_path: Path) -> None:
    client = make_client(tmp_path, token=TOKEN)
    missing = client.get("/v1/connectors")
    assert missing.status_code == 401
    assert missing.json() == {
        "ok": False,
        "reason": "unauthorized",
        "error": "X-Hub-Token 缺失或不正确",
    }

    wrong = client.get("/v1/connectors", headers={"X-Hub-Token": TOKEN + "x"})
    assert wrong.status_code == 401
    assert wrong.json()["reason"] == "unauthorized"


def test_token_mode_accepts_token_even_from_remote_address(tmp_path: Path) -> None:
    # Token is the stronger credential; a remote address must not block it.
    client = make_client(tmp_path, token=TOKEN, host="10.1.2.3")
    response = client.get("/v1/connectors", headers=auth())
    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"connectors": []}}


def test_loopback_mode_allows_local_clients(tmp_path: Path) -> None:
    for host in ("127.0.0.1", "127.4.5.6", "::1", "::ffff:127.0.0.1"):
        client = make_client(tmp_path, token="", host=host)
        response = client.get("/v1/connectors")
        assert response.status_code == 200, host


def test_loopback_mode_forbids_remote_clients(tmp_path: Path) -> None:
    client = make_client(tmp_path, token="", host="10.0.0.7")
    response = client.get("/v1/connectors")
    assert response.status_code == 403
    body = response.json()
    assert body["ok"] is False
    assert body["reason"] == "forbidden"
    assert "只接受本机请求" in body["error"]


# ---------------------------------------------------------------------------
# Connector CRUD and revisions
# ---------------------------------------------------------------------------


def test_connector_crud_roundtrip(client: TestClient) -> None:
    yaml_text = "name: demo\nschedule: '*/5 * * * *'\n"
    created = client.put("/v1/connectors/demo", json={"yaml": yaml_text, "owner": "laptop"}, headers=auth())
    assert created.status_code == 200
    created_data = created.json()["data"]
    assert created_data["name"] == "demo"
    assert created_data["revision"] == 1
    assert created_data["hash"] == content_hash(yaml_text)
    assert len(created_data["hash"]) == 16
    assert created_data["updatedAt"].endswith("+00:00")

    fetched = client.get("/v1/connectors/demo", headers=auth())
    assert fetched.status_code == 200
    fetched_data = fetched.json()["data"]
    assert fetched_data["yaml"] == yaml_text
    assert fetched_data["owner"] == "laptop"
    assert fetched_data["revision"] == 1

    listed = client.get("/v1/connectors", headers=auth()).json()["data"]["connectors"]
    assert len(listed) == 1
    assert set(listed[0]) == {"name", "revision", "hash", "owner", "updatedAt"}
    assert "yaml" not in listed[0]


def test_connector_put_without_revision_forces_overwrite(client: TestClient) -> None:
    client.put("/v1/connectors/demo", json={"yaml": "a: 1\n"}, headers=auth())
    forced = client.put("/v1/connectors/demo", json={"yaml": "a: 2\n"}, headers=auth())
    assert forced.status_code == 200
    assert forced.json()["data"]["revision"] == 2


def test_connector_revision_conflict_returns_409(client: TestClient) -> None:
    client.put(
        "/v1/connectors/demo",
        json={"yaml": "a: 1\n", "revision": 0},
        headers=auth(),
    )
    stale = client.put(
        "/v1/connectors/demo",
        json={"yaml": "a: 2\n", "revision": 0},
        headers=auth(),
    )
    assert stale.status_code == 409
    body = stale.json()
    assert body["ok"] is False
    assert body["reason"] == "revision-conflict"
    assert body["error"]

    current = client.put(
        "/v1/connectors/demo",
        json={"yaml": "a: 3\n", "revision": 1},
        headers=auth(),
    )
    assert current.status_code == 200
    assert current.json()["data"]["revision"] == 2


def test_connector_missing_and_validation(client: TestClient) -> None:
    missing = client.get("/v1/connectors/ghost", headers=auth())
    assert missing.status_code == 404
    assert missing.json()["reason"] == "not-found"

    blank = client.put("/v1/connectors/demo", json={"yaml": "   "}, headers=auth())
    assert blank.status_code == 422
    assert blank.json()["reason"] == "invalid-yaml"

    oversized = client.put(
        "/v1/connectors/big",
        json={"yaml": "x" * (1024 * 1024 + 1)},
        headers=auth(),
    )
    assert oversized.status_code == 413
    assert oversized.json()["reason"] == "payload-too-large"


def test_connector_delete_with_revision_guard(client: TestClient) -> None:
    client.put("/v1/connectors/demo", json={"yaml": "a: 1\n"}, headers=auth())
    conflict = client.delete("/v1/connectors/demo?revision=9", headers=auth())
    assert conflict.status_code == 409
    assert conflict.json()["reason"] == "revision-conflict"

    deleted = client.delete("/v1/connectors/demo?revision=1", headers=auth())
    assert deleted.status_code == 200
    assert deleted.json() == {"ok": True, "data": {"deleted": True}}

    again = client.delete("/v1/connectors/demo", headers=auth())
    assert again.status_code == 404
    assert again.json()["reason"] == "not-found"


# ---------------------------------------------------------------------------
# Leases
# ---------------------------------------------------------------------------


def test_lease_lifecycle_and_exclusivity(client: TestClient) -> None:
    acquired = client.post(
        "/v1/leases",
        json={"connector": "demo", "instance": "laptop", "ttlSeconds": 60},
        headers=auth(),
    )
    assert acquired.status_code == 201
    lease = acquired.json()["data"]
    assert lease["connector"] == "demo"
    assert lease["instance"] == "laptop"
    assert lease["expiresAt"].endswith("+00:00")

    # Same instance: idempotent reuse, same lease id.
    again = client.post(
        "/v1/leases",
        json={"connector": "demo", "instance": "laptop", "ttlSeconds": 90},
        headers=auth(),
    )
    assert again.status_code == 201
    assert again.json()["data"]["leaseId"] == lease["leaseId"]

    # Other instance: blocked with holder details.
    blocked = client.post(
        "/v1/leases",
        json={"connector": "demo", "instance": "desktop"},
        headers=auth(),
    )
    assert blocked.status_code == 409
    body = blocked.json()
    assert body["reason"] == "lease-held"
    assert body["holder"]["instance"] == "laptop"
    assert body["holder"]["leaseId"] == lease["leaseId"]

    renewed = client.post(
        f"/v1/leases/{lease['leaseId']}/renew",
        json={"ttlSeconds": 120},
        headers=auth(),
    )
    assert renewed.status_code == 200
    assert renewed.json()["data"]["leaseId"] == lease["leaseId"]

    released = client.delete(f"/v1/leases/{lease['leaseId']}", headers=auth())
    assert released.status_code == 200
    assert released.json()["data"] == {"released": True}

    # Release is idempotent.
    released_again = client.delete(f"/v1/leases/{lease['leaseId']}", headers=auth())
    assert released_again.status_code == 200
    assert released_again.json()["data"] == {"released": False}

    # Renewing a released lease is a 404 with the documented reason.
    missing = client.post(f"/v1/leases/{lease['leaseId']}/renew", json={}, headers=auth())
    assert missing.status_code == 404
    assert missing.json()["reason"] == "lease-missing"


def test_expired_lease_can_be_taken_over(tmp_path: Path, client: TestClient) -> None:
    acquired = client.post(
        "/v1/leases",
        json={"connector": "demo", "instance": "laptop"},
        headers=auth(),
    ).json()["data"]

    # Age the lease directly; 15s is the contract minimum, far too slow to wait.
    db = sqlite3.connect(tmp_path / "hub.db")
    try:
        db.execute(
            "UPDATE leases SET expires_at_epoch = ?, expires_at = ? WHERE lease_id = ?",
            (time.time() - 5, "2000-01-01T00:00:00+00:00", acquired["leaseId"]),
        )
        db.commit()
    finally:
        db.close()

    taken = client.post(
        "/v1/leases",
        json={"connector": "demo", "instance": "desktop"},
        headers=auth(),
    )
    assert taken.status_code == 201
    assert taken.json()["data"]["instance"] == "desktop"
    assert taken.json()["data"]["leaseId"] != acquired["leaseId"]


def test_lease_ttl_is_clamped(client: TestClient) -> None:
    tiny = client.post(
        "/v1/leases",
        json={"connector": "demo", "instance": "laptop", "ttlSeconds": 1},
        headers=auth(),
    ).json()["data"]
    # Clamped to 15s: still comfortably in the future, never already expired.
    assert tiny["expiresAt"] > client.get("/health").json()["data"]["now"]

    huge = client.post(
        "/v1/leases",
        json={"connector": "demo", "instance": "laptop", "ttlSeconds": 99999},
        headers=auth(),
    )
    assert huge.status_code == 201


# ---------------------------------------------------------------------------
# Shared state optimistic locking
# ---------------------------------------------------------------------------


def test_state_optimistic_lock(client: TestClient) -> None:
    initial = client.get("/v1/state/demo", headers=auth())
    assert initial.status_code == 200
    assert initial.json()["data"] == {
        "connector": "demo",
        "revision": 0,
        "state": None,
        "updatedAt": None,
    }

    first = client.put(
        "/v1/state/demo",
        json={"state": {"cursor": "2026-01-01", "seen": [1, 2]}, "revision": 0},
        headers=auth(),
    )
    assert first.status_code == 200
    assert first.json()["data"]["revision"] == 1

    stale = client.put(
        "/v1/state/demo",
        json={"state": {"cursor": "x"}, "revision": 0},
        headers=auth(),
    )
    assert stale.status_code == 409
    assert stale.json()["reason"] == "revision-conflict"

    forced = client.put("/v1/state/demo", json={"state": [1, 2, 3]}, headers=auth())
    assert forced.status_code == 200
    assert forced.json()["data"]["revision"] == 2

    current = client.get("/v1/state/demo", headers=auth()).json()["data"]
    assert current["state"] == [1, 2, 3]
    assert current["revision"] == 2
    assert current["updatedAt"].endswith("+00:00")


# ---------------------------------------------------------------------------
# Run history
# ---------------------------------------------------------------------------


def test_runs_append_list_and_filter(client: TestClient) -> None:
    first = client.post(
        "/v1/runs",
        json={"connector": "demo", "run": {"status": "ok", "n": 1}},
        headers=auth(),
    )
    assert first.status_code == 200
    first_id = first.json()["data"]["id"]

    second = client.post(
        "/v1/runs",
        json={"connector": "other", "run": {"status": "failed", "n": 2}},
        headers=auth(),
    ).json()["data"]["id"]
    assert second > first_id

    runs = client.get("/v1/runs?connector=demo", headers=auth()).json()["data"]["runs"]
    assert len(runs) == 1
    assert runs[0]["id"] == first_id
    assert runs[0]["run"] == {"status": "ok", "n": 1}
    assert runs[0]["createdAt"].endswith("+00:00")

    all_runs = client.get("/v1/runs", headers=auth()).json()["data"]["runs"]
    assert [run["id"] for run in all_runs] == [second, first_id]

    capped = client.get("/v1/runs?limit=500", headers=auth())
    assert capped.status_code == 422
    assert capped.json()["reason"] == "invalid-request"

    oversized = client.post(
        "/v1/runs",
        json={"connector": "demo", "run": {"blob": "x" * (64 * 1024)}},
        headers=auth(),
    )
    assert oversized.status_code == 413


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


def test_stats_reflects_store_contents(client: TestClient) -> None:
    client.put("/v1/connectors/demo", json={"yaml": "a: 1\n"}, headers=auth())
    client.post("/v1/runs", json={"connector": "demo", "run": {"n": 1}}, headers=auth())
    client.post(
        "/v1/leases",
        json={"connector": "demo", "instance": "laptop"},
        headers=auth(),
    )

    stats = client.get("/v1/stats", headers=auth())
    assert stats.status_code == 200
    data = stats.json()["data"]
    assert data["connectors"] == 1
    assert data["runs"] == 1
    assert data["leases"] == 1
    assert data["dbBytes"] > 0
