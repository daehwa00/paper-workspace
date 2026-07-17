from __future__ import annotations

import base64
import binascii
import gzip
import hashlib
import io
import json
import os
import re
import secrets
import signal
import shutil
import subprocess
import tempfile
import time
import threading
import zipfile
from collections import OrderedDict
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
SOURCE_EXTENSIONS = {".tex", ".bib", ".sty", ".bst", ".cls", ".csv", ".txt", ".json", ".dat"}
ASSET_EXTENSIONS = {".png", ".jpg", ".jpeg", ".pdf", ".eps"}
MAX_REQUEST_BYTES = 48_000_000
MAX_PROJECT_FILES = 120
MAX_ASSET_BYTES = 32_000_000
COMPILE_CACHE_TTL = 600
COMPILE_CACHE_ITEMS = 16
COMPILE_CACHE_MAX_BYTES = max(1, int(os.environ.get("PAPER_COMPILE_CACHE_MAX_BYTES", "100663296")))
BUILD_STATE_TTL = 600
BUILD_STATE_ITEMS = 16
BUILD_STATE_MAX_BYTES = 2_000_000
BUILD_STATE_TOTAL_BYTES = 16_000_000
BUILD_STATE_EXTENSIONS = {".aux", ".bbl", ".toc", ".out", ".lof", ".lot", ".nav", ".snm", ".vrb"}
MAX_LATEX_PASSES = 3
MAX_PROCESS_LOG_BYTES = 128_000
MAX_SYNCTEX_BYTES = 8_000_000
MAX_SYNCTEX_EXPANDED_BYTES = 64_000_000
MAX_CONCURRENT_COMPILES = max(1, int(os.environ.get("PAPER_MAX_CONCURRENT_COMPILES", "2")))
COMPILE_SINGLEFLIGHT_WAIT_SECONDS = max(1, int(os.environ.get("PAPER_COMPILE_SINGLEFLIGHT_WAIT_SECONDS", "35")))
_compile_cache: OrderedDict[str, tuple[float, bytes, bytes, int]] = OrderedDict()
_synctex_cache: OrderedDict[str, tuple[float, bytes]] = OrderedDict()


@dataclass(frozen=True)
class BuildState:
    created_at: float
    binding: tuple[str, str, str, str, str]
    artifacts: dict[str, bytes]
    bibliography_signature: str
    size_bytes: int


_build_states: OrderedDict[str, BuildState] = OrderedDict()
_cache_lock = threading.Lock()
_build_state_lock = threading.Lock()
_process_lock = threading.Lock()
_active_processes: dict[str, subprocess.Popen[str]] = {}
_compile_slots = threading.BoundedSemaphore(MAX_CONCURRENT_COMPILES)
_compile_flight_lock = threading.Lock()
_compile_flights: dict[str, threading.Event] = {}


def _claim_compile_flight(cache_key: str) -> tuple[bool, threading.Event]:
    """Elect one compiler for identical input while followers await its cache result."""
    with _compile_flight_lock:
        event = _compile_flights.get(cache_key)
        if event is not None:
            return False, event
        event = threading.Event()
        _compile_flights[cache_key] = event
        return True, event


def _finish_compile_flight(cache_key: str, event: threading.Event) -> None:
    with _compile_flight_lock:
        if _compile_flights.get(cache_key) is event:
            _compile_flights.pop(cache_key, None)
        event.set()


def _prune_compile_caches(now: float) -> None:
    for key, cached in list(_compile_cache.items()):
        if now - cached[0] > COMPILE_CACHE_TTL:
            _compile_cache.pop(key, None)
    for key, cached in list(_synctex_cache.items()):
        if now - cached[0] > COMPILE_CACHE_TTL:
            _synctex_cache.pop(key, None)
    while len(_compile_cache) > COMPILE_CACHE_ITEMS:
        _compile_cache.popitem(last=False)
    while len(_synctex_cache) > COMPILE_CACHE_ITEMS * 2:
        _synctex_cache.popitem(last=False)
    def total_bytes() -> int:
        return sum(len(item[1]) + len(item[2]) for item in _compile_cache.values()) + sum(len(item[1]) for item in _synctex_cache.values())
    while total_bytes() > COMPILE_CACHE_MAX_BYTES and (_compile_cache or _synctex_cache):
        compile_oldest = next(iter(_compile_cache.values()))[0] if _compile_cache else float("inf")
        synctex_oldest = next(iter(_synctex_cache.values()))[0] if _synctex_cache else float("inf")
        if compile_oldest <= synctex_oldest:
            _compile_cache.popitem(last=False)
        else:
            _synctex_cache.popitem(last=False)


