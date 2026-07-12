from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import os
import signal
import subprocess
import tempfile
import time
import re
import threading
import zipfile
from collections import OrderedDict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
SOURCE_EXTENSIONS = {".tex", ".bib", ".sty", ".bst", ".cls", ".csv", ".txt", ".json", ".dat"}
ASSET_EXTENSIONS = {".png", ".jpg", ".jpeg", ".pdf", ".eps"}
MAX_REQUEST_BYTES = 48_000_000
MAX_PROJECT_FILES = 120
MAX_ASSET_BYTES = 32_000_000
PROJECT_LIBRARY_ROOT = Path(os.environ.get("PAPER_PROJECTS_ROOT", "/projects"))
DEFAULT_PROJECT_ROOT = Path(os.environ.get("PAPER_DEFAULT_PROJECT_ROOT", "/project-default"))
PROJECT_SLUG_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
COMPILE_CACHE_TTL = 600
COMPILE_CACHE_ITEMS = 16
MAX_CONCURRENT_COMPILES = max(1, int(os.environ.get("PAPER_MAX_CONCURRENT_COMPILES", "2")))
_compile_cache: OrderedDict[str, tuple[float, bytes, bytes, int]] = OrderedDict()
_synctex_cache: OrderedDict[str, tuple[float, bytes]] = OrderedDict()
_cache_lock = threading.Lock()
_process_lock = threading.Lock()
_active_processes: dict[str, subprocess.Popen[str]] = {}
_compile_slots = threading.BoundedSemaphore(MAX_CONCURRENT_COMPILES)


def _cache_get(key: str) -> tuple[bytes, bytes, int] | None:
    now = time.monotonic()
    with _cache_lock:
        cached = _compile_cache.get(key)
        if cached is None or now - cached[0] > COMPILE_CACHE_TTL:
            _compile_cache.pop(key, None)
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
        while len(_compile_cache) > COMPILE_CACHE_ITEMS:
            _compile_cache.popitem(last=False)
        while len(_synctex_cache) > COMPILE_CACHE_ITEMS * 2:
            _synctex_cache.popitem(last=False)
    return compile_id


