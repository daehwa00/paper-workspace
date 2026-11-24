"""SQLite snapshot, metadata and activity storage."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .snapshot import (
    DEFAULT_RETENTION, MetadataConflict, SnapshotNotFound, ValidationError,
    canonical_snapshot, decompress_snapshot_payload, validate_optional_text, validate_project_id,
)
from .backup_files import write_atomic


class BackupStore:
    def __init__(self, database_path: str | Path, retention: int = DEFAULT_RETENTION, export_dir: str | Path | None = None) -> None:
        if not 1 <= retention <= 1000:
            raise ValueError("retention must be between 1 and 1000")
        self.database_path = Path(database_path)
        self.retention = retention
        self.export_dir = Path(export_dir) if export_dir else None
        self._lock = threading.RLock()
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        if self.export_dir:
            self.export_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
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
            connection.execute("""CREATE TABLE IF NOT EXISTS project_metadata (
                project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL
            )""")

    def project_metadata(self, project_id):
        project = validate_project_id(project_id)
        with self._connect() as connection:
            row = connection.execute("SELECT revision,data FROM project_metadata WHERE project_id=?", (project,)).fetchone()
        return {"project_id": project, "revision": row["revision"] if row else 0,
                "values": json.loads(row["data"]) if row else {}}

    def list_project_metadata(self, allowed=None):
        with self._connect() as connection:
            rows = connection.execute("SELECT project_id,revision,data FROM project_metadata ORDER BY project_id").fetchall()
        return [{"project_id": row["project_id"], "revision": row["revision"], "values": json.loads(row["data"])}
                for row in rows if allowed is None or row["project_id"] in allowed]

    def update_project_metadata(self, project_id, payload):
        project = validate_project_id(project_id)
        if not isinstance(payload, dict) or set(payload) != {"expected_revision", "changes"}:
            raise ValidationError("invalid project metadata request")
        revision, changes = payload["expected_revision"], payload["changes"]
        if type(revision) is not int or revision < 0 or not isinstance(changes, dict) or not changes or set(changes) - {"venue", "description"}:
            raise ValidationError("invalid project metadata fields")
        for field, value in changes.items():
            validate_optional_text(value, field, 80 if field == "venue" else 500)
            if isinstance(value, str) and value != value.strip():
                raise ValidationError("metadata text must be trimmed")
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT revision,data FROM project_metadata WHERE project_id=?", (project,)).fetchone()
            current = {"project_id": project, "revision": row["revision"] if row else 0,
                       "values": json.loads(row["data"]) if row else {}}
            if revision != current["revision"]:
                raise MetadataConflict(current)
            values = dict(current["values"])
            for field, value in changes.items():
                if value is None:
                    values.pop(field, None)
                else:
                    values[field] = value
            if values == current["values"]:
                return current
            next_revision = revision + 1
            connection.execute("INSERT INTO project_metadata VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
                               (project, next_revision, json.dumps(values, ensure_ascii=False)))
        return {"project_id": project, "revision": next_revision, "values": values}

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
        with self._lock:
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
                        """
                        UPDATE snapshots
                        SET checked_at = ?, actor = ?, reason = ?
                        WHERE project_id = ? AND content_hash = ?
                        """,
                        (created_at, author, backup_reason, project, digest),
                    )
                    existing = connection.execute(
                        "SELECT * FROM snapshots WHERE project_id = ? AND content_hash = ?", (project, digest)
                    ).fetchone()
                    assert existing is not None
                    metadata = self._metadata(existing)
                    deduplicated = True
                else:
                    snapshot_id = cursor.lastrowid
                    row = connection.execute("SELECT * FROM snapshots WHERE id = ?", (snapshot_id,)).fetchone()
                    assert row is not None
                    metadata = self._metadata(row)
                    deduplicated = False
                retained_ids = {
                    row["id"]
                    for row in connection.execute(
                        """
                        SELECT id FROM snapshots WHERE project_id = ?
                        ORDER BY COALESCE(checked_at, created_at) DESC, id DESC LIMIT ?
                        """,
                        (project, self.retention),
                    )
                }
                self._export(project, metadata, encoded, retained_ids)
                connection.execute(
                    "DELETE FROM snapshots WHERE project_id = ? AND id NOT IN ("
                    "SELECT id FROM snapshots WHERE project_id = ? "
                    "ORDER BY COALESCE(checked_at, created_at) DESC, id DESC LIMIT ?)",
                    (project, project, self.retention),
                )
            self._prune_exports(project)
        return metadata, deduplicated

    def _export(
        self,
        project: str,
        metadata: dict[str, Any],
        encoded: bytes,
        retained_ids: set[int],
    ) -> None:
        if self.export_dir is None or metadata["id"] not in retained_ids:
            return
        project_dir = self.export_dir / project
        project_dir.mkdir(parents=True, exist_ok=True)
        target = project_dir / f"{metadata['id']}-{metadata['hash'][:12]}.json.zlib"
        if not target.exists():
            write_atomic(target, zlib.compress(encoded, level=6))

    def _prune_exports(self, project: str) -> None:
        if self.export_dir is None:
            return
        # Re-read the committed set while holding SQLite's writer lock. Another
        # process can publish a newer export after create() commits its rows.
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            retained = connection.execute(
                "SELECT id, content_hash FROM snapshots WHERE project_id = ?", (project,)
            )
            names = {f"{row['id']}-{row['content_hash'][:12]}.json.zlib" for row in retained}
            for export in (self.export_dir / project).glob("*.json.zlib"):
                if export.name not in names:
                    export.unlink(missing_ok=True)

    def list(self, project_id: object) -> list[dict[str, Any]]:
        project = validate_project_id(project_id)
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT id, project_id, created_at, checked_at, content_hash,
                          actor, reason, size_bytes
                   FROM snapshots WHERE project_id = ?
                   ORDER BY COALESCE(checked_at, created_at) DESC, id DESC LIMIT ?""",
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
        raw_payload = bytes(row["payload"]) if isinstance(row["payload"], (bytes, bytearray, memoryview)) else str(row["payload"]).encode("utf-8")
        if row["payload_encoding"] == "zlib":
            raw_payload = decompress_snapshot_payload(raw_payload)
        elif row["payload_encoding"] != "json":
            raise ValidationError("stored snapshot encoding is unsupported")
        if len(raw_payload) != row["size_bytes"] or hashlib.sha256(raw_payload).hexdigest() != row["content_hash"]:
            raise ValidationError("stored snapshot integrity check failed")
        try:
            payload = json.loads(raw_payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValidationError("stored snapshot JSON is invalid") from error
        canonical_snapshot(payload)
        return {**self._metadata(row), "payload": payload}

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

    def list_activity(self, allowed_projects: set[str] | None = None) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT project_id, modified_at, actor, reason FROM project_activity
                UNION ALL
                SELECT snapshots.project_id, COALESCE(snapshots.checked_at, snapshots.created_at), snapshots.actor, snapshots.reason
                FROM snapshots
                WHERE snapshots.id = (
                    SELECT latest.id FROM snapshots AS latest
                    WHERE latest.project_id = snapshots.project_id
                    ORDER BY COALESCE(latest.checked_at, latest.created_at) DESC, latest.id DESC
                    LIMIT 1
                )
                AND NOT EXISTS (
                    SELECT 1 FROM project_activity WHERE project_activity.project_id = snapshots.project_id
                )
                ORDER BY modified_at DESC
                """
            ).fetchall()
        return [
            {"project_id": row["project_id"], "modified_at": row["modified_at"], "actor": row["actor"], "reason": row["reason"]}
            for row in rows if allowed_projects is None or row["project_id"] in allowed_projects
        ]

    def healthcheck(self) -> None:
        with self._connect() as connection:
            connection.execute("SELECT 1").fetchone()
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("UPDATE project_activity SET reason = reason WHERE 0")
            connection.rollback()
