from __future__ import annotations

import gzip
import hmac
import io
import os
import re
from pathlib import Path, PurePosixPath

from .validation import FRAGMENT_WRAPPER, safe_project_path

MAX_SYNCTEX_BYTES = 8_000_000
MAX_SYNCTEX_EXPANDED_BYTES = 64_000_000
_INPUT_LINE = re.compile(rb"^(Input:\d+:)(.*?)(\r?\n)?$")


def expanded_synctex(data: bytes, *, compressed_limit=MAX_SYNCTEX_BYTES, expanded_limit=MAX_SYNCTEX_EXPANDED_BYTES) -> bytes:
    if len(data) > compressed_limit:
        raise ValueError("SyncTeX data is too large")
    if not data.startswith(b"\x1f\x8b"):
        raise ValueError("SyncTeX data is not gzip encoded")
    expanded = 0
    output = io.BytesIO()
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
            while chunk := stream.read(65_536):
                expanded += len(chunk)
                if expanded > expanded_limit:
                    raise ValueError("SyncTeX expanded data is too large")
                output.write(chunk)
    except (EOFError, OSError) as error:
        raise ValueError("SyncTeX data is invalid") from error
    return output.getvalue()


def validated_synctex(data: bytes) -> bytes:
    expanded_synctex(data)
    return data


def normalized_synctex(
    data: bytes, work: Path, project_tex_paths: set[str] | frozenset[str], *,
    compressed_limit=MAX_SYNCTEX_BYTES, expanded_limit=MAX_SYNCTEX_EXPANDED_BYTES,
    mask_unmapped=False,
) -> bytes:
    """Replace ephemeral compile roots with validated project-relative paths."""
    expanded = expanded_synctex(data, compressed_limit=compressed_limit, expanded_limit=expanded_limit)
    root = work.resolve()
    allowed = {safe_project_path(path, {".tex"}).as_posix() for path in project_tex_paths}
    normalized = io.BytesIO()
    with gzip.GzipFile(fileobj=normalized, mode="wb", compresslevel=6, mtime=0) as output:
        for line in io.BytesIO(expanded):
            match = _INPUT_LINE.match(line)
            if match:
                source = Path(os.fsdecode(match.group(2)))
                try:
                    relative = (root / source).resolve(strict=False).relative_to(root).as_posix()
                except ValueError:
                    relative = ""
                if relative in allowed:
                    line = match.group(1) + os.fsencode(relative) + (match.group(3) or b"")
                elif mask_unmapped:
                    tag = match.group(1).split(b":")[1]
                    line = match.group(1) + b"/__compiler_unmapped__/" + tag + (match.group(3) or b"")
            output.write(line)
    result = normalized.getvalue()
    if len(result) > compressed_limit:
        raise ValueError("SyncTeX data is too large")
    return result


def synctex_source_path(value: str, work: Path, project_paths: frozenset[str] | None = None) -> str:
    source = Path(value.rstrip("\r"))
    if source.is_absolute():
        if project_paths is not None:
            raise ValueError("SyncTeX source is outside the project")
        try:
            relative = source.resolve(strict=False).relative_to(work.resolve()).as_posix()
        except ValueError as error:
            parts = PurePosixPath(source.as_posix()).parts
            if len(parts) < 4 or parts[1] != "tmp" or not re.fullmatch(r"tmp[a-z0-9_]{8}", parts[2]):
                raise ValueError("SyncTeX source is outside the project") from error
            relative = PurePosixPath(*parts[3:]).as_posix()
    else:
        relative = source.as_posix()
    safe = safe_project_path(relative, {".tex"})
    relative = safe.as_posix()
    if FRAGMENT_WRAPPER in safe.parts or (project_paths is not None and relative not in project_paths):
        raise ValueError("SyncTeX source was not submitted with this project")
    return relative


_COMMENT_PREFIX = b"paper-sync-v1:"
_SIGNATURE_END = 10 + len(_COMMENT_PREFIX) + 64


def _signature(data: bytes, actor: str, key: bytes) -> bytes:
    digest = hmac.new(key, actor.encode() + b"\0", "sha256")
    digest.update(data)
    return digest.hexdigest().encode("ascii")


def sign_synctex(data: bytes, actor: str, key: bytes) -> bytes:
    """Store authentication in a standard gzip comment so SyncTeX can still read it."""
    if data[:4] != b"\x1f\x8b\x08\0":
        raise ValueError("SyncTeX gzip header is invalid")
    return (
        data[:3] + b"\x10" + data[4:10] + _COMMENT_PREFIX
        + _signature(data, actor, key) + b"\0" + data[10:]
    )


def verify_synctex(data: bytes, actor: str, key: bytes) -> bytes:
    if (
        data[:4] != b"\x1f\x8b\x08\x10"
        or not data.startswith(_COMMENT_PREFIX, 10)
        or data[_SIGNATURE_END:_SIGNATURE_END + 1] != b"\0"
    ):
        raise ValueError("SyncTeX cache expired; render the PDF again.")
    unsigned = data[:3] + b"\0" + data[4:10] + data[_SIGNATURE_END + 1:]
    signature = data[10 + len(_COMMENT_PREFIX):_SIGNATURE_END]
    if not hmac.compare_digest(signature, _signature(unsigned, actor, key)):
        raise ValueError("SyncTeX cache expired; render the PDF again.")
    return unsigned


def project_paths(expanded: bytes) -> frozenset[str]:
    """Read project paths from a verified bundle with non-project inputs masked."""
    paths = set()
    for line in io.BytesIO(expanded):
        match = _INPUT_LINE.match(line)
        if match:
            source = os.fsdecode(match.group(2))
            if not source.startswith("/"):
                paths.add(safe_project_path(source, {".tex"}).as_posix())
    return frozenset(paths)


def reverse_location(result, work: Path, paths: frozenset[str]) -> dict[str, str | int] | None:
    """Pick the first reverse mapping associated with an editable source."""
    if result.returncode:
        return None
    for entry in re.split(r"^Input:", result.stdout + "\n" + result.stderr, flags=re.MULTILINE)[1:]:
        source, _, fields = entry.partition("\n")
        line = re.search(r"^Line:(\d+)$", fields, re.MULTILINE)
        if not line:
            continue
        try:
            file = synctex_source_path(source, work, paths)
        except ValueError:
            continue
        column = re.search(r"^Column:(-?\d+)$", fields, re.MULTILINE)
        return {"file": file, "line": int(line[1]), "column": max(0, int(column[1])) if column else 0}
    return None