def _synctex_get(compile_id: str) -> bytes | None:
    now = time.monotonic()
    with _cache_lock:
        cached = _synctex_cache.get(compile_id)
        if cached is None or now - cached[0] > COMPILE_CACHE_TTL:
            _synctex_cache.pop(compile_id, None)
            return None
        _synctex_cache.move_to_end(compile_id)
        return cached[1]


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
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        start_new_session=True,
    )
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
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise
    finally:
        if client_id:
            with _process_lock:
                if _active_processes.get(client_id) is process:
                    _active_processes.pop(client_id, None)
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


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


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(HTTPStatus.OK, {"status": "ok"})
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
            if size > MAX_REQUEST_BYTES:
                raise ValueError("project exceeds 48 MB")
            raw_payload = self.rfile.read(size)
            client_id = self.headers.get("X-Compile-Client", "")
            if client_id and (len(client_id) > 80 or not re.fullmatch(r"[A-Za-z0-9_-]+", client_id)):
                raise ValueError("invalid compile client")
            cache_key = hashlib.sha256(raw_payload).hexdigest()
            if cached := _cache_get(cache_key):
                pdf, synctex, elapsed_ms = cached
                compile_id = _cache_put(cache_key, pdf, synctex, elapsed_ms)
                self._json(HTTPStatus.OK, {"elapsed_ms": 0, "cached": True, "compile_id": compile_id, "pdf_audit": _pdf_audit(pdf), "pdf_base64": base64.b64encode(pdf).decode()})
                return
            payload = json.loads(raw_payload)
            files = payload["files"]
            assets = payload.get("assets", {})
            remote_assets = payload.get("remote_assets", {})
            project_slug = payload.get("project_slug", "")
            entrypoint = payload.get("entrypoint", "main.tex")
            root_entrypoint = payload.get("root_entrypoint", "main.tex")
            preview_mode = payload.get("preview_mode", "document")
            if not isinstance(files, dict) or not isinstance(files.get("main.tex"), str):
                raise ValueError("main.tex is required")
            if not isinstance(entrypoint, str) or not entrypoint.endswith(".tex"):
                raise ValueError("entrypoint must be a .tex file")
            if not isinstance(root_entrypoint, str) or not root_entrypoint.endswith(".tex"):
                raise ValueError("root_entrypoint must be a .tex file")
            if preview_mode not in {"document", "fragment"}:
                raise ValueError("invalid preview mode")
            if not isinstance(assets, dict) or not isinstance(remote_assets, dict) or len(files) + len(assets) + len(remote_assets) > MAX_PROJECT_FILES:
                raise ValueError("too many project files")
            source_paths = {name: safe_project_path(name, SOURCE_EXTENSIONS) for name in files}
            asset_paths = {name: safe_project_path(name, ASSET_EXTENSIONS) for name in assets}
            remote_asset_paths = {name: safe_project_path(name, ASSET_EXTENSIONS) for name in remote_assets}
            entrypoint_path = safe_project_path(entrypoint, {".tex"})
            if entrypoint not in source_paths:
                raise ValueError(f"entrypoint not found: {entrypoint}")
            root_entrypoint_path = safe_project_path(root_entrypoint, {".tex"})
            if root_entrypoint not in source_paths:
                raise ValueError(f"root entrypoint not found: {root_entrypoint}")
            if set(source_paths) & (set(asset_paths) | set(remote_asset_paths)) or set(asset_paths) & set(remote_asset_paths) or any(not isinstance(content, str) for content in files.values()):
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
            if remote_assets:
                if not isinstance(project_slug, str) or not PROJECT_SLUG_PATTERN.fullmatch(project_slug):
                    raise ValueError("invalid project slug")
                project_root = DEFAULT_PROJECT_ROOT if project_slug == "default" else PROJECT_LIBRARY_ROOT / project_slug
                for destination_name, source_name in remote_assets.items():
                    source_path = safe_project_path(source_name, ASSET_EXTENSIONS)
                    source = project_root / source_path
                    if not source.is_file():
                        raise ValueError(f"project asset not found: {source_name}")
                    decoded = source.read_bytes()
                    asset_bytes += len(decoded)
                    if asset_bytes > MAX_ASSET_BYTES:
                        raise ValueError("assets exceed 32 MB")
                    decoded_assets[destination_name] = decoded
            if not _compile_slots.acquire(blocking=False):
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "compiler is busy; retry shortly"})
                return
            started = time.monotonic()
            try:
                with tempfile.TemporaryDirectory() as directory:
                    work = Path(directory)
                    texmf = work / ".texmf"
                    texmf.mkdir()
                    for name, content in files.items():
                        destination = work / source_paths[name]
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_text(content, encoding="utf-8")
                    for name, content in decoded_assets.items():
                        destination = work / (asset_paths.get(name) or remote_asset_paths[name])
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
                    def run_latex() -> subprocess.CompletedProcess[str]:
                        result = _run_process(
                            ["pdflatex", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "-jobname=preview", str(compile_input)],
                            cwd=work, timeout=30, client_id=client_id,
                            env={**os.environ, "TEXMFVAR": str(texmf), "TEXMFCONFIG": str(texmf)},
                        )
                        if result.returncode:
                            raise RuntimeError((result.stdout + result.stderr)[-6000:])
                        return result

                    result = run_latex()
                    aux = (work / "preview.aux").read_text(encoding="utf-8", errors="replace")
                    used_bibtex = False
                    if "\\bibdata" in aux:
                        bibtex = _run_process(
                            ["bibtex", "preview"], cwd=work, timeout=30, client_id=client_id,
                            env={**os.environ, "TEXMFVAR": str(texmf)},
                        )
                        if bibtex.returncode:
                            raise RuntimeError((bibtex.stdout + bibtex.stderr)[-6000:])
                        used_bibtex = True
                    result = run_latex()
                    if used_bibtex or _needs_rerun(result.stdout + result.stderr):
                        run_latex()
                    pdf = (work / "preview.pdf").read_bytes()
                    synctex = (work / "preview.synctex.gz").read_bytes()
            finally:
                _compile_slots.release()
            elapsed_ms = round((time.monotonic() - started) * 1000)
            compile_id = _cache_put(cache_key, pdf, synctex, elapsed_ms)
            self._json(HTTPStatus.OK, {"elapsed_ms": elapsed_ms, "cached": False, "compile_id": compile_id, "pdf_audit": _pdf_audit(pdf), "pdf_base64": base64.b64encode(pdf).decode()})
        except (KeyError, ValueError, binascii.Error, RuntimeError, subprocess.TimeoutExpired) as error:
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
            if len(synctex) > 8_000_000:
                raise ValueError("SyncTeX data is too large")
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
            source = PurePosixPath(input_match.group(1).strip()).name
            self._json(HTTPStatus.OK, {"file": source, "line": int(line_match.group(1)), "column": max(0, int(column_match.group(1))) if column_match else 0})
        except (KeyError, ValueError, binascii.Error, subprocess.TimeoutExpired) as error:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error)})

    def _read_synctex_payload(self, payload: dict[str, object]) -> bytes:
        compile_id = payload.get("compile_id")
        if isinstance(compile_id, str) and re.fullmatch(r"[0-9a-f]{24}", compile_id):
            synctex = _synctex_get(compile_id)
            if synctex is None:
                raise ValueError("SyncTeX cache expired; render the PDF again.")
            return synctex
        encoded = payload.get("synctex_base64")
        if not isinstance(encoded, str):
            raise ValueError("SyncTeX data is required")
        synctex = base64.b64decode(encoded, validate=True)
        if len(synctex) > 8_000_000:
            raise ValueError("SyncTeX data is too large")
        return synctex

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
            remote_assets = payload.get("remote_assets", {})
            project_slug = payload.get("project_slug", "")
            if not isinstance(files, dict) or not isinstance(files.get("main.tex"), str):
                raise ValueError("main.tex is required")
            if not isinstance(assets, dict) or not isinstance(remote_assets, dict) or len(files) + len(assets) + len(remote_assets) > MAX_PROJECT_FILES:
                raise ValueError("too many project files")
            source_paths = {name: safe_project_path(name, SOURCE_EXTENSIONS) for name in files}
            asset_paths = {name: safe_project_path(name, ASSET_EXTENSIONS) for name in assets}
            remote_paths = {name: safe_project_path(name, ASSET_EXTENSIONS) for name in remote_assets}
            if set(source_paths) & (set(asset_paths) | set(remote_paths)) or set(asset_paths) & set(remote_paths):
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
            if remote_assets:
                if not isinstance(project_slug, str) or not PROJECT_SLUG_PATTERN.fullmatch(project_slug):
                    raise ValueError("invalid project slug")
                root = DEFAULT_PROJECT_ROOT if project_slug == "default" else PROJECT_LIBRARY_ROOT / project_slug
                for destination, source_name in remote_assets.items():
                    source = root / safe_project_path(source_name, ASSET_EXTENSIONS)
                    if not source.is_file():
                        raise ValueError(f"project asset not found: {source_name}")
                    data = source.read_bytes()
                    asset_bytes += len(data)
                    packaged[remote_paths[destination].as_posix()] = data
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
