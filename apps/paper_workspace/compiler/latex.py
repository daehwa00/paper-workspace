from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path, PurePosixPath

from .state import BuildGeneration, CompilerRuntime, terminate_process
from .validation import read_bounded, safe_project_path

BUILD_STATE_EXTENSIONS = {".aux", ".bbl", ".toc", ".out", ".lof", ".lot", ".nav", ".snm", ".vrb"}
BUILD_STATE_MAX_BYTES = 2_000_000
MAX_PROCESS_LOG_BYTES = 128_000


def _snapshot_build_artifacts(work: Path, limit=BUILD_STATE_MAX_BYTES) -> dict[str, bytes]:
    artifacts: dict[str, bytes] = {}
    total = 0
    for path in sorted(work.rglob("*")):
        if path.is_symlink() or not path.is_file() or path.suffix.lower() not in BUILD_STATE_EXTENSIONS:
            continue
        relative = path.relative_to(work).as_posix()
        safe_project_path(relative, BUILD_STATE_EXTENSIONS)
        total += len(relative.encode()) + 128
        if total > limit or path.stat().st_size > limit - total:
            return {}
        data = read_bounded(path, limit - total, "generated build state")
        total += len(data)
        artifacts[relative] = data
    return artifacts


def _restore_build_artifacts(work: Path, artifacts: dict[str, bytes]) -> None:
    for name, data in artifacts.items():
        destination = work / safe_project_path(name, BUILD_STATE_EXTENSIONS)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)


MAX_AUXILIARY_BYTES = 16_000_000


def _auxiliary_digest(work: Path) -> str:
    digest = hashlib.sha256()
    remaining = MAX_AUXILIARY_BYTES
    for path in sorted(work.rglob("*")):
        if path.is_symlink() or not path.is_file() or path.suffix.lower() not in BUILD_STATE_EXTENSIONS - {".bbl"}:
            continue
        digest.update(path.relative_to(work).as_posix().encode())
        digest.update(b"\0")
        data = read_bounded(path, remaining, "generated auxiliary data")
        remaining -= len(data)
        digest.update(data)
        digest.update(b"\0")
    return digest.hexdigest()


def _bibliography_signature(aux: str, files: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for line in aux.splitlines():
        if line.startswith(("\\citation", "\\bibdata", "\\bibstyle")):
            digest.update(line.encode())
            digest.update(b"\n")
    for name, content in sorted(files.items()):
        if PurePosixPath(name).suffix.lower() in {".bib", ".bst"}:
            digest.update(name.encode())
            digest.update(b"\0")
            digest.update(content.encode())
            digest.update(b"\0")
    return digest.hexdigest()


def _pdf_audit(pdf: bytes) -> dict[str, object]:
    """Inspect the generated artifact with Poppler without claiming PDF/A conformance."""
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "audit.pdf"
        path.write_bytes(pdf)
        result = subprocess.run(
            ["pdffonts", str(path)], text=True, encoding="utf-8", errors="replace",
            capture_output=True, timeout=10, check=False,
        )
    fonts: list[dict[str, object]] = []
    if result.returncode == 0:
        for line in result.stdout.splitlines()[2:]:
            match = re.search(r"\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$", line)
            if match:
                fonts.append({"name": line[:match.start()].split()[0] if line[:match.start()].split() else "unknown", "embedded": match.group(1) == "yes"})
    unembedded = [str(font["name"]) for font in fonts if not font["embedded"]]
    return {"font_count": len(fonts), "all_fonts_embedded": bool(fonts) and not unembedded, "unembedded_fonts": unembedded[:20], "size_bytes": len(pdf)}


def _run_process(
    command: list[str], cwd: Path, env: dict[str, str], client_id: str | BuildGeneration,
    timeout: int, *, runtime: CompilerRuntime | None = None, log_limit=MAX_PROCESS_LOG_BYTES,
) -> subprocess.CompletedProcess[str]:
    options = dict(cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                   env=env, start_new_session=True)
    generation = client_id if isinstance(client_id, BuildGeneration) else None
    if generation is not None and runtime is not None:
        process = runtime.spawn(generation, command, **options)
    else:
        process = subprocess.Popen(command, **options)
    captured = bytearray()

    def drain_output() -> None:
        assert process.stdout is not None
        with process.stdout:
            while chunk := process.stdout.read(65_536):
                captured.extend(chunk)
                if len(captured) > log_limit:
                    del captured[:-log_limit]

    drain_thread = threading.Thread(target=drain_output, name="latex-output-drain", daemon=True)
    drain_thread.start()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        terminate_process(process)
        process.wait()
        raise
    finally:
        if generation is not None and runtime is not None:
            runtime.clear_process(generation, process)
        drain_thread.join(timeout=2)
    if generation is not None and runtime is not None:
        runtime.assert_current(generation)
    return subprocess.CompletedProcess(command, process.returncode, captured.decode("utf-8", errors="replace"), "")


def compiler_health_errors() -> list[str]:
    errors = [name for name in ("pdflatex", "bibtex", "synctex", "pdffonts", "pandoc", "pdftotext", "pdfinfo", "prlimit") if shutil.which(name) is None]
    try:
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "probe").write_bytes(b"ok")
    except OSError:
        errors.append("temporary-workspace")
    return errors
