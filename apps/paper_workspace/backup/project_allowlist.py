"""Refresh the trusted runtime project scope."""
from __future__ import annotations

import json
import threading
from pathlib import Path

from .snapshot import validate_project_id


def allowed_project_ids(runtime_root: str | Path) -> set[str]:
    root = Path(runtime_root)
    catalog = json.loads((root / "projects/index.json").read_text(encoding="utf-8"))
    projects = catalog.get("projects") if isinstance(catalog, dict) else None
    if not isinstance(projects, list):
        raise ValueError("project runtime catalog is invalid")
    allowed: set[str] = set()
    default_manifest = json.loads((root / "project/project.json").read_text(encoding="utf-8"))
    default_id = validate_project_id(default_manifest.get("id"))
    allowed.add(default_id)
    for entry in projects:
        if not isinstance(entry, dict):
            raise ValueError("project runtime catalog entry is invalid")
        slug = validate_project_id(entry.get("slug"))
        allowed.add(slug)
        if entry.get("activity_id") is not None:
            allowed.add(validate_project_id(entry["activity_id"]))
        if entry.get("source") == "default":
            allowed.add(default_id)
            continue
        manifest_path = root / "projects" / slug / "project.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            raise ValueError("project runtime manifest is invalid")
        allowed.add(validate_project_id(manifest.get("id")))
    return allowed


class ProjectAllowlist:
    """Reload the trusted runtime catalog after its atomic replacement."""

    def __init__(self, runtime_root: str | Path) -> None:
        self.runtime_root = Path(runtime_root)
        self._lock = threading.RLock()
        self._signature = None
        self._allowed: set[str] = set()
        self._refresh()

    def _refresh(self) -> None:
        catalog = self.runtime_root / "projects/index.json"
        try:
            stat = catalog.stat()
            signature = (stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_size)
            try:
                generation = (self.runtime_root / ".fingerprint").stat()
                signature += (generation.st_ino, generation.st_mtime_ns)
            except FileNotFoundError:
                pass
            if signature == self._signature:
                return
            allowed = allowed_project_ids(self.runtime_root)
        except FileNotFoundError:
            # Keep the last complete generation and retry on the next request.
            return
        self._allowed = allowed
        self._signature = signature

    def snapshot(self) -> set[str]:
        with self._lock:
            self._refresh()
            return set(self._allowed)

    def contains(self, project: str) -> bool:
        return project in self.snapshot()
