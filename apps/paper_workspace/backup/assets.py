"""Quota-bound project asset storage."""
from __future__ import annotations

import errno
import hashlib
import os
import re
import tempfile
import threading
import weakref
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .snapshot import (
    DEFAULT_MAX_ASSET_BYTES, DEFAULT_MAX_PROJECT_ASSET_BYTES, SnapshotNotFound,
    ValidationError, validate_asset_content, validate_project_id, validate_project_path,
)
from .backup_files import write_atomic


class AssetStore:
    def __init__(self, root: str | Path, max_file_bytes: int = DEFAULT_MAX_ASSET_BYTES,
                 max_project_bytes: int = DEFAULT_MAX_PROJECT_ASSET_BYTES) -> None:
        self.root = Path(root)
        self.max_file_bytes = max_file_bytes
        self.max_project_bytes = max_project_bytes
        if min(max_file_bytes, max_project_bytes) < 1 or max_file_bytes > max_project_bytes:
            raise ValueError("invalid asset quotas")
        self._lock = threading.Lock()
        self._project_locks = weakref.WeakValueDictionary()
        self.root.mkdir(parents=True, exist_ok=True)

    def healthcheck(self) -> None:
        if self.root.is_symlink() or not self.root.is_dir():
            raise OSError("asset store is unavailable")
        with tempfile.NamedTemporaryFile(prefix=".health-", dir=self.root) as probe:
            probe.write(b"ok")
            probe.flush()
            os.fsync(probe.fileno())

    def _project_lock(self, project: str):
        with self._lock:
            lock = self._project_locks.get(project)
            if lock is None:
                lock = threading.RLock()
                self._project_locks[project] = lock
            return lock

    def _path(self, project_id: object, name: object) -> Path:
        project = validate_project_id(project_id)
        clean_name = validate_project_path(name)
        root = self.root.resolve()
        target = self.root / project / clean_name
        try:
            target.resolve(strict=False).relative_to(root)
        except ValueError as error:
            raise ValidationError("asset path escapes the storage root") from error
        cursor = target
        while True:
            if cursor.is_symlink():
                raise ValidationError("symbolic links are not allowed in asset storage")
            if cursor == self.root:
                break
            cursor = cursor.parent
        return target

    def list(self, project_id: object) -> list[dict[str, Any]]:
        project = validate_project_id(project_id)
        with self._project_lock(project):
            project_dir = self._path(project, "__inventory__.pdf").parent
            if not project_dir.exists():
                return []
            return [{
                "path": path.relative_to(project_dir).as_posix(),
                "size_bytes": path.stat().st_size,
                "modified_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            } for path in sorted(project_dir.rglob("*")) if path.is_file() and not path.is_symlink()]

    def put(self, project_id: object, name: object, content: bytes) -> dict[str, Any]:
        if len(content) > self.max_file_bytes:
            raise ValidationError("asset is too large")
        validate_asset_content(name, content)
        if isinstance(name, str) and name.startswith('rebuttal/sources/'):
            expected = re.fullmatch(r'rebuttal/sources/([0-9a-f]{64})\.pdf', name)
            if not expected or hashlib.sha256(content).hexdigest() != expected[1]:
                raise ValidationError("review source must use its content hash")
        project = validate_project_id(project_id)
        project_dir = self.root / project
        with self._project_lock(project):
            target = self._path(project, name)
            current_size = target.stat().st_size if target.exists() else 0
            total = sum(path.stat().st_size for path in project_dir.rglob("*") if not path.is_symlink() and path.is_file()) if project_dir.exists() else 0
            if total - current_size + len(content) > self.max_project_bytes:
                raise ValidationError("project asset quota exceeded")
            target.parent.mkdir(parents=True, exist_ok=True)
            write_atomic(target, content)
        return {"path": validate_project_path(name), "size_bytes": len(content)}

    def get(self, project_id: object, name: object) -> bytes:
        project = validate_project_id(project_id)
        with self._project_lock(project):
            target = self._path(project, name)
            if not target.is_file():
                raise SnapshotNotFound("asset not found")
            return target.read_bytes()

    def delete(self, project_id: object, name: object) -> None:
        if isinstance(name, str) and name.startswith('rebuttal/sources/'):
            raise ValidationError("immutable review sources cannot be deleted individually")
        project = validate_project_id(project_id)
        with self._project_lock(project):
            target = self._path(project, name)
            if not target.is_file():
                raise SnapshotNotFound("asset not found")
            target.unlink()
            for parent in target.parents:
                if parent == self.root:
                    break
                try:
                    parent.rmdir()
                except OSError as error:
                    if error.errno in {errno.ENOTEMPTY, errno.EEXIST}:
                        break
                    raise
