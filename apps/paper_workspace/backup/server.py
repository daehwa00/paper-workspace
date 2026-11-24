from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import urllib.parse
import zlib
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import import_module
from pathlib import Path, PurePosixPath
from typing import Any

# Support package imports, standalone container entrypoints and file-based callers.
package = __package__
if not package:
    package_directory = Path(__file__).resolve().parent
    sys.path.insert(0, str(package_directory.parent))
    package = package_directory.name

snapshot = import_module(".snapshot", package)
asset_store = import_module(".assets", package)
backup_store = import_module(".store", package)
project_allowlist = import_module(".project_allowlist", package)
BoundedHTTPServer = import_module(".backup_http", package).BoundedHTTPServer

# Keep the original server module's domain API as a compatibility entrypoint.
AssetStore = asset_store.AssetStore
BackupStore = backup_store.BackupStore
ProjectAllowlist = project_allowlist.ProjectAllowlist
allowed_project_ids = project_allowlist.allowed_project_ids
ALLOWED_ASSET_MIME_TYPES = snapshot.ALLOWED_ASSET_MIME_TYPES
DEFAULT_MAX_ASSET_BYTES = snapshot.DEFAULT_MAX_ASSET_BYTES
DEFAULT_MAX_PROJECT_ASSET_BYTES = snapshot.DEFAULT_MAX_PROJECT_ASSET_BYTES
DEFAULT_RETENTION = snapshot.DEFAULT_RETENTION
MAX_PROJECT_FILES = snapshot.MAX_PROJECT_FILES
MAX_SNAPSHOT_BYTES = snapshot.MAX_SNAPSHOT_BYTES
PROJECT_ID_PATTERN = snapshot.PROJECT_ID_PATTERN
MetadataConflict = snapshot.MetadataConflict
SnapshotNotFound = snapshot.SnapshotNotFound
ValidationError = snapshot.ValidationError
canonical_snapshot = snapshot.canonical_snapshot
decompress_snapshot_payload = snapshot.decompress_snapshot_payload
safe_asset_content_type = snapshot.safe_asset_content_type
validate_asset_content = snapshot.validate_asset_content
validate_optional_text = snapshot.validate_optional_text
validate_project_id = snapshot.validate_project_id
validate_project_path = snapshot.validate_project_path
validate_rebuttal_snapshot = snapshot.validate_rebuttal_snapshot

MAX_REQUEST_BYTES = 12_000_000
COLLECTION_PATTERN = re.compile(r"^/projects/([^/]+)/snapshots/?$")
ITEM_PATTERN = re.compile(r"^/projects/([^/]+)/snapshots/([1-9][0-9]*)/?$")
ACTIVITY_COLLECTION_PATTERN = re.compile(r"^/activity/?$")
ACTIVITY_ITEM_PATTERN = re.compile(r"^/projects/([^/]+)/activity/?$")
PROJECT_METADATA_PATTERN = re.compile(r"^/projects/([^/]+)/metadata/?$")
ASSET_COLLECTION_PATTERN = re.compile(r"^/projects/([^/]+)/assets/?$")
ASSET_ITEM_PATTERN = re.compile(r"^/projects/([^/]+)/assets/(.+)$")
DEFAULT_SHARED_ACTOR = "Shared user"
TRUSTED_ACTOR_HEADER = "X-Paper-Actor"


