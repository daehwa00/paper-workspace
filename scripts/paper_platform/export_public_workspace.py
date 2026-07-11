#!/usr/bin/env python3
"""Export only the reusable authoring platform into a clean public repository."""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PUBLIC_PATHS = (
    Path("apps/paper_workspace/static"),
    Path("apps/paper_workspace/compiler"),
    Path("apps/paper_workspace/backup"),
    Path("apps/paper_workspace/collaboration"),
    Path("apps/paper_workspace/codex_bridge"),
    Path("apps/paper_workspace/password_gate"),
    Path("infra/paper-workspace"),
    Path("examples/paper-workspace-project"),
    Path("examples/project-library"),
    Path("docs/demo"),
    Path("docs/paper-platform"),
    Path("tests/paper_platform"),
    Path("scripts/paper_platform"),
)
ROOT_FILES = {
    Path("apps/paper_workspace/README.md"): Path("README.md"),
    Path("apps/paper_workspace/LICENSE"): Path("LICENSE"),
    Path("apps/paper_workspace/THIRD_PARTY_NOTICES.md"): Path("THIRD_PARTY_NOTICES.md"),
    Path("apps/paper_workspace/SECURITY.md"): Path("SECURITY.md"),
    Path("apps/paper_workspace/public.gitignore"): Path(".gitignore"),
    Path("apps/paper_workspace/public.dockerignore"): Path(".dockerignore"),
}
IGNORED_NAMES = {
    ".env",
    ".env.auth",
    ".env.password",
    ".auth",
    "auth.json",
    "allowed-emails",
    "__pycache__",
    ".pytest_cache",
    ".DS_Store",
}
SECRET_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
)


def allowed_file(path: Path) -> bool:
    return not any(part in IGNORED_NAMES for part in path.parts) and path.suffix not in {".pyc", ".pyo"}


def copy_public_path(relative: Path, destination: Path) -> None:
    source = ROOT / relative
    for item in source.rglob("*"):
        if item.is_symlink():
            raise RuntimeError(f"Refusing to export symlink: {item.relative_to(ROOT)}")
        if not item.is_file() or not allowed_file(item.relative_to(source)):
            continue
        target = destination / relative / item.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, target)


def verify_export(destination: Path) -> None:
    forbidden_parts = {"private", "datasets", "results", "checkpoints", ".codex"}
    for path in destination.rglob("*"):
        if path.is_symlink():
            raise RuntimeError(f"Export contains a symlink: {path}")
        if not path.is_file():
            continue
        relative = path.relative_to(destination)
        if forbidden_parts.intersection(relative.parts) or path.name in IGNORED_NAMES:
            raise RuntimeError(f"Export contains a private path: {relative}")
        if path.stat().st_size <= 2_000_000:
            text = path.read_text(encoding="utf-8", errors="ignore")
            if any(pattern.search(text) for pattern in SECRET_PATTERNS):
                raise RuntimeError(f"Possible secret found in {relative}")


def export(destination: Path) -> None:
    if destination.exists() and any(destination.iterdir()):
        raise RuntimeError(f"Destination must be empty: {destination}")
    destination.mkdir(parents=True, exist_ok=True)
    for relative in PUBLIC_PATHS:
        copy_public_path(relative, destination)
    for source, target in ROOT_FILES.items():
        output = destination / target
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / source, output)
    verify_export(destination)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="new or empty output directory")
    args = parser.parse_args()
    export(args.destination.resolve())
    print(f"Public workspace exported to {args.destination.resolve()}")


if __name__ == "__main__":
    main()
