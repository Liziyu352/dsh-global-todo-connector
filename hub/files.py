"""Virtual file manager: CAS-protected access to the shared todos.json.

When several DSH instances point their connector at the same ``todos.json``,
whoever writes last wins and a slow writer can silently revert a fast one.
This module puts the write behind the hub: the JSON body still lives on the
filesystem (so the upstream plugin keeps reading it directly — "原版优先"),
but the revision token lives in SQLite and every write is a compare-and-swap.

Only the ``todo-store`` virtual name is exposed.  That is deliberate: the hub
should never become a general-purpose file server for its data directory.
"""

from __future__ import annotations

import json
import math
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any, Optional

from hub.store import Store

# Mirror of the upstream plugin's limits (lib/store.js LIMITS).  Keeping them
# equal means a document the connector accepts is still acceptable upstream.
LIMITS = {
    "title": 200,
    "description": 10000,
    "tags": 20,
    "tag": 32,
    "activity": 50,
    "note": 2000,
    "notes": 50,
    "steps": 20,
    "step": 200,
    "evidence": 300,
}

SCHEMA_VERSION = 2

# The only virtual name this hub serves.  Everything else is a 404 rather than
# an arbitrary path lookup.
FILE_WHITELIST = ("todo-store",)

_STATUSES = ("open", "doing", "done", "cancelled", "archived")
_PRIORITIES = ("urgent", "high", "normal", "low")
_HTTP_URL = re.compile(r"^https?://", re.IGNORECASE)


class FileError(Exception):
    """Base class for the errors the HTTP layer renders as an envelope."""

    status = 400
    reason = "file-error"

    def __init__(self, message: str) -> None:
        super().__init__(message)


class UnknownFile(FileError):
    status = 404
    reason = "not-found"


class FileManagerDisabled(FileError):
    status = 503
    reason = "file-manager-disabled"


class InvalidDocument(FileError):
    status = 422
    reason = "invalid-document"


class StoreCorrupt(FileError):
    status = 500
    reason = "store-corrupt"


# ---------------------------------------------------------------------------
# Salvage/normalisation — a Python translation of connector lib/store.js
# ---------------------------------------------------------------------------


def _text(value: Any, max_length: Optional[int] = None) -> str:
    if not isinstance(value, str):
        return ""
    trimmed = value.strip()
    if max_length is not None and len(trimmed) > max_length:
        return trimmed[:max_length]
    return trimmed


def _number(value: Any, default: Any = None) -> Any:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    if not math.isfinite(value):
        return default
    return value


def _normalize_tags(value: Any) -> list[str]:
    if isinstance(value, str):
        items: list[Any] = value.split(",")
    elif isinstance(value, list):
        items = value
    else:
        items = []
    out: list[str] = []
    seen: set[str] = set()
    for raw in items:
        if not isinstance(raw, str):
            continue
        tag = raw.strip().lstrip("#")
        if not tag or len(tag) > LIMITS["tag"]:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
        if len(out) >= LIMITS["tags"]:
            break
    return out


def _normalize_link(raw: Any) -> Optional[dict[str, str]]:
    if isinstance(raw, str):
        value = raw.strip()
        if not value:
            return None
        return {
            "kind": "url" if _HTTP_URL.match(value) else "file",
            "value": value[:4096],
            "title": "",
        }
    if not isinstance(raw, dict):
        return None
    value = _text(raw.get("value") or raw.get("path") or raw.get("url"), 4096)
    if not value:
        return None
    kind = raw.get("kind")
    if kind not in ("url", "file", "image"):
        kind = "url" if _HTTP_URL.match(value) else "file"
    return {"kind": kind, "value": value, "title": _text(raw.get("title"), 200)}


