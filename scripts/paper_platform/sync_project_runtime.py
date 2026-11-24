#!/usr/bin/env python3
"""Publish only manifest-listed project files into the web runtime volume."""

from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import sys
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path


if __package__:
    from .runtime_common import (
        SLUG_PATTERN, MAX_MANIFEST_BYTES, MAX_RUNTIME_FILE_BYTES,
        checked_source, file_digest, read_json_object, read_object, safe_relative,
    )
else:
    sys.path.insert(0, str(Path(__file__).parent))
    from runtime_common import (
        SLUG_PATTERN, MAX_MANIFEST_BYTES, MAX_RUNTIME_FILE_BYTES,
        checked_source, file_digest, read_json_object, read_object, safe_relative,
    )

MAX_RUNTIME_FILES = 240
MAX_RUNTIME_PROJECT_BYTES = 512 * 1024 * 1024
AUTO_ASSET_EXTENSIONS = (".pdf", ".png", ".jpg", ".jpeg", ".eps")
AUTO_TEXT_EXTENSIONS = {".bib", ".bst", ".cls", ".csv", ".dat", ".json", ".sty", ".tex", ".txt"}
AUTO_EXTENSIONS = set(AUTO_ASSET_EXTENSIONS) | AUTO_TEXT_EXTENSIONS
INPUT_PATTERN = re.compile(r"\\(?:input|include)\{([^{}]+)\}")
GRAPHICS_PATTERN = re.compile(r"\\includegraphics(?:\[[^\]]*\])?\{([^{}]+)\}")
PREVIEW_FIELDS = ("preview_pdf", "preview_synctex")


def declared_source_exists(root: Path, relative: Path) -> bool:
    try:
        (root / relative).lstat()
    except FileNotFoundError:
        return False
    checked_source(root, relative)
    return True


def automatic_dependency_entries(
    project_root: Path,
    manifest: dict[str, object],
) -> list[dict[str, object]]:
    configured_roots = manifest.get("auto_include_roots", [])
    if not isinstance(configured_roots, list) or len(configured_roots) > 8:
        raise ValueError("auto include roots must be a bounded list")
    roots = tuple(safe_relative(value) for value in configured_roots)
    if not roots:
        return []

    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise ValueError("project manifest files must be a list")
    published = {
        safe_relative(entry.get("path"))
        for entry in entries
        if isinstance(entry, dict)
    }
    pending = [
        relative
        for entry in entries
        if isinstance(entry, dict)
        and (relative := safe_relative(entry.get("source") or entry.get("path"))).suffix == ".tex"
        and declared_source_exists(project_root, relative)
    ]
    discovered: list[dict[str, object]] = []
    scanned: set[Path] = set()

    def opted_in(candidate: Path) -> bool:
        return any(candidate == root or root in candidate.parents for root in roots)

    while pending:
        source = pending.pop()
        if source in scanned:
            continue
        scanned.add(source)
        text = checked_source(project_root, source).read_text(encoding="utf-8")
        text = re.sub(r"(?<!\\)%.*", "", text)
        references: list[tuple[str, bool]] = [
            *((match.group(1).strip(), False) for match in INPUT_PATTERN.finditer(text)),
            *((match.group(1).strip(), True) for match in GRAPHICS_PATTERN.finditer(text)),
        ]
        for value, asset in references:
            try:
                relative = safe_relative(value)
            except ValueError:
                continue
            candidates = [relative]
            if asset and not relative.suffix:
                candidates = [Path(f"{relative.as_posix()}{extension}") for extension in AUTO_ASSET_EXTENSIONS]
            elif not asset and not relative.suffix:
                candidates = [Path(f"{relative.as_posix()}.tex")]
            for candidate in candidates:
                if not opted_in(candidate) or candidate.suffix.lower() not in AUTO_EXTENSIONS:
                    continue
                try:
                    (project_root / candidate).lstat()
                except FileNotFoundError:
                    continue
                checked_source(project_root, candidate)
                if candidate in published:
                    break
                entry: dict[str, object] = {
                    "path": candidate.as_posix(),
                    "managed": True,
                }
                if candidate.suffix.lower() in AUTO_ASSET_EXTENSIONS:
                    entry["type"] = "asset"
                discovered.append(entry)
                published.add(candidate)
                if candidate.suffix.lower() == ".tex":
                    pending.append(candidate)
                if len(entries) + len(discovered) > MAX_RUNTIME_FILES:
                    raise ValueError("project runtime discovered too many files")
                break
    return discovered


