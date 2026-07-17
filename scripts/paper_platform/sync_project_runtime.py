#!/usr/bin/env python3
"""Publish only manifest-listed project files into the web runtime volume."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path, PurePosixPath


SLUG_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_RUNTIME_FILES = 240
MAX_RUNTIME_FILE_BYTES = 64 * 1024 * 1024
MAX_RUNTIME_PROJECT_BYTES = 512 * 1024 * 1024


def safe_relative(value: object) -> Path:
    if not isinstance(value, str) or not value or len(value) > 240 or "\\" in value:
        raise ValueError("invalid project manifest path")
    path = PurePosixPath(value)
    if path.is_absolute() or len(path.parts) > 12 or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("invalid project manifest path")
    if any(part.startswith(".") for part in path.parts):
        raise ValueError("hidden project paths are not publishable")
    return Path(*path.parts)


def read_object(path: Path) -> dict[str, object]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ValueError(f"invalid JSON manifest: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"expected a JSON object in {path}")
    return payload


def checked_source(root: Path, relative: Path) -> Path:
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
    if size > MAX_RUNTIME_FILE_BYTES:
        raise ValueError(f"manifest file is too large: {relative.as_posix()}")
    return candidate


def project_files(project_root: Path) -> list[Path]:
    manifest_path = checked_source(project_root, Path("project.json"))
    manifest = read_object(manifest_path)
    entries = manifest.get("files")
    if not isinstance(entries, list) or len(entries) > MAX_RUNTIME_FILES:
        raise ValueError("project manifest files must be a bounded list")
    paths = {Path("project.json")}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("invalid project manifest file entry")
        paths.add(safe_relative(entry.get("source") or entry.get("path")))
    for field in ("preview_pdf", "preview_synctex"):
        if manifest.get(field):
            paths.add(safe_relative(manifest[field]))
    if len(paths) > MAX_RUNTIME_FILES:
        raise ValueError("project manifest contains too many runtime files")
    total = sum(checked_source(project_root, path).stat().st_size for path in paths)
    if total > MAX_RUNTIME_PROJECT_BYTES:
        raise ValueError("project runtime exceeds its size limit")
    return sorted(paths)


def copy_project(project_root: Path, destination: Path) -> None:
    for relative in project_files(project_root):
        source = checked_source(project_root, relative)
        target = destination / relative
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o644)


def catalog_projects(catalog_path: Path) -> tuple[dict[str, object], list[dict[str, object]]]:
    catalog = read_object(catalog_path)
    projects = catalog.get("projects")
    if not isinstance(projects, list) or len(projects) > MAX_RUNTIME_FILES:
        raise ValueError("project catalog must contain a bounded projects list")
    valid: list[dict[str, object]] = []
    for project in projects:
        if not isinstance(project, dict) or not isinstance(project.get("slug"), str):
            raise ValueError("invalid project catalog entry")
        if not SLUG_PATTERN.fullmatch(project["slug"]):
            raise ValueError("invalid project slug")
        valid.append(project)
    return catalog, valid


def replace_tree(staged: Path, destination: Path) -> None:
    previous = destination.with_name(f".{destination.name}.previous")
    shutil.rmtree(previous, ignore_errors=True)
    if destination.exists():
        os.replace(destination, previous)
    try:
        os.replace(staged, destination)
    except Exception:
        if previous.exists() and not destination.exists():
            os.replace(previous, destination)
        raise
    shutil.rmtree(previous, ignore_errors=True)


def sync_runtime(default_project: Path, projects_root: Path, output_root: Path) -> str:
    catalog_path = checked_source(projects_root, Path("index.json"))
    _, projects = catalog_projects(catalog_path)
    output_root.mkdir(mode=0o755, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".runtime-", dir=output_root) as temporary:
        staging = Path(temporary)
        staged_default = staging / "project"
        staged_projects = staging / "projects"
        staged_default.mkdir()
        staged_projects.mkdir()
        copy_project(default_project, staged_default)
        shutil.copyfile(catalog_path, staged_projects / "index.json")
        (staged_projects / "index.json").chmod(0o644)
        for project in projects:
            slug = str(project["slug"])
            if project.get("source") == "default":
                continue
            copy_project(projects_root / slug, staged_projects / slug)
        digest = hashlib.sha256()
        for path in sorted(staging.rglob("*")):
            if path.is_file():
                digest.update(path.relative_to(staging).as_posix().encode())
                with path.open("rb") as handle:
                    while chunk := handle.read(64 * 1024):
                        digest.update(chunk)
        fingerprint = digest.hexdigest()
        fingerprint_path = output_root / ".fingerprint"
        previous_fingerprint = (
            fingerprint_path.read_text(encoding="utf-8").strip()
            if fingerprint_path.is_file()
            else ""
        )
        if previous_fingerprint == fingerprint:
            return fingerprint
        replace_tree(staged_default, output_root / "project")
        replace_tree(staged_projects, output_root / "projects")
        temporary_fingerprint = output_root / ".fingerprint.tmp"
        temporary_fingerprint.write_text(f"{fingerprint}\n", encoding="utf-8")
        os.replace(temporary_fingerprint, fingerprint_path)
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
    args = parser.parse_args()
    args.output.mkdir(mode=0o755, parents=True, exist_ok=True)
    while True:
        try:
            sync_runtime(args.default_project, args.projects, args.output)
            write_ready(args.output / ".ready")
        except Exception as error:
            print(f"project runtime sync failed: {error}", flush=True)
        if args.watch_seconds <= 0:
            break
        time.sleep(max(args.watch_seconds, 1))


if __name__ == "__main__":
    main()