class BackupHandler(BaseHTTPRequestHandler):
    store: BackupStore
    assets: AssetStore
    actor_mode = "shared"
    shared_actor = DEFAULT_SHARED_ACTOR
    allowed_projects: set[str] | None = None
    project_allowlist: ProjectAllowlist | None = None

    def _allowed_projects(self) -> set[str] | None:
        allowed = self.project_allowlist.snapshot() if self.project_allowlist is not None else self.allowed_projects
        account_projects = self.headers.get("X-Paper-Allowed-Projects")
        if account_projects is not None:
            personal = set(filter(None, account_projects.split(",")))
            return personal if allowed is None else personal & allowed
        return allowed

    def _project_id(self, value: object) -> str:
        project = validate_project_id(value)
        allowed = self._allowed_projects()
        if allowed is not None and project not in allowed:
            raise SnapshotNotFound("project not found")
        return project

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        try:
            if path == "/health":
                self.store.healthcheck()
                self.assets.healthcheck()
                self._json(HTTPStatus.OK, {"status": "ok"})
                return
            if ACTIVITY_COLLECTION_PATTERN.fullmatch(path):
                allowed = self._allowed_projects()
                self._json(HTTPStatus.OK, {"projects": self.store.list_activity(allowed), "metadata": self.store.list_project_metadata(allowed)})
                return
            if match := PROJECT_METADATA_PATTERN.fullmatch(path):
                self._json(HTTPStatus.OK, {"metadata": self.store.project_metadata(self._project_id(match.group(1)))})
                return
            if match := ASSET_COLLECTION_PATTERN.fullmatch(path):
                self._json(HTTPStatus.OK, {"assets": self.assets.list(self._project_id(match.group(1)))})
                return
            if match := ASSET_ITEM_PATTERN.fullmatch(path):
                name = urllib.parse.unquote(match.group(2))
                content = self.assets.get(self._project_id(match.group(1)), name)
                self._bytes(
                    HTTPStatus.OK,
                    content,
                    safe_asset_content_type(name, content),
                    name,
                )
                return
            if match := COLLECTION_PATTERN.fullmatch(path):
                self._json(HTTPStatus.OK, {"snapshots": self.store.list(self._project_id(match.group(1)))})
                return
            if match := ITEM_PATTERN.fullmatch(path):
                self._json(HTTPStatus.OK, {"snapshot": self.store.get(self._project_id(match.group(1)), int(match.group(2)))})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        except ValidationError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except SnapshotNotFound as error:
            self._json(HTTPStatus.NOT_FOUND, {"error": str(error)})
        except (sqlite3.Error, OSError):
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "backup storage unavailable"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if activity_match := ACTIVITY_ITEM_PATTERN.fullmatch(path):
            try:
                payload = self._request_json()
                activity = self.store.record_activity(
                    self._project_id(activity_match.group(1)),
                    self._request_actor(payload.get("actor")),
                    payload.get("reason"),
                )
                self._json(HTTPStatus.OK, {"activity": activity})
            except ValidationError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            except SnapshotNotFound as error:
                self._json(HTTPStatus.NOT_FOUND, {"error": str(error)})
            except (sqlite3.Error, OSError):
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "backup storage unavailable"})
            return
        match = COLLECTION_PATTERN.fullmatch(path)
        if match is None:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            payload = self._request_json()
            metadata, deduplicated = self.store.create(
                self._project_id(match.group(1)),
                payload.get("snapshot"),
                self._request_actor(payload.get("actor")),
                payload.get("reason"),
            )
            self._json(
                HTTPStatus.OK if deduplicated else HTTPStatus.CREATED,
                {"snapshot": metadata, "deduplicated": deduplicated},
            )
        except ValidationError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except SnapshotNotFound as error:
            self._json(HTTPStatus.NOT_FOUND, {"error": str(error)})
        except (sqlite3.Error, OSError):
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "backup storage unavailable"})

    def do_PUT(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if metadata_match := PROJECT_METADATA_PATTERN.fullmatch(path):
            try:
                role = self.headers.get("X-Paper-Role")
                if role == "viewer" or self.actor_mode == "proxy" and role not in {"owner", "editor"}:
                    self._json(HTTPStatus.FORBIDDEN, {"error": "project edit access required"})
                    return
                project = self._project_id(metadata_match.group(1))
                payload = self._request_json()
                self._request_actor(payload.pop("actor", None))
                self._json(HTTPStatus.OK, {"metadata": self.store.update_project_metadata(project, payload)})
            except MetadataConflict as error:
                self._json(HTTPStatus.CONFLICT, {"error": str(error), "metadata": error.current})
            except ValidationError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            except SnapshotNotFound as error:
                self._json(HTTPStatus.NOT_FOUND, {"error": str(error)})
            except (sqlite3.Error, OSError):
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "backup storage unavailable"})
            return
        match = ASSET_ITEM_PATTERN.fullmatch(path)
        if match is None:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            size = self._content_length(self.assets.max_file_bytes)
            content = self.rfile.read(size)
            if len(content) != size:
                raise ValidationError("incomplete asset request")
            metadata = self.assets.put(
                self._project_id(match.group(1)), urllib.parse.unquote(match.group(2)), content
            )
            self._json(HTTPStatus.CREATED, {"asset": metadata})
        except ValidationError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except SnapshotNotFound as error:
            self._json(HTTPStatus.NOT_FOUND, {"error": str(error)})
        except (sqlite3.Error, OSError):
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "backup storage unavailable"})

    def do_DELETE(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        match = ASSET_ITEM_PATTERN.fullmatch(path)
        try:
            if match is None:
                self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            self.assets.delete(self._project_id(match.group(1)), urllib.parse.unquote(match.group(2)))
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
        except ValidationError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except SnapshotNotFound as error:
            self._json(HTTPStatus.NOT_FOUND, {"error": str(error)})
        except (sqlite3.Error, OSError):
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "backup storage unavailable"})

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

    def _request_actor(self, browser_actor: object = None) -> str:
        if self.actor_mode == "shared":
            actor = validate_optional_text(self.shared_actor, "shared actor", 120)
        elif self.actor_mode == "display":
            actor = validate_optional_text(browser_actor, "display actor", 120)
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
    class ConfiguredBackupHandler(BackupHandler):
        pass

    database_path = os.environ.get("BACKUP_DB_PATH", "/data/backups.sqlite3")
    try:
        retention = int(os.environ.get("BACKUP_RETENTION", str(DEFAULT_RETENTION)))
    except ValueError as error:
        raise ValueError("BACKUP_RETENTION must be an integer") from error
    ConfiguredBackupHandler.store = BackupStore(database_path, retention, os.environ.get("BACKUP_EXPORT_DIR"))
    ConfiguredBackupHandler.assets = AssetStore(
        os.environ.get("BACKUP_ASSET_DIR", "/data/assets"),
        int(os.environ.get("BACKUP_MAX_ASSET_BYTES", str(DEFAULT_MAX_ASSET_BYTES))),
        int(os.environ.get("BACKUP_MAX_PROJECT_ASSET_BYTES", str(DEFAULT_MAX_PROJECT_ASSET_BYTES))),
    )
    ConfiguredBackupHandler.actor_mode = os.environ.get("BACKUP_ACTOR_MODE", "shared").strip().lower()
    if ConfiguredBackupHandler.actor_mode not in {"shared", "display", "proxy"}:
        raise ValueError("BACKUP_ACTOR_MODE must be shared, display, or proxy")
    ConfiguredBackupHandler.shared_actor = os.environ.get("BACKUP_SHARED_ACTOR", DEFAULT_SHARED_ACTOR)
    runtime_root = os.environ.get("BACKUP_PROJECT_RUNTIME", "").strip()
    ConfiguredBackupHandler.project_allowlist = ProjectAllowlist(runtime_root) if runtime_root else None
    ConfiguredBackupHandler.allowed_projects = ConfiguredBackupHandler.project_allowlist.snapshot() if ConfiguredBackupHandler.project_allowlist else None
    return BoundedHTTPServer((os.environ.get("BACKUP_HOST", "0.0.0.0"), int(os.environ.get("BACKUP_PORT", "8010"))), ConfiguredBackupHandler)


if __name__ == "__main__":
    create_server().serve_forever()
