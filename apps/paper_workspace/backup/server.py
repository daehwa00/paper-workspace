from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import tempfile
import urllib.parse
import zlib
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any

MAX_REQUEST_BYTES = 12_000_000
MAX_SNAPSHOT_BYTES = 10_000_000
MAX_PROJECT_FILES = 240
DEFAULT_RETENTION = 50
PROJECT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
COLLECTION_PATTERN = re.compile(r"^/projects/([^/]+)/snapshots/?$")
ITEM_PATTERN = re.compile(r"^/projects/([^/]+)/snapshots/([1-9][0-9]*)/?$")
ACTIVITY_COLLECTION_PATTERN = re.compile(r"^/activity/?$")
ACTIVITY_ITEM_PATTERN = re.compile(r"^/projects/([^/]+)/activity/?$")
ASSET_COLLECTION_PATTERN = re.compile(r"^/projects/([^/]+)/assets/?$")
ASSET_ITEM_PATTERN = re.compile(r"^/projects/([^/]+)/assets/(.+)$")
DEFAULT_MAX_ASSET_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_PROJECT_ASSET_BYTES = 128 * 1024 * 1024
DEFAULT_SHARED_ACTOR = "Shared user"
TRUSTED_ACTOR_HEADER = "X-Paper-Actor"
ALLOWED_ASSET_MIME_TYPES = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".eps": "application/postscript",
}


class ValidationError(ValueError):
    pass


class SnapshotNotFound(LookupError):
    pass


def validate_project_id(project_id: object) -> str:
    if not isinstance(project_id, str) or not PROJECT_ID_PATTERN.fullmatch(project_id):
        raise ValidationError("invalid project id")
    return project_id


def validate_project_path(name: object) -> str:
    if not isinstance(name, str) or not name or len(name) > 240 or "\\" in name:
        raise ValidationError("invalid project path")
    if name.startswith("/") or "//" in name:
        raise ValidationError("invalid project path")
    parts = name.split("/")
    if len(parts) > 12 or any(part in {"", ".", ".."} for part in parts):
        raise ValidationError("invalid project path")
    if any(any(ord(character) < 32 for character in part) for part in parts):
        raise ValidationError("invalid project path")
    if PurePosixPath(name).is_absolute():
        raise ValidationError("invalid project path")
    return name


def canonical_snapshot(snapshot: object) -> tuple[dict[str, Any], bytes]:
    if not isinstance(snapshot, dict):
        raise ValidationError("snapshot must be an object")
    files = snapshot.get("files")
    assets = snapshot.get("assets", {})
    if not isinstance(files, dict) or not files:
        raise ValidationError("snapshot files must be a non-empty object")
    if not isinstance(assets, dict) or len(files) + len(assets) > MAX_PROJECT_FILES:
        raise ValidationError("snapshot contains too many project files")
    for collection in (files, assets):
        for name, content in collection.items():
            validate_project_path(name)
            if not isinstance(content, str):
                raise ValidationError("project file contents must be strings")
    if set(files) & set(assets):
        raise ValidationError("a path cannot be both a source file and an asset")
    title = snapshot.get("title")
    if title is not None and (not isinstance(title, str) or len(title) > 500):
        raise ValidationError("invalid project title")
    comments = snapshot.get("comments")
    if comments is not None and not isinstance(comments, (list, dict)):
        raise ValidationError("invalid comments")
    tasks = snapshot.get("tasks")
    if tasks is not None and (not isinstance(tasks, list) or len(tasks) > 500):
        raise ValidationError("invalid tasks")
    try:
        encoded = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValidationError("snapshot must contain JSON values") from error
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        raise ValidationError("snapshot is too large")
    # Decode the canonical representation so callers cannot mutate the stored value
    # through a reference retained from the request object.
    return json.loads(encoded), encoded


