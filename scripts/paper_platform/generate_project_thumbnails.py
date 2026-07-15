#!/usr/bin/env python3
"""Keep project-card thumbnails in sync with the first page of project PDFs."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import time
from collections.abc import Callable
from pathlib import Path


SLUG_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
THUMBNAIL_PATTERN = re.compile(r"/projects/[A-Za-z0-9][A-Za-z0-9_-]{0,63}/thumbnail\.(?:png|jpe?g|webp)")
MAX_PDF_BYTES = 64 * 1024 * 1024
RENDER_VERSION = "2"


def _safe_relative(value: object) -> Path | None:
    if not isinstance(value, str) or not value or "\\" in value:
        return None
    path = Path(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        return None
    return path


def _read_json(path: Path) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"expected a JSON object in {path}")
    return payload


def resolve_project_pdf(project_root: Path) -> Path | None:
    """Return the canonical preview PDF without considering arbitrary asset PDFs."""
    try:
        resolved_root = project_root.resolve(strict=True)
    except OSError:
        return None
    manifest_path = project_root / "project.json"
    manifest = _read_json(manifest_path) if manifest_path.is_file() else {}
    entrypoint = _safe_relative(manifest.get("entrypoint")) or Path("main.tex")
    preview_pdf = _safe_relative(manifest.get("preview_pdf"))
    entrypoint_pdf = entrypoint.with_suffix(".pdf")
    candidates = [
        preview_pdf,
        Path("build/submission/submission.pdf"),
        Path("build") / entrypoint_pdf,
        entrypoint_pdf,
        Path("build/main.pdf"),
        Path("preview.pdf"),
    ]
    seen: set[Path] = set()
    for relative in candidates:
        if relative is None or relative in seen:
            continue
        seen.add(relative)
        candidate = project_root / relative
        try:
            resolved = candidate.resolve(strict=True)
            if not resolved.is_relative_to(resolved_root):
                continue
            size = resolved.stat().st_size
        except OSError:
            continue
        if resolved.is_file() and 0 < size <= MAX_PDF_BYTES:
            return resolved
    return None


def render_pdf_thumbnail(source: Path, destination: Path) -> None:
    destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="thumbnail-", dir=destination.parent) as temporary:
        output_prefix = Path(temporary) / "first-page"
        result = subprocess.run(
            [
                "pdftoppm",
                "-f",
                "1",
                "-l",
                "1",
                "-singlefile",
                "-png",
                "-scale-to-x",
                "900",
                "-scale-to-y",
                "-1",
                str(source),
                str(output_prefix),
            ],
            capture_output=True,
            check=False,
            timeout=30,
        )
        rendered = output_prefix.with_suffix(".png")
        if result.returncode or not rendered.is_file():
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(detail or f"pdftoppm exited with {result.returncode}")
        rendered.chmod(0o644)
        os.replace(rendered, destination)


def _write_atomic(path: Path, value: str) -> None:
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(value, encoding="utf-8")
    temporary.chmod(0o644)
    os.replace(temporary, path)


def scan_projects(
    catalog_path: Path,
    default_project_root: Path,
    projects_root: Path,
    output_root: Path,
    renderer: Callable[[Path, Path], None] = render_pdf_thumbnail,
) -> list[str]:
    catalog = _read_json(catalog_path)
    projects = catalog.get("projects", [])
    if not isinstance(projects, list):
        raise ValueError("project catalog must contain a projects list")

    updated: list[str] = []
    for project in projects:
        if not isinstance(project, dict):
            continue
        slug = project.get("slug")
        if not isinstance(slug, str) or not SLUG_PATTERN.fullmatch(slug):
            continue
        thumbnail = project.get("thumbnail")
        if isinstance(thumbnail, str) and THUMBNAIL_PATTERN.fullmatch(thumbnail):
            continue
        try:
            project_root = default_project_root if project.get("source") == "default" else projects_root / slug
            source = resolve_project_pdf(project_root)
            if source is None:
                continue

            stat = source.stat()
            fingerprint = f"{RENDER_VERSION}:{stat.st_size}:{stat.st_mtime_ns}\n"
            destination_root = output_root / slug
            destination = destination_root / "thumbnail.png"
            fingerprint_path = destination_root / ".fingerprint"
            if destination.is_file() and fingerprint_path.is_file():
                if fingerprint_path.read_text(encoding="utf-8") == fingerprint:
                    continue

            renderer(source, destination)
            _write_atomic(fingerprint_path, fingerprint)
            updated.append(slug)
        except Exception as error:
            print(f"thumbnail generation failed for {slug}: {error}", flush=True)
    return updated


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--default-project", type=Path, required=True)
    parser.add_argument("--projects", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--watch-seconds", type=float, default=30)
    args = parser.parse_args()

    args.output.mkdir(mode=0o755, parents=True, exist_ok=True)
    while True:
        try:
            updated = scan_projects(
                args.catalog,
                args.default_project,
                args.projects,
                args.output,
            )
            if updated:
                print(f"updated project thumbnails: {', '.join(updated)}", flush=True)
            _write_atomic(args.output / ".ready", f"{time.time_ns()}\n")
        except Exception as error:
            print(f"project thumbnail scan failed: {error}", flush=True)
        if args.watch_seconds <= 0:
            break
        time.sleep(max(args.watch_seconds, 1))


if __name__ == "__main__":
    main()