def _cache_get(key: str) -> tuple[bytes, bytes, int] | None:
    now = time.monotonic()
    with _cache_lock:
        _prune_compile_caches(now)
        cached = _compile_cache.get(key)
        if cached is None:
            return None
        _compile_cache.move_to_end(key)
        return cached[1:]


def _cache_put(key: str, pdf: bytes, synctex: bytes, elapsed_ms: int) -> str:
    compile_id = hashlib.sha256(pdf + synctex).hexdigest()[:24]
    now = time.monotonic()
    with _cache_lock:
        _compile_cache[key] = (now, pdf, synctex, elapsed_ms)
        _compile_cache.move_to_end(key)
        _synctex_cache[compile_id] = (now, synctex)
        _synctex_cache.move_to_end(compile_id)
        _prune_compile_caches(now)
    return compile_id


def _synctex_get(compile_id: str) -> bytes | None:
    now = time.monotonic()
    with _cache_lock:
        _prune_compile_caches(now)
        cached = _synctex_cache.get(compile_id)
        if cached is None:
            return None
        _synctex_cache.move_to_end(compile_id)
        return cached[1]


def _prune_build_states(now: float) -> None:
    for token, state in list(_build_states.items()):
        if now - state.created_at > BUILD_STATE_TTL:
            _build_states.pop(token, None)
    while len(_build_states) > BUILD_STATE_ITEMS:
        _build_states.popitem(last=False)
    while sum(state.size_bytes for state in _build_states.values()) > BUILD_STATE_TOTAL_BYTES:
        _build_states.popitem(last=False)


def _build_state_get(token: str | None, binding: tuple[str, str, str, str, str]) -> BuildState | None:
    if not token or not re.fullmatch(r"[0-9a-f]{32}", token):
        return None
    now = time.monotonic()
    with _build_state_lock:
        _prune_build_states(now)
        state = _build_states.get(token)
        if state is None or state.binding != binding:
            return None
        _build_states.move_to_end(token)
        return state


def _build_state_put(
    binding: tuple[str, str, str, str, str],
    artifacts: dict[str, bytes],
    bibliography_signature: str,
    previous_token: str | None = None,
) -> str | None:
    size_bytes = sum(len(value) for value in artifacts.values())
    if not artifacts or size_bytes > BUILD_STATE_MAX_BYTES:
        if previous_token:
            with _build_state_lock:
                _build_states.pop(previous_token, None)
        return None
    token = secrets.token_hex(16)
    state = BuildState(time.monotonic(), binding, artifacts, bibliography_signature, size_bytes)
    with _build_state_lock:
        if previous_token:
            _build_states.pop(previous_token, None)
        _build_states[token] = state
        _build_states.move_to_end(token)
        _prune_build_states(state.created_at)
    return token


def _snapshot_build_artifacts(work: Path) -> dict[str, bytes]:
    artifacts: dict[str, bytes] = {}
    total = 0
    for path in sorted(work.rglob("*")):
        if path.is_symlink() or not path.is_file() or path.suffix.lower() not in BUILD_STATE_EXTENSIONS:
            continue
        relative = path.relative_to(work).as_posix()
        safe_project_path(relative, BUILD_STATE_EXTENSIONS)
        data = path.read_bytes()
        total += len(data)
        if total > BUILD_STATE_MAX_BYTES:
            return {}
        artifacts[relative] = data
    return artifacts


def _restore_build_artifacts(work: Path, artifacts: dict[str, bytes]) -> None:
    for name, data in artifacts.items():
        destination = work / safe_project_path(name, BUILD_STATE_EXTENSIONS)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)