def validate_optional_text(value: object, field: str, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > maximum or any(ord(character) < 32 for character in value):
        raise ValidationError(f"invalid {field}")
    return value


def validate_asset_content(name: object, content: bytes) -> str:
    clean_name = validate_project_path(name)
    if clean_name.lower().endswith(".synctex.gz"):
        if not content.startswith(b"\x1f\x8b"):
            raise ValidationError("asset content does not match its file type")
        return "application/gzip"
    suffix = PurePosixPath(clean_name).suffix.lower()
    content_type = ALLOWED_ASSET_MIME_TYPES.get(suffix)
    if content_type is None:
        raise ValidationError("asset type is not allowed")
    valid_signature = (
        suffix == ".pdf" and content.startswith(b"%PDF-")
        or suffix == ".png" and content.startswith(b"\x89PNG\r\n\x1a\n")
        or suffix in {".jpg", ".jpeg"} and content.startswith(b"\xff\xd8\xff")
        or suffix == ".eps"
        and content.startswith(b"%!PS-Adobe-")
        and b" EPSF-" in content.splitlines()[0]
    )
    if not valid_signature:
        raise ValidationError("asset content does not match its file type")
    return content_type


def safe_asset_content_type(name: object, content: bytes) -> str:
    try:
        return validate_asset_content(name, content)
    except ValidationError:
        # Files created before validation was introduced remain retrievable, but
        # never with an executable or browser-sniffable media type.
        return "application/octet-stream"


class BackupStore:
    def __init__(self, database_path: str | Path, retention: int = DEFAULT_RETENTION, export_dir: str | Path | None = None) -> None:
        if not 1 <= retention <= 1000:
            raise ValueError("retention must be between 1 and 1000")
        self.database_path = Path(database_path)
        self.retention = retention
        self.export_dir = Path(export_dir) if export_dir else None
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        if self.export_dir:
            self.export_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 10000")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    checked_at TEXT,
                    content_hash TEXT NOT NULL,
                    actor TEXT,
                    reason TEXT,
                    size_bytes INTEGER NOT NULL,
                    payload BLOB NOT NULL,
                    payload_encoding TEXT NOT NULL DEFAULT 'json',
                    UNIQUE(project_id, content_hash)
                )
                """
            )
            columns = {row[1] for row in connection.execute("PRAGMA table_info(snapshots)")}
            if "payload_encoding" not in columns:
                connection.execute("ALTER TABLE snapshots ADD COLUMN payload_encoding TEXT NOT NULL DEFAULT 'json'")
            if "checked_at" not in columns:
                connection.execute("ALTER TABLE snapshots ADD COLUMN checked_at TEXT")
                connection.execute("UPDATE snapshots SET checked_at = created_at WHERE checked_at IS NULL")
            connection.execute(
                "CREATE INDEX IF NOT EXISTS snapshots_project_order ON snapshots(project_id, id DESC)"
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS project_activity (
                    project_id TEXT PRIMARY KEY,
                    modified_at TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    reason TEXT
                )
                """
            )

    @staticmethod
    def _metadata(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "project_id": row["project_id"],
            "created_at": row["created_at"],
            "checked_at": row["checked_at"] or row["created_at"],
            "hash": row["content_hash"],
            "actor": row["actor"],
            "reason": row["reason"],
            "size_bytes": row["size_bytes"],
        }

    def create(
        self,
        project_id: object,
        snapshot: object,
        actor: object = None,
        reason: object = None,
    ) -> tuple[dict[str, Any], bool]:
        project = validate_project_id(project_id)
        _, encoded = canonical_snapshot(snapshot)
        author = validate_optional_text(actor, "actor", 120)
        backup_reason = validate_optional_text(reason, "reason", 80)
        digest = hashlib.sha256(encoded).hexdigest()
        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO snapshots(
                    project_id, created_at, checked_at, content_hash, actor, reason, size_bytes, payload, payload_encoding
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (project, created_at, created_at, digest, author, backup_reason, len(encoded), zlib.compress(encoded, level=6), "zlib"),
            )
            if cursor.rowcount == 0:
                connection.execute(
                    "UPDATE snapshots SET checked_at = ? WHERE project_id = ? AND content_hash = ?",
                    (created_at, project, digest),
                )
                existing = connection.execute(
                    "SELECT * FROM snapshots WHERE project_id = ? AND content_hash = ?", (project, digest)
                ).fetchone()
                assert existing is not None
                metadata = self._metadata(existing)
                self._export(project, metadata, encoded)
                return metadata, True
            snapshot_id = cursor.lastrowid
            connection.execute(
                """
                DELETE FROM snapshots
                WHERE project_id = ? AND id NOT IN (
                    SELECT id FROM snapshots WHERE project_id = ? ORDER BY id DESC LIMIT ?
                )
                """,
                (project, project, self.retention),
            )
            row = connection.execute("SELECT * FROM snapshots WHERE id = ?", (snapshot_id,)).fetchone()
        assert row is not None
        self._export(project, self._metadata(row), encoded)
        return self._metadata(row), False

    def _export(self, project: str, metadata: dict[str, Any], encoded: bytes) -> None:
        if not self.export_dir:
            return
        project_dir = self.export_dir / project
        project_dir.mkdir(parents=True, exist_ok=True)
        target = project_dir / f"{metadata['id']}-{metadata['hash'][:12]}.json.zlib"
        if not target.exists():
            with tempfile.NamedTemporaryFile(dir=project_dir, delete=False) as temporary:
                temporary.write(zlib.compress(encoded, level=6))
                temporary_path = Path(temporary.name)
            os.replace(temporary_path, target)
        exports = sorted(project_dir.glob("*.json.zlib"), key=lambda path: path.stat().st_mtime, reverse=True)
        for stale in exports[self.retention :]:
            stale.unlink(missing_ok=True)

    def list(self, project_id: object) -> list[dict[str, Any]]:
        project = validate_project_id(project_id)
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM snapshots WHERE project_id = ? ORDER BY id DESC LIMIT ?",
                (project, self.retention),
            ).fetchall()
        return [self._metadata(row) for row in rows]

    def get(self, project_id: object, snapshot_id: object) -> dict[str, Any]:
        project = validate_project_id(project_id)
        if not isinstance(snapshot_id, int) or snapshot_id < 1:
            raise ValidationError("invalid snapshot id")
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM snapshots WHERE project_id = ? AND id = ?", (project, snapshot_id)
            ).fetchone()
        if row is None:
            raise SnapshotNotFound("snapshot not found")
        raw_payload = row["payload"]
        if row["payload_encoding"] == "zlib":
            raw_payload = zlib.decompress(bytes(raw_payload)).decode("utf-8")
        elif isinstance(raw_payload, bytes):
            raw_payload = raw_payload.decode("utf-8")
        return {**self._metadata(row), "payload": json.loads(raw_payload)}

    def record_activity(self, project_id: object, actor: object, reason: object = None) -> dict[str, Any]:
        project = validate_project_id(project_id)
        author = validate_optional_text(actor, "actor", 120)
        if author is None or not author.strip():
            raise ValidationError("actor is required")
        activity_reason = validate_optional_text(reason, "reason", 80)
        modified_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO project_activity(project_id, modified_at, actor, reason)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    modified_at = excluded.modified_at,
                    actor = excluded.actor,
                    reason = excluded.reason
                """,
                (project, modified_at, author.strip(), activity_reason),
            )
        return {"project_id": project, "modified_at": modified_at, "actor": author.strip(), "reason": activity_reason}

    def list_activity(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT project_id, modified_at, actor, reason FROM project_activity
                UNION ALL
                SELECT snapshots.project_id, snapshots.created_at, snapshots.actor, snapshots.reason
                FROM snapshots
                WHERE snapshots.id = (
                    SELECT MAX(latest.id) FROM snapshots AS latest
                    WHERE latest.project_id = snapshots.project_id
                )
                AND NOT EXISTS (
                    SELECT 1 FROM project_activity WHERE project_activity.project_id = snapshots.project_id
                )
                ORDER BY modified_at DESC
                """
            ).fetchall()
        return [
            {"project_id": row["project_id"], "modified_at": row["modified_at"], "actor": row["actor"], "reason": row["reason"]}
            for row in rows
        ]

    def healthcheck(self) -> None:
        with self._connect() as connection:
            connection.execute("SELECT 1").fetchone()


