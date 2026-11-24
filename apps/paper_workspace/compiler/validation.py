from __future__ import annotations

import base64
import json
import stat
from pathlib import Path, PurePosixPath

SOURCE_EXTENSIONS = {".tex", ".bib", ".sty", ".bst", ".cls", ".csv", ".txt", ".json", ".dat"}
ASSET_EXTENSIONS = {".png", ".jpg", ".jpeg", ".pdf", ".eps"}
MAX_REQUEST_BYTES = 48_000_000
# Bound staging cost rather than rejecting a project solely by file count.
MAX_PROJECT_WORKSPACE_BYTES = 64_000_000
PROJECT_ENTRY_OVERHEAD_BYTES = 4096
MAX_ASSET_BYTES = 32_000_000

FRAGMENT_WRAPPER = "__fragment_preview.tex"


def safe_project_path(name: object, extensions: set[str]) -> Path:
    if not isinstance(name, str) or not name or len(name) > 240:
        raise ValueError("invalid project path")
    path = PurePosixPath(name)
    if path.is_absolute() or len(path.parts) > 12 or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("invalid project path")
    if any(not all(character.isalnum() or character in "._- ()" for character in part) for part in path.parts):
        raise ValueError("unsupported character in project path")
    if any(len(part.encode("utf-8")) > 255 for part in path.parts):
        raise ValueError("project path component is too long")
    if path.suffix.lower() not in extensions:
        raise ValueError(f"unsupported project file: {name}")
    return Path(*path.parts)


def validated_project_paths(files: dict, assets: object, request_bytes: int, *, budget: int = MAX_PROJECT_WORKSPACE_BYTES, path_validator=safe_project_path, reserved_names: frozenset[str] = frozenset()) -> tuple[dict[str, Path], dict[str, Path]]:
    """Reserve request bytes plus conservative filesystem-entry overhead.

    JSON/base64 request bytes bound decoded source and asset bytes from above.
    Counting distinct directories also bounds deeply nested, tiny-file projects.
    The 64 MB input budget leaves room for TeX output in the 256 MB tmpfs shared
    by the default two compile slots.
    """
    if not isinstance(assets, dict):
        raise ValueError("project assets must be an object")
    reserved = request_bytes + (len(files) + len(assets)) * PROJECT_ENTRY_OVERHEAD_BYTES
    if reserved > budget:
        raise ValueError("project exceeds compiler workspace budget")
    directories = {Path(".")}
    sources: dict[str, Path] = {}
    binaries: dict[str, Path] = {}
    submitted: set[Path] = set()
    reserved_names = reserved_names | {FRAGMENT_WRAPPER}
    for entries, extensions, paths in ((files, SOURCE_EXTENSIONS, sources), (assets, ASSET_EXTENSIONS, binaries)):
        for name in entries:
            path = path_validator(name, extensions)
            if any(part in reserved_names for part in path.parts):
                raise ValueError(f"reserved project path: {name}")
            if path in submitted:
                raise ValueError(f"duplicate normalized project path: {name}")
            if path in directories:
                raise ValueError(f"project file conflicts with directory: {name}")
            submitted.add(path)
            for parent in path.parents:
                if parent in submitted:
                    raise ValueError(f"project file conflicts with directory: {parent}")
                if parent not in directories:
                    directories.add(parent)
                    reserved += PROJECT_ENTRY_OVERHEAD_BYTES
                    if reserved > budget:
                        raise ValueError("project exceeds compiler workspace budget")
            paths[name] = path
    return sources, binaries


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate request key: {key}")
        result[key] = value
    return result


def load_payload(raw: bytes) -> dict:
    payload = json.loads(raw, object_pairs_hook=_unique_object)
    if not isinstance(payload, dict):
        raise ValueError("request must be an object")
    return payload


def base64_size(content: object, label: str) -> int:
    if not isinstance(content, str) or not content.isascii() or len(content) % 4:
        raise ValueError(f"invalid {label} base64")
    padding = 2 if content.endswith("==") else int(content.endswith("="))
    return len(content) // 4 * 3 - padding


def decode_base64(content: object, limit: int, label: str) -> bytes:
    if base64_size(content, label) > limit:
        raise ValueError(f"{label} exceeds size limit")
    return base64.b64decode(content, validate=True)


def validate_asset_budget(assets: dict, limit: int) -> None:
    total = 0
    for content in assets.values():
        total += base64_size(content, "asset")
        if total > limit:
            raise ValueError("assets exceed size limit")


def decode_assets(assets: dict, limit: int) -> dict[str, bytes]:
    validate_asset_budget(assets, limit)
    return {name: base64.b64decode(content, validate=True) for name, content in assets.items()}


def read_bounded(path: Path, limit: int, label: str) -> bytes:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{label} is not a regular file")
    if metadata.st_size > limit:
        raise ValueError(f"{label} exceeds size limit")
    with path.open("rb") as stream:
        data = stream.read(metadata.st_size + 1)
    if len(data) > metadata.st_size:
        raise ValueError(f"{label} exceeds size limit")
    return data
