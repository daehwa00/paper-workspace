"""Shared validation for project library readers."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from pathlib import Path, PurePosixPath

SLUG_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_RUNTIME_FILE_BYTES = 64 * 1024 * 1024


def safe_relative(value: object) -> Path:
    if not isinstance(value, str) or not value or len(value) > 240 or "\\" in value:
        raise ValueError("invalid project manifest path")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("invalid project manifest path")
    path = PurePosixPath(value)
    if path.is_absolute() or len(path.parts) > 12 or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("invalid project manifest path")
    if any(part.startswith(".") for part in path.parts):
        raise ValueError("hidden project paths are not publishable")
    return Path(*path.parts)


def read_json_object(path: Path) -> tuple[dict[str, object], bytes]:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as handle:
        metadata = os.fstat(handle.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_MANIFEST_BYTES:
            raise ValueError(f"invalid JSON manifest: {path}")
        raw = handle.read(MAX_MANIFEST_BYTES + 1)
    if len(raw) > MAX_MANIFEST_BYTES:
        raise ValueError(f"invalid JSON manifest: {path}")
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"expected a JSON object in {path}")
    return payload, raw


def checked_source(root: Path, relative: Path, *, max_bytes: int = MAX_RUNTIME_FILE_BYTES) -> Path:
    candidate = root / relative
    current = root
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f"invalid project root: {root}")
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"project symlinks are not publishable: {relative.as_posix()}")
    if not candidate.is_file():
        raise ValueError(f"manifest file is missing: {relative.as_posix()}")
    size = candidate.stat().st_size
    if size > max_bytes:
        raise ValueError(f"manifest file is too large: {relative.as_posix()}")
    return candidate


def read_object(path: Path) -> dict[str, object]:
    return read_json_object(path)[0]


def file_digest(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()