class AssetStore:
    def __init__(self, root: str | Path, max_file_bytes: int = DEFAULT_MAX_ASSET_BYTES,
                 max_project_bytes: int = DEFAULT_MAX_PROJECT_ASSET_BYTES) -> None:
        self.root = Path(root)
        self.max_file_bytes = max_file_bytes
        self.max_project_bytes = max_project_bytes
        if min(max_file_bytes, max_project_bytes) < 1 or max_file_bytes > max_project_bytes:
            raise ValueError("invalid asset quotas")
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, project_id: object, name: object) -> Path:
        project = validate_project_id(project_id)
        clean_name = validate_project_path(name)
        return self.root / project / clean_name

    def list(self, project_id: object) -> list[dict[str, Any]]:
        project = validate_project_id(project_id)
        project_dir = self.root / project
        if not project_dir.exists():
            return []
        return [{
            "path": path.relative_to(project_dir).as_posix(),
            "size_bytes": path.stat().st_size,
            "modified_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        } for path in sorted(project_dir.rglob("*")) if path.is_file()]

    def put(self, project_id: object, name: object, content: bytes) -> dict[str, Any]:
        if len(content) > self.max_file_bytes:
            raise ValidationError("asset is too large")
        validate_asset_content(name, content)
        target = self._path(project_id, name)
        project_dir = self.root / validate_project_id(project_id)
        current_size = target.stat().st_size if target.exists() else 0
        total = sum(path.stat().st_size for path in project_dir.rglob("*") if path.is_file()) if project_dir.exists() else 0
        if total - current_size + len(content) > self.max_project_bytes:
            raise ValidationError("project asset quota exceeded")
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
            temporary.write(content)
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, target)
        return {"path": validate_project_path(name), "size_bytes": len(content)}

    def get(self, project_id: object, name: object) -> bytes:
        target = self._path(project_id, name)
        if not target.is_file():
            raise SnapshotNotFound("asset not found")
        return target.read_bytes()

    def delete(self, project_id: object, name: object) -> None:
        target = self._path(project_id, name)
        if not target.is_file():
            raise SnapshotNotFound("asset not found")
        target.unlink()


class BackupHandler(BaseHTTPRequestHandler):
    store: BackupStore
    assets: AssetStore
    actor_mode = "shared"
    shared_actor = DEFAULT_SHARED_ACTOR

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        try:
            if path == "/health":
                self.store.healthcheck()
                self._json(HTTPStatus.OK, {"status": "ok"})
                return
            if ACTIVITY_COLLECTION_PATTERN.fullmatch(path):
                self._json(HTTPStatus.OK, {"projects": self.store.list_activity()})
                return
            if match := ASSET_COLLECTION_PATTERN.fullmatch(path):
                self._json(HTTPStatus.OK, {"assets": self.assets.list(match.group(1))})
                return
            if match := ASSET_ITEM_PATTERN.fullmatch(path):
                name = urllib.parse.unquote(match.group(2))
                content = self.assets.get(match.group(1), name)
                self._bytes(
                    HTTPStatus.OK,
                    content,
                    safe_asset_content_type(name, content),
                    name,
                )
                return
            if match := COLLECTION_PATTERN.fullmatch(path):
                self._json(HTTPStatus.OK, {"snapshots": self.store.list(match.group(1))})
                return
            if match := ITEM_PATTERN.fullmatch(path):
                self._json(HTTPStatus.OK, {"snapshot": self.store.get(match.group(1), int(match.group(2)))})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        except ValidationError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except SnapshotNotFound as error:
            self._json(HTTPStatus.NOT_FOUND, {"error": str(error)})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if activity_match := ACTIVITY_ITEM_PATTERN.fullmatch(path):
            try:
                payload = self._request_json()
                activity = self.store.record_activity(
                    activity_match.group(1), self._request_actor(), payload.get("reason")
                )
                self._json(HTTPStatus.OK, {"activity": activity})
            except ValidationError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        match = COLLECTION_PATTERN.fullmatch(path)
        if match is None:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            payload = self._request_json()
            metadata, deduplicated = self.store.create(
                match.group(1),
                payload.get("snapshot"),
                self._request_actor(),
                payload.get("reason"),
            )
            self._json(
                HTTPStatus.OK if deduplicated else HTTPStatus.CREATED,
                {"snapshot": metadata, "deduplicated": deduplicated},
            )
        except ValidationError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def do_PUT(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        match = ASSET_ITEM_PATTERN.fullmatch(path)
        if match is None:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            size = self._content_length(self.assets.max_file_bytes)
            metadata = self.assets.put(
                match.group(1), urllib.parse.unquote(match.group(2)), self.rfile.read(size)
            )
            self._json(HTTPStatus.CREATED, {"asset": metadata})
        except ValidationError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})

    def do_DELETE(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        match = ASSET_ITEM_PATTERN.fullmatch(path)
        try:
            if match is None:
                self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            self.assets.delete(match.group(1), urllib.parse.unquote(match.group(2)))
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
        except ValidationError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except SnapshotNotFound as error:
            self._json(HTTPStatus.NOT_FOUND, {"error": str(error)})

    def _content_length(self, maximum: int) -> int:
        try:
            size = int(self.headers.get("Content-Length", ""))
        except ValueError as error:
            raise ValidationError("invalid content length") from error
        if size < 0 or size > maximum:
            raise ValidationError("request is too large")
        return size

    def _request_json(self) -> dict[str, Any]:
        try:
            size = int(self.headers.get("Content-Length", ""))
        except ValueError as error:
            raise ValidationError("invalid content length") from error
        if size < 1 or size > MAX_REQUEST_BYTES:
            raise ValidationError("request is empty or too large")
        try:
            payload = json.loads(self.rfile.read(size))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValidationError("request body must be valid JSON") from error
        if not isinstance(payload, dict):
            raise ValidationError("request body must be an object")
        return payload

    def _request_actor(self) -> str:
        if self.actor_mode == "shared":
            actor = validate_optional_text(self.shared_actor, "shared actor", 120)
        elif self.actor_mode == "proxy":
            actor = validate_optional_text(
                self.headers.get(TRUSTED_ACTOR_HEADER), "trusted actor", 120
            )
        else:
            raise ValidationError("invalid actor mode")
        if actor is None or not actor.strip():
            raise ValidationError("trusted actor is required")
        return actor.strip()

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, status: HTTPStatus, body: bytes, content_type: str, name: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        filename = urllib.parse.quote(PurePosixPath(name).name, safe="")
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{filename}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_: object) -> None:
        return