def _auxiliary_digest(work: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(work.rglob("*")):
        if path.is_symlink() or not path.is_file() or path.suffix.lower() not in BUILD_STATE_EXTENSIONS - {".bbl"}:
            continue
        digest.update(path.relative_to(work).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
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


def _needs_rerun(output: str) -> bool:
    markers = (
        "Rerun to get cross-references right",
        "Label(s) may have changed",
        "There were undefined references",
        "There were undefined citations",
    )
    return any(marker in output for marker in markers)


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


def _run_process(command: list[str], cwd: Path, env: dict[str, str], client_id: str, timeout: int) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(
        command,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )
    captured = bytearray()
    def drain_output() -> None:
        assert process.stdout is not None
        while chunk := process.stdout.read(65_536):
            captured.extend(chunk)
            if len(captured) > MAX_PROCESS_LOG_BYTES:
                del captured[:-MAX_PROCESS_LOG_BYTES]
    drain_thread = threading.Thread(target=drain_output, name="latex-output-drain", daemon=True)
    drain_thread.start()
    if client_id:
        with _process_lock:
            previous = _active_processes.get(client_id)
            _active_processes[client_id] = process
        if previous is not None and previous.poll() is None:
            try:
                os.killpg(previous.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise
    finally:
        drain_thread.join(timeout=2)
        if client_id:
            with _process_lock:
                if _active_processes.get(client_id) is process:
                    _active_processes.pop(client_id, None)
    return subprocess.CompletedProcess(command, process.returncode, captured.decode("utf-8", errors="replace"), "")


def safe_project_path(name: object, extensions: set[str]) -> Path:
    if not isinstance(name, str) or not name or len(name) > 240:
        raise ValueError("invalid project path")
    path = PurePosixPath(name)
    if path.is_absolute() or len(path.parts) > 12 or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("invalid project path")
    if any(not all(character.isalnum() or character in "._- ()" for character in part) for part in path.parts):
        raise ValueError("unsupported character in project path")
    if path.suffix.lower() not in extensions:
        raise ValueError(f"unsupported project file: {name}")
    return Path(*path.parts)


def restricted_tex_environment(texmf: Path) -> dict[str, str]:
    """Keep TeX reads/writes within its normal search paths and request workspace."""
    return {
        **os.environ,
        "TEXMFVAR": str(texmf),
        "TEXMFCONFIG": str(texmf),
        "openin_any": "p",
        "openout_any": "p",
    }


def expanded_synctex(data: bytes) -> bytes:
    if len(data) > MAX_SYNCTEX_BYTES:
        raise ValueError("SyncTeX data is too large")
    if not data.startswith(b"\x1f\x8b"):
        raise ValueError("SyncTeX data is not gzip encoded")
    expanded = 0
    chunks: list[bytes] = []
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
            while chunk := stream.read(65_536):
                expanded += len(chunk)
                if expanded > MAX_SYNCTEX_EXPANDED_BYTES:
                    raise ValueError("SyncTeX expanded data is too large")
                chunks.append(chunk)
    except (EOFError, OSError) as error:
        raise ValueError("SyncTeX data is invalid") from error
    return b"".join(chunks)


def validated_synctex(data: bytes) -> bytes:
    expanded_synctex(data)
    return data


def normalized_synctex(data: bytes, work: Path, project_tex_paths: set[str]) -> bytes:
    """Replace ephemeral compile roots with validated project-relative paths."""
    expanded = expanded_synctex(data)
    root = work.resolve()
    allowed = {safe_project_path(path, {".tex"}).as_posix() for path in project_tex_paths}
    normalized: list[bytes] = []
    input_line = re.compile(rb"^(Input:\d+:)(.*?)(\r?\n)?$")
    for line in expanded.splitlines(keepends=True):
        match = input_line.match(line)
        if match:
            source = Path(os.fsdecode(match.group(2)))
            try:
                candidate = source.resolve(strict=False) if source.is_absolute() else (root / source).resolve(strict=False)
                relative = candidate.relative_to(root).as_posix()
            except ValueError:
                relative = ""
            if relative in allowed:
                ending = match.group(3) or b""
                line = match.group(1) + os.fsencode(relative) + ending
        normalized.append(line)
    result = gzip.compress(b"".join(normalized), compresslevel=6, mtime=0)
    if len(result) > MAX_SYNCTEX_BYTES:
        raise ValueError("SyncTeX data is too large")
    return result


def synctex_source_path(value: str, work: Path) -> str:
    source = Path(value.strip())
    if source.is_absolute():
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
    return safe.as_posix()


def compiler_health_errors() -> list[str]:
    errors = [name for name in ("pdflatex", "bibtex", "synctex", "pdffonts") if shutil.which(name) is None]
    try:
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "probe").write_bytes(b"ok")
    except OSError:
        errors.append("temporary-workspace")
    return errors


def _run_latex_build(
    work: Path,
    compile_input: Path,
    files: dict[str, str],
    client_id: str,
    texmf: Path,
    warm: bool,
    previous_bibliography_signature: str,
) -> tuple[int, int, str]:
    environment = restricted_tex_environment(texmf)

    def run_latex() -> subprocess.CompletedProcess[str]:
        result = _run_process(
            ["pdflatex", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-no-shell-escape", "-jobname=preview", str(compile_input)],
            cwd=work, timeout=30, client_id=client_id, env=environment,
        )
        if result.returncode:
            raise RuntimeError((result.stdout + result.stderr)[-6000:])
        return result

    before_digest = _auxiliary_digest(work)
    result = run_latex()
    latex_passes = 1
    aux_path = work / "preview.aux"
    aux = aux_path.read_text(encoding="utf-8", errors="replace")
    bibliography_signature = _bibliography_signature(aux, files)
    used_bibtex = "\\bibdata" in aux and (
        not (work / "preview.bbl").is_file()
        or bibliography_signature != previous_bibliography_signature
    )
    bibtex_runs = 0
    if used_bibtex:
        bibtex = _run_process(
            ["bibtex", "preview"], cwd=work, timeout=30, client_id=client_id, env=environment,
        )
        if bibtex.returncode:
            raise RuntimeError((bibtex.stdout + bibtex.stderr)[-6000:])
        bibtex_runs = 1

    after_digest = _auxiliary_digest(work)
    needs_rerun = used_bibtex or before_digest != after_digest or _needs_rerun(result.stdout + result.stderr)
    minimum_passes = 3 if used_bibtex else (1 if warm else 2)
    while latex_passes < MAX_LATEX_PASSES and (latex_passes < minimum_passes or needs_rerun):
        before_digest = _auxiliary_digest(work)
        result = run_latex()
        latex_passes += 1
        after_digest = _auxiliary_digest(work)
        needs_rerun = before_digest != after_digest or _needs_rerun(result.stdout + result.stderr)

    return latex_passes, bibtex_runs, bibliography_signature


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            errors = compiler_health_errors()
            self._json(
                HTTPStatus.SERVICE_UNAVAILABLE if errors else HTTPStatus.OK,
                {"status": "dependency-error" if errors else "ok", "error_count": len(errors)},
            )
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/synctex":
            self._synctex()
            return
        if self.path == "/synctex-view":
            self._synctex_view()
            return
        if self.path == "/package":
            self._package()
            return
        if self.path != "/compile":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > MAX_REQUEST_BYTES:
                raise ValueError("project exceeds 48 MB")
            raw_payload = self.rfile.read(size)
            payload = json.loads(raw_payload)
            client_id = self.headers.get("X-Compile-Client", "")
            if client_id and (len(client_id) > 80 or not re.fullmatch(r"[A-Za-z0-9_-]+", client_id)):
                raise ValueError("invalid compile client")
            files = payload["files"]
            assets = payload.get("assets", {})
            if payload.get("remote_assets"):
                raise ValueError("remote project assets are not accepted; include request-scoped assets")
            entrypoint = payload.get("entrypoint", "main.tex")
            root_entrypoint = payload.get("root_entrypoint", "main.tex")
            preview_mode = payload.get("preview_mode", "document")
            workspace_id = payload.get("workspace_id", "")
            build_mode = payload.get("build_mode", "incremental")
            if not isinstance(files, dict) or not isinstance(files.get("main.tex"), str):
                raise ValueError("main.tex is required")
            if not isinstance(entrypoint, str) or not entrypoint.endswith(".tex"):
                raise ValueError("entrypoint must be a .tex file")
            if not isinstance(root_entrypoint, str) or not root_entrypoint.endswith(".tex"):
                raise ValueError("root_entrypoint must be a .tex file")
            if preview_mode not in {"document", "fragment"}:
                raise ValueError("invalid preview mode")
            if not isinstance(workspace_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", workspace_id):
                raise ValueError("invalid workspace id")
            if build_mode not in {"incremental", "clean"}:
                raise ValueError("invalid build mode")
            binding = (client_id, workspace_id, entrypoint, root_entrypoint, preview_mode)
            requested_state_id = self.headers.get("X-Compile-State", "")
            bound_state = _build_state_get(requested_state_id, binding) if client_id else None
            cache_key = hashlib.sha256(raw_payload).hexdigest()
            if cached := _cache_get(cache_key):
                pdf, synctex, elapsed_ms = cached
                compile_id = _cache_put(cache_key, pdf, synctex, elapsed_ms)
                self._json(HTTPStatus.OK, {"elapsed_ms": 0, "cached": True, "build_mode": "cached", "passes": 0, "bibtex_runs": 0, "build_state_id": requested_state_id if bound_state else "", "compile_id": compile_id, "pdf_audit": _pdf_audit(pdf), "pdf_base64": base64.b64encode(pdf).decode(), "synctex_base64": base64.b64encode(synctex).decode()})
                return
            if not isinstance(assets, dict) or len(files) + len(assets) > MAX_PROJECT_FILES:
                raise ValueError("too many project files")
            source_paths = {name: safe_project_path(name, SOURCE_EXTENSIONS) for name in files}
            asset_paths = {name: safe_project_path(name, ASSET_EXTENSIONS) for name in assets}
            entrypoint_path = safe_project_path(entrypoint, {".tex"})
            if entrypoint not in source_paths:
                raise ValueError(f"entrypoint not found: {entrypoint}")
            root_entrypoint_path = safe_project_path(root_entrypoint, {".tex"})
            if root_entrypoint not in source_paths:
                raise ValueError(f"root entrypoint not found: {root_entrypoint}")
            if set(source_paths) & set(asset_paths) or any(not isinstance(content, str) for content in files.values()):
                raise ValueError("invalid project file")
            decoded_assets = {}
            asset_bytes = 0
            for name, content in assets.items():
                if not isinstance(content, str):
                    raise ValueError("invalid asset")
                decoded = base64.b64decode(content, validate=True)
                asset_bytes += len(decoded)
                if asset_bytes > MAX_ASSET_BYTES:
                    raise ValueError("assets exceed 32 MB")
                decoded_assets[name] = decoded
            compile_leader, compile_event = _claim_compile_flight(cache_key)
            if not compile_leader:
                if compile_event.wait(COMPILE_SINGLEFLIGHT_WAIT_SECONDS) and (cached := _cache_get(cache_key)):
                    pdf, synctex, elapsed_ms = cached
                    compile_id = _cache_put(cache_key, pdf, synctex, elapsed_ms)
                    self._json(HTTPStatus.OK, {"elapsed_ms": 0, "cached": True, "build_mode": "cached", "passes": 0, "bibtex_runs": 0, "build_state_id": requested_state_id if bound_state else "", "compile_id": compile_id, "pdf_audit": _pdf_audit(pdf), "pdf_base64": base64.b64encode(pdf).decode(), "synctex_base64": base64.b64encode(synctex).decode()})
                    return
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "identical compile is still running; retry shortly"})
                return
            if not _compile_slots.acquire(blocking=False):
                _finish_compile_flight(cache_key, compile_event)
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "compiler is busy; retry shortly"})
                return
            started = time.monotonic()
            try:
                with tempfile.TemporaryDirectory() as directory:
                    work = Path(directory)
                    texmf = work / ".texmf"
                    texmf.mkdir()
                    warm = build_mode == "incremental" and bound_state is not None
                    if warm:
                        _restore_build_artifacts(work, bound_state.artifacts)
                    for name, content in files.items():
                        destination = work / source_paths[name]
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_text(content, encoding="utf-8")
                    for name, content in decoded_assets.items():
                        destination = work / asset_paths[name]
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_bytes(content)
                    compile_input = entrypoint_path
                    if preview_mode == "fragment":
                        root_source = files[root_entrypoint]
                        marker = "\\begin{document}"
                        if marker not in root_source:
                            raise ValueError("root entrypoint has no document preamble")
                        preamble = root_source.split(marker, 1)[0]
                        wrapper = (
                            f"{preamble}\n"
                            "\\begin{document}\n"
                            "\\appendix\n"
                            f"\\input{{{entrypoint_path.as_posix()}}}\n"
                            "\\end{document}\n"
                        )
                        compile_input = Path("__fragment_preview.tex")
                        (work / compile_input).write_text(wrapper, encoding="utf-8")
                    latex_passes, bibtex_runs, bibliography_signature = _run_latex_build(
                        work, compile_input, files, client_id, texmf, warm,
                        bound_state.bibliography_signature if warm else "",
                    )
                    pdf = (work / "preview.pdf").read_bytes()
                    project_tex_paths = {
                        path.as_posix() for path in source_paths.values() if path.suffix.lower() == ".tex"
                    }
                    synctex = normalized_synctex(
                        (work / "preview.synctex.gz").read_bytes(), work, project_tex_paths,
                    )
                    artifacts = _snapshot_build_artifacts(work)
                elapsed_ms = round((time.monotonic() - started) * 1000)
                build_state_id = _build_state_put(
                    binding, artifacts, bibliography_signature,
                    requested_state_id if bound_state else None,
                ) if client_id else None
                compile_id = _cache_put(cache_key, pdf, synctex, elapsed_ms)
            finally:
                _compile_slots.release()
                _finish_compile_flight(cache_key, compile_event)
            self._json(HTTPStatus.OK, {"elapsed_ms": elapsed_ms, "cached": False, "build_mode": "incremental" if warm else "clean", "passes": latex_passes, "bibtex_runs": bibtex_runs, "build_state_id": build_state_id or "", "compile_id": compile_id, "pdf_audit": _pdf_audit(pdf), "pdf_base64": base64.b64encode(pdf).decode(), "synctex_base64": base64.b64encode(synctex).decode()})
        except (KeyError, ValueError, binascii.Error, json.JSONDecodeError, RuntimeError, subprocess.TimeoutExpired) as error:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error)})

    def _synctex(self) -> None:
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > MAX_REQUEST_BYTES:
                raise ValueError("SyncTeX request is too large")
            payload = json.loads(self.rfile.read(size))
            page = int(payload["page"])
            x = float(payload["x"])
            y = float(payload["y"])
            if page < 1 or page > 200 or not 0 <= x <= 2000 or not 0 <= y <= 3000:
                raise ValueError("invalid PDF coordinate")
            compile_id = payload.get("compile_id")
            if isinstance(compile_id, str) and re.fullmatch(r"[0-9a-f]{24}", compile_id):
                synctex = _synctex_get(compile_id)
                if synctex is None:
                    raise ValueError("SyncTeX cache expired; render the PDF again.")
            else:
                synctex = base64.b64decode(payload["synctex_base64"], validate=True)
            synctex = validated_synctex(synctex)
            with tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                (work / "main.synctex.gz").write_bytes(synctex)
                (work / "main.pdf").write_bytes(b"%PDF-1.4\n")
                result = subprocess.run(
                    ["synctex", "edit", "-o", f"{page}:{x:.3f}:{y:.3f}:main.pdf"],
                    cwd=work, text=True, encoding="utf-8", errors="replace",
                    capture_output=True, timeout=10, check=False,
                )
            output = result.stdout + result.stderr
            input_match = re.search(r"^Input:(.+)$", output, re.MULTILINE)
            line_match = re.search(r"^Line:(\d+)$", output, re.MULTILINE)
            column_match = re.search(r"^Column:(-?\d+)$", output, re.MULTILINE)
            if result.returncode or not input_match or not line_match:
                raise ValueError("해당 PDF 위치에 연결된 LaTeX 줄을 찾지 못했습니다.")
            source = synctex_source_path(input_match.group(1), work)
            self._json(HTTPStatus.OK, {"file": source, "line": int(line_match.group(1)), "column": max(0, int(column_match.group(1))) if column_match else 0})
        except (KeyError, ValueError, binascii.Error, subprocess.TimeoutExpired) as error:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error)})

    def _read_synctex_payload(self, payload: dict[str, object]) -> bytes:
        compile_id = payload.get("compile_id")
        if isinstance(compile_id, str) and re.fullmatch(r"[0-9a-f]{24}", compile_id):
            synctex = _synctex_get(compile_id)
            if synctex is None:
                raise ValueError("SyncTeX cache expired; render the PDF again.")
            return validated_synctex(synctex)
        encoded = payload.get("synctex_base64")
        if not isinstance(encoded, str):
            raise ValueError("SyncTeX data is required")
        synctex = base64.b64decode(encoded, validate=True)
        return validated_synctex(synctex)

    def _synctex_view(self) -> None:
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > MAX_REQUEST_BYTES:
                raise ValueError("SyncTeX request is too large")
            payload = json.loads(self.rfile.read(size))
            line = int(payload["line"])
            column = int(payload.get("column", 0))
            source = safe_project_path(payload["file"], SOURCE_EXTENSIONS)
            if source.suffix.lower() != ".tex" or line < 1 or line > 200_000 or column < 0 or column > 20_000:
                raise ValueError("invalid source coordinate")
            synctex = self._read_synctex_payload(payload)
            with tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                (work / "main.synctex.gz").write_bytes(synctex)
                (work / "main.pdf").write_bytes(b"%PDF-1.4\n")
                result = subprocess.run(
                    ["synctex", "view", "-i", f"{line}:{column}:{source.as_posix()}", "-o", "main.pdf"],
                    cwd=work, text=True, encoding="utf-8", errors="replace",
                    capture_output=True, timeout=10, check=False,
                )
            output = result.stdout + result.stderr
            page_match = re.search(r"^Page:(\d+)$", output, re.MULTILINE)
            x_match = re.search(r"^x:([0-9.+-]+)$", output, re.MULTILINE)
            y_match = re.search(r"^y:([0-9.+-]+)$", output, re.MULTILINE)
            if result.returncode or not page_match or not x_match or not y_match:
                raise ValueError("해당 LaTeX 줄에 연결된 PDF 위치를 찾지 못했습니다.")
            width_match = re.search(r"^W:([0-9.+-]+)$", output, re.MULTILINE)
            height_match = re.search(r"^H:([0-9.+-]+)$", output, re.MULTILINE)
            self._json(HTTPStatus.OK, {"page": int(page_match.group(1)), "x": float(x_match.group(1)), "y": float(y_match.group(1)), "width": float(width_match.group(1)) if width_match else 80.0, "height": float(height_match.group(1)) if height_match else 12.0})
        except (KeyError, ValueError, binascii.Error, subprocess.TimeoutExpired) as error:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error)})

    def _package(self) -> None:
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > MAX_REQUEST_BYTES:
                raise ValueError("project exceeds 48 MB")
            payload = json.loads(self.rfile.read(size))
            files = payload.get("files", {})
            assets = payload.get("assets", {})
            if payload.get("remote_assets"):
                raise ValueError("remote project assets are not accepted; include request-scoped assets")
            if not isinstance(files, dict) or not isinstance(files.get("main.tex"), str):
                raise ValueError("main.tex is required")
            if not isinstance(assets, dict) or len(files) + len(assets) > MAX_PROJECT_FILES:
                raise ValueError("too many project files")
            source_paths = {name: safe_project_path(name, SOURCE_EXTENSIONS) for name in files}
            asset_paths = {name: safe_project_path(name, ASSET_EXTENSIONS) for name in assets}
            if set(source_paths) & set(asset_paths):
                raise ValueError("invalid project file")
            packaged: dict[str, bytes] = {}
            for name, content in files.items():
                if not isinstance(content, str):
                    raise ValueError("invalid source file")
                packaged[source_paths[name].as_posix()] = content.encode("utf-8")
            asset_bytes = 0
            for name, content in assets.items():
                if not isinstance(content, str):
                    raise ValueError("invalid asset")
                decoded = base64.b64decode(content, validate=True)
                asset_bytes += len(decoded)
                packaged[asset_paths[name].as_posix()] = decoded
            if asset_bytes > MAX_ASSET_BYTES:
                raise ValueError("assets exceed 32 MB")
            checksums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(packaged.items()))
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
                for name, data in sorted(packaged.items()):
                    bundle.writestr(name, data)
                bundle.writestr("SHA256SUMS", checksums.encode("utf-8"))
            self._json(HTTPStatus.OK, {"zip_base64": base64.b64encode(archive.getvalue()).decode(), "file_count": len(packaged), "sha256": hashlib.sha256(archive.getvalue()).hexdigest()})
        except (KeyError, ValueError, binascii.Error, json.JSONDecodeError) as error:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error)})

    def _json(self, status: HTTPStatus, value: dict[str, object]) -> None:
        encoded = json.dumps(value).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *_: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
