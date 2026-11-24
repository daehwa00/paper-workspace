"""Snapshot, project path and asset content validation."""
from __future__ import annotations

import json
import re
import zlib
from pathlib import Path, PurePosixPath
from typing import Any

MAX_SNAPSHOT_BYTES = 10_000_000
MAX_PROJECT_FILES = 240
DEFAULT_RETENTION = 50
PROJECT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
DEFAULT_MAX_ASSET_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_PROJECT_ASSET_BYTES = 128 * 1024 * 1024
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


class MetadataConflict(ValueError):
    def __init__(self, current):
        self.current = current
        super().__init__("project metadata changed")


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
    rebuttal = snapshot.get("rebuttal")
    if rebuttal is not None:
        validate_rebuttal_snapshot(rebuttal)
    try:
        encoded = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ValidationError("snapshot must contain JSON values") from error
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        raise ValidationError("snapshot is too large")
    # Decode the canonical representation so callers cannot mutate the stored value
    # through a reference retained from the request object.
    return json.loads(encoded), encoded


def validate_rebuttal_snapshot(value: object) -> None:
    """Keep domain snapshots bounded and never persist connection credentials."""
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise ValidationError("invalid rebuttal snapshot version")
    rounds = value.get("rounds")
    texts = value.get("texts", {})
    if not isinstance(rounds, list) or len(rounds) > 100 or not all(isinstance(item, dict) for item in rounds):
        raise ValidationError("invalid rebuttal rounds")
    if not isinstance(texts, dict) or len(texts) > 1000 or any(
        not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,240}", key)
        or not isinstance(text, str) for key, text in texts.items()
    ):
        raise ValidationError("invalid rebuttal response texts")
    forbidden = {"password", "access_token", "refresh_token", "mfaPendingToken", "mfa_pending_token", "openreview_token", "connection_id", "session_cookie"}
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            if forbidden.intersection(item):
                raise ValidationError("rebuttal credentials cannot enter a backup")
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)


def decompress_snapshot_payload(payload: bytes) -> bytes:
    try:
        decompressor = zlib.decompressobj()
        decoded = decompressor.decompress(payload, MAX_SNAPSHOT_BYTES + 1)
        if len(decoded) > MAX_SNAPSHOT_BYTES or decompressor.unconsumed_tail:
            raise ValidationError("stored snapshot expands beyond the size limit")
        decoded += decompressor.flush(MAX_SNAPSHOT_BYTES + 1 - len(decoded))
        if len(decoded) > MAX_SNAPSHOT_BYTES or not decompressor.eof or decompressor.unused_data:
            raise ValidationError("stored snapshot is truncated or invalid")
        return decoded
    except zlib.error as error:
        raise ValidationError("stored snapshot compression is invalid") from error


def validate_optional_text(value: object, field: str, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > maximum or any(ord(character) < 32 for character in value):
        raise ValidationError(f"invalid {field}")
    return value


def validate_asset_content(name: object, content: bytes) -> str:
    clean_name = validate_project_path(name)
    if clean_name == "__paper_workspace/main-page-count.json":
        try:
            if len(content) > 1024:
                raise ValueError("metadata is too large")
            metadata = json.loads(content)
            if not isinstance(metadata, dict) or set(metadata) != {"page_count", "entrypoint"}:
                raise ValueError("invalid metadata fields")
            count = metadata["page_count"]
            if type(count) is not int or not 1 <= count <= 1000:
                raise ValueError("invalid page count")
            if not validate_project_path(metadata["entrypoint"]).endswith(".tex"):
                raise ValueError("invalid entrypoint")
        except (ValueError, TypeError, UnicodeDecodeError) as error:
            raise ValidationError("invalid main document page metadata") from error
        return "application/json"
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
