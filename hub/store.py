"""SQLite persistence for the optional local Connector Hub.

The hub is deliberately a single-database service.  Every mutation runs inside
a short ``BEGIN IMMEDIATE`` transaction so read-modify-write sequences (the
optimistic ``revision`` checks and lease acquisition) stay atomic even when
several request threads, or two hub processes, touch the same file.  WAL mode
keeps readers out of the writer's way and ``busy_timeout`` absorbs the short
lock contention that remains.

Connections are created per call instead of being pooled: the workload is tiny,
and a fresh connection is the simplest way to keep thread-safety honest without
an ORM or ``check_same_thread`` footguns.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

DB_FILENAME = "hub.db"
SCHEMA_VERSION = 1

# Contract limits.  Kept next to the storage layer so both the HTTP layer and
# the tests can share them instead of duplicating magic numbers.
MAX_CONNECTOR_BYTES = 1024 * 1024  # 1 MiB of YAML
MAX_RUN_BYTES = 64 * 1024  # 64 KiB of JSON per run
MIN_LEASE_TTL = 15
MAX_LEASE_TTL = 3600
DEFAULT_LEASE_TTL = 120


class RevisionConflict(Exception):
    """Raised when an optimistic-lock ``revision`` does not match the row."""

    def __init__(self, current_revision: int) -> None:
        super().__init__(f"revision conflict, current revision is {current_revision}")
        self.current_revision = current_revision


class LeaseHeld(Exception):
    """Raised when another instance already owns an unexpired lease."""

    def __init__(self, holder: dict[str, Any]) -> None:
        super().__init__(f"lease held by {holder.get('instance')!r}")
        self.holder = holder


def utc_now() -> str:
    """Return the current UTC instant in the ISO-8601 form used by the API."""

    return datetime.now(timezone.utc).isoformat()


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def content_hash(text: str) -> str:
    """Short, stable identifier for a connector document (first 16 sha256 hex)."""

    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _dump_json(value: Any) -> str:
    # Compact separators keep run payloads small and make the byte-size check
    # match what is actually written to disk.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _load_json(text: str) -> Any:
    return json.loads(text)


def clamp_ttl(ttl_seconds: Optional[int]) -> int:
    """Clamp a lease TTL into [MIN_LEASE_TTL, MAX_LEASE_TTL].

    Clamping (rather than rejecting) keeps an older client from failing the
    whole sync cycle because it asked for a TTL just outside the range.
    """

    ttl = DEFAULT_LEASE_TTL if ttl_seconds is None else int(ttl_seconds)
    return max(MIN_LEASE_TTL, min(MAX_LEASE_TTL, ttl))


class Store:
    """Thin synchronous repository around one ``hub.db`` file."""

    def __init__(self, data_dir: str | os.PathLike[str]) -> None:
        self.data_dir = Path(data_dir).expanduser()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / DB_FILENAME
        self._init_schema()

    # ------------------------------------------------------------------
    # Connection helpers
    # ------------------------------------------------------------------

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(
            str(self.db_path),
            timeout=5.0,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        # We drive transactions explicitly; the legacy implicit mode would
        # otherwise open one before our own BEGIN IMMEDIATE.
        conn.isolation_level = None
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA synchronous = NORMAL")
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def _read(self) -> Iterator[sqlite3.Connection]:
        with self._connect() as conn:
            yield conn

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        with self._connect() as conn:
            # IMMEDIATE takes the write lock up front.  That is what makes the
            # check-then-update logic below safe across threads and processes:
            # nobody else can slip a write between our SELECT and our INSERT.
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass  # the connection is about to be closed anyway
                raise
            else:
                conn.execute("COMMIT")

    def _init_schema(self) -> None:
        with self._connect() as conn:
            # WAL is persistent per database file; setting it once here is
            # enough, but it must happen outside a transaction.
            conn.execute("PRAGMA journal_mode = WAL")
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise RuntimeError(
                    f"database schema version {version} is newer than this hub "
                    f"supports ({SCHEMA_VERSION}); upgrade the hub"
                )
            if version < 1:
                conn.executescript(_SCHEMA_V1)

    # ------------------------------------------------------------------
    # Connectors
    # ------------------------------------------------------------------

    def list_connectors(self) -> list[dict[str, Any]]:
        with self._read() as conn:
            rows = conn.execute(
                "SELECT name, revision, hash, owner, updated_at "
                "FROM connectors ORDER BY name ASC"
            ).fetchall()
        return [_connector_summary(row) for row in rows]

    def count_connectors(self) -> int:
        with self._read() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM connectors").fetchone()[0])

    def get_connector(self, name: str) -> Optional[dict[str, Any]]:
        with self._read() as conn:
            row = conn.execute(
                "SELECT name, yaml, revision, hash, owner, updated_at "
                "FROM connectors WHERE name = ?",
                (name,),
            ).fetchone()
        if row is None:
            return None
        result = _connector_summary(row)
        result["yaml"] = row["yaml"]
        return result

    def put_connector(
        self,
        name: str,
        yaml_text: str,
        owner: Optional[str],
        expected_revision: Optional[int],
    ) -> dict[str, Any]:
        """Create or replace a connector, optionally guarded by ``revision``."""

        now = utc_now()
        digest = content_hash(yaml_text)
        with self._write() as conn:
            row = conn.execute(
                "SELECT revision, owner FROM connectors WHERE name = ?", (name,)
            ).fetchone()
            current = int(row["revision"]) if row else 0
            if expected_revision is not None and expected_revision != current:
                raise RevisionConflict(current)

            new_revision = current + 1
            # Omitted owner means "keep whoever last touched it"; an explicit
            # owner (including an empty string) is stored as given.
            effective_owner = owner if owner is not None else (row["owner"] if row else None)
            conn.execute(
                "INSERT INTO connectors (name, yaml, revision, hash, owner, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(name) DO UPDATE SET "
                "  yaml = excluded.yaml, revision = excluded.revision, "
                "  hash = excluded.hash, owner = excluded.owner, "
                "  updated_at = excluded.updated_at",
                (name, yaml_text, new_revision, digest, effective_owner, now),
            )
        return {
            "name": name,
            "revision": new_revision,
            "hash": digest,
            "updatedAt": now,
        }

    def delete_connector(self, name: str, expected_revision: Optional[int]) -> bool:
        """Delete a connector.  Returns False when it does not exist."""

        with self._write() as conn:
            row = conn.execute(
                "SELECT revision FROM connectors WHERE name = ?", (name,)
            ).fetchone()
            if row is None:
                return False
            if expected_revision is not None and expected_revision != int(row["revision"]):
                raise RevisionConflict(int(row["revision"]))
            conn.execute("DELETE FROM connectors WHERE name = ?", (name,))
        return True

    # ------------------------------------------------------------------
    # Leases
    # ------------------------------------------------------------------

    @staticmethod
    def _purge_expired_leases(conn: sqlite3.Connection, now_epoch: float) -> None:
        # Lazy cleanup: called before every lease read/write so expired rows
        # never block a new holder and health counts stay truthful.
        conn.execute("DELETE FROM leases WHERE expires_at_epoch <= ?", (now_epoch,))

    def count_active_leases(self) -> int:
        # Read-only on purpose: /health is unauthenticated, so it must never
        # take the write lock (or trigger cleanup writes).
        now = time.time()
        with self._read() as conn:
            return int(
                conn.execute(
                    "SELECT COUNT(*) FROM leases WHERE expires_at_epoch > ?", (now,)
                ).fetchone()[0]
            )

    def acquire_lease(
        self, connector: str, instance: str, ttl_seconds: Optional[int]
    ) -> dict[str, Any]:
        """Acquire (or idempotently renew) the lease for one connector.

        The same instance always gets its existing ``leaseId`` back, which makes
        retries after an ambiguous network failure safe.
        """

        ttl = clamp_ttl(ttl_seconds)
        now = time.time()
        expires = now + ttl
        with self._write() as conn:
            self._purge_expired_leases(conn, now)
            row = conn.execute(
                "SELECT lease_id, connector, instance, expires_at, expires_at_epoch "
                "FROM leases WHERE connector = ?",
                (connector,),
            ).fetchone()
            if row is not None:
                if row["instance"] == instance:
                    conn.execute(
                        "UPDATE leases SET expires_at = ?, expires_at_epoch = ? "
                        "WHERE lease_id = ?",
                        (_iso(expires), expires, row["lease_id"]),
                    )
                    return {
                        "leaseId": row["lease_id"],
                        "connector": connector,
                        "instance": instance,
                        "expiresAt": _iso(expires),
                    }
                raise LeaseHeld(
                    {
                        "instance": row["instance"],
                        "leaseId": row["lease_id"],
                        "expiresAt": row["expires_at"],
                    }
                )

            lease_id = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO leases "
                "(lease_id, connector, instance, expires_at, expires_at_epoch, acquired_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (lease_id, connector, instance, _iso(expires), expires, utc_now()),
            )
        return {
            "leaseId": lease_id,
            "connector": connector,
            "instance": instance,
            "expiresAt": _iso(expires),
        }

    def renew_lease(self, lease_id: str, ttl_seconds: Optional[int]) -> Optional[dict[str, Any]]:
        """Extend a live lease.  Expired or unknown leases return None."""

        ttl = clamp_ttl(ttl_seconds)
        now = time.time()
        expires = now + ttl
        with self._write() as conn:
            row = conn.execute(
                "SELECT lease_id, expires_at_epoch FROM leases WHERE lease_id = ?",
                (lease_id,),
            ).fetchone()
            if row is None:
                return None
            if float(row["expires_at_epoch"]) <= now:
                # Treat an expired row as gone rather than resurrecting it.
                conn.execute("DELETE FROM leases WHERE lease_id = ?", (lease_id,))
                return None
            conn.execute(
                "UPDATE leases SET expires_at = ?, expires_at_epoch = ? WHERE lease_id = ?",
                (_iso(expires), expires, lease_id),
            )
        return {"leaseId": lease_id, "expiresAt": _iso(expires)}

    def release_lease(self, lease_id: str) -> bool:
        with self._write() as conn:
            cursor = conn.execute("DELETE FROM leases WHERE lease_id = ?", (lease_id,))
            return cursor.rowcount > 0

    # ------------------------------------------------------------------
    # Shared connector state
    # ------------------------------------------------------------------

    def get_state(self, connector: str) -> dict[str, Any]:
        with self._read() as conn:
            row = conn.execute(
                "SELECT revision, state, updated_at FROM states WHERE connector = ?",
                (connector,),
            ).fetchone()
        if row is None:
            # An unwritten connector is revision 0 with a null state, so a
            # first writer can send revision=0 without a special case.
            return {
                "connector": connector,
                "revision": 0,
                "state": None,
                "updatedAt": None,
            }
        return {
            "connector": connector,
            "revision": int(row["revision"]),
            "state": _load_json(row["state"]),
            "updatedAt": row["updated_at"],
        }

    def put_state(
        self, connector: str, state: Any, expected_revision: Optional[int]
    ) -> dict[str, Any]:
        text = _dump_json(state)
        now = utc_now()
        with self._write() as conn:
            row = conn.execute(
                "SELECT revision FROM states WHERE connector = ?", (connector,)
            ).fetchone()
            current = int(row["revision"]) if row else 0
            if expected_revision is not None and expected_revision != current:
                raise RevisionConflict(current)
            new_revision = current + 1
            conn.execute(
                "INSERT INTO states (connector, revision, state, updated_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT(connector) DO UPDATE SET "
                "  revision = excluded.revision, state = excluded.state, "
                "  updated_at = excluded.updated_at",
                (connector, new_revision, text, now),
            )
        return {"connector": connector, "revision": new_revision, "updatedAt": now}

    # ------------------------------------------------------------------
    # Run history
    # ------------------------------------------------------------------

    def add_run(self, connector: str, run: dict[str, Any]) -> int:
        text = _dump_json(run)
        with self._write() as conn:
            cursor = conn.execute(
                "INSERT INTO runs (connector, run, created_at) VALUES (?, ?, ?)",
                (connector, text, utc_now()),
            )
            return int(cursor.lastrowid)

    def list_runs(self, connector: Optional[str], limit: int) -> list[dict[str, Any]]:
        with self._read() as conn:
            if connector is None:
                rows = conn.execute(
                    "SELECT id, connector, run, created_at FROM runs "
                    "ORDER BY id DESC LIMIT ?",
                    (limit,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, connector, run, created_at FROM runs "
                    "WHERE connector = ? ORDER BY id DESC LIMIT ?",
                    (connector, limit),
                ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "connector": row["connector"],
                "run": _load_json(row["run"]),
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    def count_runs(self) -> int:
        with self._read() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0])

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def db_size_bytes(self) -> int:
        total = 0
        # WAL and SHM are part of the on-disk footprint while the hub runs;
        # reporting only hub.db would understate it dramatically.
        for suffix in ("", "-wal", "-shm"):
            path = Path(f"{self.db_path}{suffix}")
            try:
                total += path.stat().st_size
            except OSError:
                continue
        return total

    def stats(self) -> dict[str, int]:
        now = time.time()
        with self._write() as conn:
            self._purge_expired_leases(conn, now)
            connectors = int(conn.execute("SELECT COUNT(*) FROM connectors").fetchone()[0])
            runs = int(conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0])
            leases = int(conn.execute("SELECT COUNT(*) FROM leases").fetchone()[0])
        return {
            "connectors": connectors,
            "runs": runs,
            "leases": leases,
            "dbBytes": self.db_size_bytes(),
        }

    def close(self) -> None:
        """Compatibility hook; connections are closed after every call."""


_SCHEMA_V1 = """
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS connectors (
    name       TEXT PRIMARY KEY,
    yaml       TEXT NOT NULL,
    revision   INTEGER NOT NULL,
    hash       TEXT NOT NULL,
    owner      TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
    lease_id         TEXT PRIMARY KEY,
    connector        TEXT NOT NULL,
    instance         TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    expires_at_epoch REAL NOT NULL,
    acquired_at      TEXT NOT NULL
);

-- One active lease per connector is the whole point of the hub.  The unique
-- index turns a lost race into a constraint error instead of a double holder.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_connector ON leases(connector);
CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases(expires_at_epoch);

CREATE TABLE IF NOT EXISTS states (
    connector  TEXT PRIMARY KEY,
    revision   INTEGER NOT NULL,
    state      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    connector  TEXT NOT NULL,
    run        TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_connector_id ON runs(connector, id DESC);

PRAGMA user_version = 1;
COMMIT;
"""


def _connector_summary(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "name": row["name"],
        "revision": int(row["revision"]),
        "hash": row["hash"],
        "owner": row["owner"],
        "updatedAt": row["updated_at"],
    }