def project_spec(project_root: Path) -> tuple[list[Path], list[dict[str, object]], set[Path]]:
    manifest = read_object(checked_source(project_root, Path("project.json")))
    return _project_spec(project_root, manifest)


def _project_spec(project_root: Path, manifest: dict[str, object]):
    entries = manifest.get("files")
    if not isinstance(entries, list) or len(entries) > MAX_RUNTIME_FILES:
        raise ValueError("project manifest files must be a bounded list")
    automatic_entries = automatic_dependency_entries(project_root, manifest)
    paths = {Path("project.json")}
    missing: set[Path] = set()
    for entry in [*entries, *automatic_entries]:
        if not isinstance(entry, dict):
            raise ValueError("invalid project manifest file entry")
        relative = safe_relative(entry.get("source") or entry.get("path"))
        if declared_source_exists(project_root, relative):
            paths.add(relative)
        else:
            missing.add(relative)
    previews: dict[str, Path] = {}
    for field in PREVIEW_FIELDS:
        if manifest.get(field):
            relative = safe_relative(manifest[field])
            if declared_source_exists(project_root, relative):
                previews[field] = relative
            else:
                missing.add(relative)
    if preview_pdf := previews.get("preview_pdf"):
        paths.add(preview_pdf)
        if preview_synctex := previews.get("preview_synctex"):
            paths.add(preview_synctex)
    if len(paths) > MAX_RUNTIME_FILES:
        raise ValueError("project manifest contains too many runtime files")
    total = sum(checked_source(project_root, path).stat().st_size for path in paths)
    if total > MAX_RUNTIME_PROJECT_BYTES:
        raise ValueError("project runtime exceeds its size limit")
    return sorted(paths), automatic_entries, missing


def project_files(project_root: Path) -> list[Path]:
    return project_spec(project_root)[0]


def project_revision(project_root: Path, paths: list[Path]) -> tuple[str, dict[str, str]]:
    revisions: dict[str, str] = {}
    combined = hashlib.sha256()
    for relative in paths:
        source = checked_source(project_root, relative)
        revision = file_digest(source)
        relative_name = relative.as_posix()
        revisions[relative_name] = revision
        combined.update(relative_name.encode("utf-8"))
        combined.update(b"\0")
        combined.update(revision.encode("ascii"))
        combined.update(b"\0")
    return combined.hexdigest(), revisions


def copy_project(project_root: Path, destination: Path) -> None:
    manifest = read_json_object(checked_source(project_root, Path("project.json")))
    _copy_project(project_root, destination, manifest, _project_spec(project_root, manifest[0]))