def create_server() -> ThreadingHTTPServer:
    database_path = os.environ.get("BACKUP_DB_PATH", "/data/backups.sqlite3")
    try:
        retention = int(os.environ.get("BACKUP_RETENTION", str(DEFAULT_RETENTION)))
    except ValueError as error:
        raise ValueError("BACKUP_RETENTION must be an integer") from error
    BackupHandler.store = BackupStore(database_path, retention, os.environ.get("BACKUP_EXPORT_DIR"))
    BackupHandler.assets = AssetStore(
        os.environ.get("BACKUP_ASSET_DIR", "/data/assets"),
        int(os.environ.get("BACKUP_MAX_ASSET_BYTES", str(DEFAULT_MAX_ASSET_BYTES))),
        int(os.environ.get("BACKUP_MAX_PROJECT_ASSET_BYTES", str(DEFAULT_MAX_PROJECT_ASSET_BYTES))),
    )
    BackupHandler.actor_mode = os.environ.get("BACKUP_ACTOR_MODE", "shared").strip().lower()
    if BackupHandler.actor_mode not in {"shared", "proxy"}:
        raise ValueError("BACKUP_ACTOR_MODE must be shared or proxy")
    BackupHandler.shared_actor = os.environ.get("BACKUP_SHARED_ACTOR", DEFAULT_SHARED_ACTOR)
    return ThreadingHTTPServer(("0.0.0.0", 8010), BackupHandler)


if __name__ == "__main__":
    create_server().serve_forever()