def _normalize_links(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in value:
        link = _normalize_link(item)
        if link is None:
            continue
        key = f"{link['kind']}:{link['value']}"
        if key in seen:
            continue
        seen.add(key)
        out.append(link)
    return out


def _normalize_steps(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict):
            continue
        title = _text(raw.get("title"), LIMITS["step"])
        if not title:
            continue
        out.append({"title": title, "done": raw.get("done") is True})
        if len(out) >= LIMITS["steps"]:
            break
    return out


def _normalize_activity(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    for raw in value[-LIMITS["activity"] :]:
        if not isinstance(raw, dict):
            continue
        kind = raw.get("kind")
        if not isinstance(kind, str):
            continue
        entry: dict[str, Any] = {
            "at": _number(raw.get("at"), int(_now_ms())),
            "by": "agent" if raw.get("by") == "agent" else "human",
            "kind": kind,
        }
        summary = _text(raw.get("summary"), 300)
        if summary:
            entry["summary"] = summary
        out.append(entry)
    return out


def _normalize_review(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict) or value.get("pending") is not True:
        return None
    return {
        "pending": True,
        "at": _number(value.get("at"), int(_now_ms())),
        "by": "agent" if value.get("by") == "agent" else "human",
    }


def _now_ms() -> float:
    import time

    return time.time() * 1000


def normalize_todo(raw: Any, activity_limit: int = LIMITS["activity"]) -> Optional[dict[str, Any]]:
    """Make one stored record safe, or return ``None`` when unsalvageable."""

    if not isinstance(raw, dict):
        return None
    todo_id = _text(raw.get("id"), 200)
    title = _text(raw.get("title"), LIMITS["title"])
    if not todo_id or not title:
        return None

    status = raw.get("status")
    if status not in _STATUSES:
        status = "open"
    priority = raw.get("priority")
    if priority not in _PRIORITIES:
        priority = "normal"
    suggested = raw.get("suggestedPriority")
    if suggested not in _PRIORITIES:
        suggested = ""

    todo: dict[str, Any] = {
        "id": todo_id,
        "seq": _number(raw.get("seq"), 0),
        "title": title,
        "description": _text(raw.get("description"), LIMITS["description"]),
        "status": status,
        "priority": priority,
        "prioritySource": "human" if raw.get("prioritySource") == "human" else "rule",
        "suggestedPriority": suggested,
        "captureSource": raw.get("captureSource") if isinstance(raw.get("captureSource"), str) else "",
        "inboxReason": raw.get("inboxReason") if isinstance(raw.get("inboxReason"), str) else "",
        "dueAt": raw.get("dueAt") if isinstance(raw.get("dueAt"), str) else None,
        "tags": _normalize_tags(raw.get("tags")),
        "links": _normalize_links(raw.get("links")),
        "steps": _normalize_steps(raw.get("steps")),
        "evidence": _text(raw.get("evidence"), LIMITS["evidence"]),
        "createdAt": _number(raw.get("createdAt"), int(_now_ms())),
        "updatedAt": _number(raw.get("updatedAt"), int(_now_ms())),
        "createdBy": "agent" if raw.get("createdBy") == "agent" else "human",
        "updatedBy": "agent" if raw.get("updatedBy") == "agent" else "human",
        "doneAt": _number(raw.get("doneAt"), None),
        "sessionId": raw.get("sessionId") if isinstance(raw.get("sessionId"), str) else "",
        "originDir": raw.get("originDir") if isinstance(raw.get("originDir"), str) else "",
        "originSessionId": (
            raw.get("originSessionId") if isinstance(raw.get("originSessionId"), str) else ""
        ),
        "lastDispatch": raw.get("lastDispatch") if isinstance(raw.get("lastDispatch"), dict) else None,
        "completion": raw.get("completion") if isinstance(raw.get("completion"), dict) else None,
        "review": _normalize_review(raw.get("review")),
        "notes": raw.get("notes")[-LIMITS["notes"] :] if isinstance(raw.get("notes"), list) else [],
        "activity": _normalize_activity(raw.get("activity"))[-activity_limit:],
    }
    # Unknown fields survive: a newer upstream plugin may model fields this
    # hub does not know, and dropping them would be data loss on every sync.
    for key, value in raw.items():
        if key not in todo:
            todo[key] = value
    return todo


def normalize_document(value: Any, activity_limit: int = LIMITS["activity"]) -> dict[str, Any]:
    """Read a whole document tolerantly, dropping only unsalvageable records."""

    raw = value if isinstance(value, dict) else {}
    entries = raw.get("todos") if isinstance(raw.get("todos"), list) else []
    todos: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in entries:
        todo = normalize_todo(entry, activity_limit)
        if todo is None or todo["id"] in seen:
            continue
        seen.add(todo["id"])
        todos.append(todo)
    trash_raw = raw.get("trash")
    trash = [item for item in trash_raw if isinstance(item, dict)] if isinstance(trash_raw, list) else []
    version = _number(raw.get("version"), SCHEMA_VERSION)
    return {"version": int(version), "todos": todos, "trash": trash}


def empty_document() -> dict[str, Any]:
    return {"version": SCHEMA_VERSION, "todos": [], "trash": []}


# ---------------------------------------------------------------------------
# The manager
# ---------------------------------------------------------------------------


class FileManager:
    """Revision-tracked access to exactly one on-disk JSON document."""

    def __init__(self, store: Store, todo_store: Optional[str | os.PathLike[str]]) -> None:
        self.store = store
        self.path = Path(todo_store).expanduser() if todo_store else None

    @property
    def enabled(self) -> bool:
        return self.path is not None

    def resolve(self, name: str) -> Path:
        if name not in FILE_WHITELIST:
            raise UnknownFile(f"未知的虚拟文件 {name!r}（只支持 {', '.join(FILE_WHITELIST)}）")
        if self.path is None:
            raise FileManagerDisabled(
                "hub 未配置 --todo-store，文件代理不可用"
            )
        return self.path

    def read(self, name: str) -> dict[str, Any]:
        path = self.resolve(name)
        revision = self.store.file_revision(name)
        doc = empty_document()
        exists = False
        mtime: Optional[str] = None

        try:
            raw_text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raw_text = ""
        except OSError as error:
            raise StoreCorrupt(f"读取 {path} 失败：{error}") from error
        else:
            exists = True
            if raw_text.strip():
                try:
                    parsed = json.loads(raw_text)
                except json.JSONDecodeError as error:
                    # Same contract as the upstream store: refuse to guess and
                    # never silently reset somebody's todo list.
                    raise StoreCorrupt(f"{path} 不是合法 JSON：{error}") from error
                if isinstance(parsed, dict):
                    version = _number(parsed.get("version"), SCHEMA_VERSION)
                    if version > SCHEMA_VERSION:
                        raise StoreCorrupt(
                            f"{path} 的 schema 版本是 {int(version)}，本 hub 只认识 "
                            f"{SCHEMA_VERSION}，请升级 hub 或移走文件"
                        )
                doc = normalize_document(parsed)
            try:
                mtime = _iso_mtime(path)
            except OSError:
                mtime = None

        # Flattened per DESIGN-v2 §3.1: the payload *is* the document plus its
        # revision.  ``doc`` stays as an alias because the JS client reads that
        # shape for PUT; keeping both costs one dict reference.
        result: dict[str, Any] = {
            "name": name,
            "revision": revision,
            "exists": exists,
            "path": str(path),
            "updatedAt": mtime,
            "version": doc["version"],
            "todos": doc["todos"],
            "trash": doc["trash"],
            "doc": doc,
        }
        return result

    def write(self, name: str, doc: Any, expected_revision: int) -> dict[str, Any]:
        path = self.resolve(name)
        if not isinstance(doc, dict):
            raise InvalidDocument("doc 必须是 JSON 对象")
        if not isinstance(doc.get("todos"), list):
            raise InvalidDocument("doc.todos 必须是数组")
        version = _number(doc.get("version"), SCHEMA_VERSION)
        if version > SCHEMA_VERSION:
            raise InvalidDocument(
                f"doc.version 是 {int(version)}，本 hub 只支持 <= {SCHEMA_VERSION}"
            )

        normalized = normalize_document(doc)
        payload = json.dumps(
            {
                "version": SCHEMA_VERSION,
                "todos": normalized["todos"],
                "trash": normalized["trash"],
            },
            ensure_ascii=False,
            indent=2,
        ) + "\n"

        def apply() -> None:
            _atomic_write(path, payload)

        # The revision bump and the rename happen inside one IMMEDIATE
        # transaction, so a concurrent writer either loses the CAS check before
        # touching the file, or wins it and sees our bytes — never both.
        revision = self.store.commit_file(name, expected_revision, apply)
        return {
            "name": name,
            "revision": revision,
            "updatedAt": self.store.file_mtime(name),
        }


def _iso_mtime(path: Path) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()


def _atomic_write(path: Path, payload: str) -> None:
    """Write ``payload`` next to ``path`` and rename it into place."""

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # Keep whatever mode the upstream plugin already gave the file;
            # mkstemp's 0600 would otherwise lock it down unexpectedly.
            os.chmod(tmp, stat.S_IMODE(path.stat().st_mode))
        except OSError:
            pass
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