def _copy_project(project_root: Path, destination: Path, validated_manifest, spec) -> dict[str, str]:
    runtime_manifest, manifest_bytes = validated_manifest
    paths, automatic_entries, missing = spec
    destination.mkdir(mode=0o755, parents=True, exist_ok=True)
    for relative in paths:
        target = destination / relative
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        if relative == Path("project.json"):
            target.write_bytes(manifest_bytes)
        else:
            shutil.copyfile(checked_source(project_root, relative), target)
        target.chmod(0o644)
    runtime_manifest = dict(runtime_manifest)
    runtime_manifest_path = destination / "project.json"
    runtime_manifest["files"] = [
        entry
        for entry in runtime_manifest["files"]
        if safe_relative(entry.get("source") or entry.get("path")) not in missing
    ]
    runtime_manifest["files"].extend(automatic_entries)
    preview_pdf = runtime_manifest.get("preview_pdf")
    if preview_pdf and safe_relative(preview_pdf) in missing:
        runtime_manifest.pop("preview_pdf")
        preview_pdf = None
    preview_synctex = runtime_manifest.get("preview_synctex")
    if not preview_pdf or (
        preview_synctex and safe_relative(preview_synctex) in missing
    ):
        runtime_manifest.pop("preview_synctex", None)
    if missing:
        runtime_manifest["runtime_warnings"] = [
            f"manifest file is missing: {relative.as_posix()}"
            for relative in sorted(missing)
        ]
    else:
        runtime_manifest.pop("runtime_warnings", None)
    runtime_manifest_path.write_text(
        json.dumps(runtime_manifest, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    # Hash exactly the staged bytes that the workspace will serve. Hashing the
    # source first and reopening it for copy lets an in-place server edit create
    # a descriptor/content mismatch between those two reads.
    runtime_revision, file_revisions = project_revision(destination, paths)
    # The served manifest contains these revision fields, so it cannot contain
    # a non-recursive hash of its own final bytes. Source and preview entries are
    # the cacheable artifacts consumers need to verify independently.
    file_revisions.pop("project.json", None)
    runtime_manifest["runtime_revision"] = runtime_revision
    runtime_manifest["runtime_file_revisions"] = file_revisions
    runtime_manifest_path.write_text(
        json.dumps(runtime_manifest, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    runtime_manifest_path.chmod(0o644)
    return file_revisions


def catalog_projects(catalog_path: Path) -> tuple[dict[str, object], list[dict[str, object]]]:
    catalog, _, projects = _catalog_projects(catalog_path)
    return catalog, projects


def _catalog_projects(catalog_path: Path):
    catalog, raw = read_json_object(catalog_path)
    projects = catalog.get("projects")
    if not isinstance(projects, list) or len(projects) > MAX_RUNTIME_FILES:
        raise ValueError("project catalog must contain a bounded projects list")
    valid: list[dict[str, object]] = []
    slugs: set[str] = set()
    for project in projects:
        if not isinstance(project, dict) or not isinstance(project.get("slug"), str):
            raise ValueError("invalid project catalog entry")
        if not SLUG_PATTERN.fullmatch(project["slug"]):
            raise ValueError("invalid project slug")
        if project["slug"] in slugs:
            raise ValueError("project catalog contains duplicate slugs")
        slugs.add(project["slug"])
        valid.append(project)
    return catalog, raw, valid


def _remove_tree(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def replace_tree(staged: Path, destination: Path) -> None:
    if not destination.exists() and not destination.is_symlink():
        os.replace(staged, destination)
        return
    # Docker runs on Linux. The exchange leaves no instant where the live
    # project directory is missing, even for directory-to-symlink transitions.
    rename_exchange = getattr(ctypes.CDLL(None, use_errno=True), "renameat2", None)
    if rename_exchange is not None:
        if rename_exchange(-100, os.fsencode(staged), -100, os.fsencode(destination), 2) == 0:
            return
        code = ctypes.get_errno()
        if code not in {errno.ENOSYS, errno.ENOTSUP, errno.EINVAL}:
            raise OSError(code, os.strerror(code), str(destination))
    previous = destination.with_name(f".{destination.name}.previous")
    _remove_tree(previous)
    os.replace(destination, previous)
    try:
        os.replace(staged, destination)
    except BaseException:
        os.replace(previous, destination)
        raise
    _remove_tree(previous)


def _input_fingerprint(manifest_bytes: bytes, automatic_entries, revisions: dict[str, str]) -> str:
    digest = hashlib.sha256(manifest_bytes)
    digest.update(json.dumps(automatic_entries, sort_keys=True).encode())
    digest.update(json.dumps(revisions, sort_keys=True).encode())
    return digest.hexdigest()


def _publish_project(project_root: Path, staged: Path, destination: Path, previous: object) -> str:
    manifest = read_json_object(checked_source(project_root, Path("project.json")))
    spec = _project_spec(project_root, manifest[0])
    paths, automatic_entries, _ = spec
    if previous and not destination.is_symlink() and (destination / "project.json").is_file():
        _, revisions = project_revision(project_root, [path for path in paths if path != Path("project.json")])
        fingerprint = _input_fingerprint(manifest[1], automatic_entries, revisions)
        if fingerprint == previous:
            return fingerprint
    revisions = _copy_project(project_root, staged, manifest, spec)
    replace_tree(staged, destination)
    return _input_fingerprint(manifest[1], automatic_entries, revisions)


def _write_atomic(path: Path, value: bytes, staging: Path) -> None:
    temporary = staging / path.name
    temporary.write_bytes(value)
    temporary.chmod(0o644)
    os.replace(temporary, path)


def sync_runtime(default_project: Path, projects_root: Path, output_root: Path) -> str:
    output_root.mkdir(mode=0o755, parents=True, exist_ok=True)
    with (output_root / ".sync.lock").open("ab") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _sync_runtime(default_project, projects_root, output_root)


def _sync_runtime(default_project: Path, projects_root: Path, output_root: Path) -> str:
    _, catalog_bytes, projects = _catalog_projects(checked_source(projects_root, Path("index.json")))
    state_path = output_root / ".input-fingerprints"
    previous = read_object(state_path) if state_path.is_file() else {}
    current = {}
    failures = []
    runtime_projects = output_root / "projects"
    runtime_projects.mkdir(mode=0o755, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".runtime-", dir=output_root) as temporary:
        staging = Path(temporary)
        jobs = [("project", default_project, output_root / "project")]
        jobs.extend(
            (f"projects/{entry['slug']}", projects_root / entry["slug"], runtime_projects / entry["slug"])
            for entry in projects if entry.get("source") != "default"
        )
        for index, (key, source, destination) in enumerate(jobs):
            try:
                current[key] = _publish_project(source, staging / f"tree-{index}", destination, previous.get(key))
            except (OSError, ValueError) as error:
                if key in previous:
                    current[key] = previous[key]
                failures.append((key, error))

        if current != previous:
            _write_atomic(state_path, json.dumps(current, sort_keys=True).encode(), staging)
        if failures:
            detail = "; ".join(f"{key}: {error}" for key, error in failures)
            raise ValueError(detail) from failures[0][1]

        for entry in projects:
            if entry.get("source") != "default":
                continue
            destination = runtime_projects / entry["slug"]
            if destination.is_symlink() and destination.readlink() == Path("../project"):
                continue
            staged = staging / "alias"
            staged.symlink_to("../project")
            replace_tree(staged, destination)
            _remove_tree(staged)

        index_path = runtime_projects / "index.json"
        if not index_path.is_file() or index_path.read_bytes() != catalog_bytes:
            _write_atomic(index_path, catalog_bytes, staging)
        slugs = {entry["slug"] for entry in projects}
        for child in runtime_projects.iterdir():
            if SLUG_PATTERN.fullmatch(child.name) and child.name not in slugs:
                _remove_tree(child)

        digest = hashlib.sha256(catalog_bytes)
        digest.update(json.dumps(current, sort_keys=True).encode())
        fingerprint = digest.hexdigest()
        fingerprint_path = output_root / ".fingerprint"
        if not fingerprint_path.is_file() or fingerprint_path.read_text().strip() != fingerprint:
            _write_atomic(fingerprint_path, f"{fingerprint}\n".encode(), staging)
        return fingerprint


def write_ready(path: Path) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(f"{time.time_ns()}\n", encoding="utf-8")
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--default-project", type=Path, required=True)
    parser.add_argument("--projects", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--watch-seconds", type=float, default=10)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    once = args.once or args.watch_seconds <= 0
    args.output.mkdir(mode=0o755, parents=True, exist_ok=True)
    while True:
        try:
            sync_runtime(args.default_project, args.projects, args.output)
            write_ready(args.output / ".ready")
        except Exception as error:
            print(f"project runtime sync failed: {error}", flush=True)
            if once:
                raise SystemExit(1) from error
        if once:
            break
        time.sleep(max(args.watch_seconds, 1))


if __name__ == "__main__":
    main()
