from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Support package imports, direct file imports, and python /app/server.py.
module_dir = Path(__file__).resolve().parent
module_parent = str(module_dir.parent if module_dir.name == "compiler" else module_dir)
if module_parent not in sys.path:
    sys.path.insert(0, module_parent)

from compiler import latex, rebuttal_render, synctex as sync, validation
from compiler.latex import BUILD_STATE_EXTENSIONS, MAX_PROCESS_LOG_BYTES, _auxiliary_digest, _bibliography_signature, _pdf_audit, _restore_build_artifacts, compiler_health_errors
from compiler.rebuttal_render import (
    DEFAULT_REBUTTAL_TEMPLATE, MAX_REBUTTAL_OUTPUT_BYTES, MAX_REBUTTAL_REQUEST_BYTES,
    MAX_REBUTTAL_TEXT_BYTES, MAX_REVIEW_PAGES, MAX_REVIEW_PDF_BYTES, REBUTTAL_BODY_PLACEHOLDER,
    _rebuttal_environment, _review_page_count, _validate_rebuttal_tex,
)
from compiler.state import (
    BUILD_STATE_ITEMS, BUILD_STATE_MAX_BYTES, BUILD_STATE_TOTAL_BYTES, BUILD_STATE_TTL,
    COMPILE_CACHE_ITEMS, COMPILE_CACHE_MAX_BYTES, COMPILE_CACHE_TTL,
    COMPILE_SINGLEFLIGHT_WAIT_SECONDS, BuildGeneration, BuildState,
    CompileFailure, CompileResult, CompilerRuntime,
)
from compiler.synctex import MAX_SYNCTEX_BYTES, MAX_SYNCTEX_EXPANDED_BYTES, synctex_source_path
from compiler.validation import (
    ASSET_EXTENSIONS, FRAGMENT_WRAPPER, MAX_ASSET_BYTES, MAX_PROJECT_WORKSPACE_BYTES,
    MAX_REQUEST_BYTES, PROJECT_ENTRY_OVERHEAD_BYTES, SOURCE_EXTENSIONS, decode_assets,
    decode_base64, load_payload, read_bounded, safe_project_path, validate_asset_budget,
)

MAX_CONCURRENT_COMPILES = max(1, int(os.environ.get("PAPER_MAX_CONCURRENT_COMPILES", "2")))
MAX_LATEX_PASSES = 3
MAX_PDF_BYTES = 32_000_000
logger = logging.getLogger(__name__)

_default_runtime = CompilerRuntime(settings=sys.modules.get(__name__), compile_limit=MAX_CONCURRENT_COMPILES)
_build_states = _default_runtime.build_states
_compile_cache = _default_runtime.compile_cache
_synctex_cache = _default_runtime.synctex_cache
_compile_flights = _default_runtime.flights
_compile_flight_lock = _default_runtime.flight_lock
_claim_compile_flight = _default_runtime.claim_flight
_finish_compile_flight = _default_runtime.finish_flight
_build_state_get = _default_runtime.build_state_get
_build_state_put = _default_runtime.build_state_put


def _cache_get(key):
    result = _default_runtime.cache_get(key)
    return (result.pdf, result.synctex, result.elapsed_ms) if result else None


def _cache_put(key, pdf, synctex, elapsed_ms, actor=""):
    return _default_runtime.cache_put(key, CompileResult(pdf, synctex, elapsed_ms), actor).compile_id


def _synctex_get(compile_id, actor=""):
    record = _default_runtime.get_synctex(actor, compile_id=compile_id)
    return record.data if record else None


def _snapshot_build_artifacts(work):
    return latex._snapshot_build_artifacts(work, BUILD_STATE_MAX_BYTES)


def _run_process(command, cwd, env, client_id, timeout, *, runtime=None):
    return latex._run_process(command, cwd, env, client_id, timeout, runtime=runtime,
                              log_limit=MAX_PROCESS_LOG_BYTES)


def expanded_synctex(data):
    return sync.expanded_synctex(data, compressed_limit=MAX_SYNCTEX_BYTES,
                                 expanded_limit=MAX_SYNCTEX_EXPANDED_BYTES)


def validated_synctex(data):
    expanded_synctex(data)
    return data


def normalized_synctex(data, work, project_tex_paths, *, mask_unmapped=False):
    return sync.normalized_synctex(data, work, project_tex_paths,
                                    compressed_limit=MAX_SYNCTEX_BYTES,
                                    expanded_limit=MAX_SYNCTEX_EXPANDED_BYTES,
                                    mask_unmapped=mask_unmapped)


def validated_project_paths(files, assets, request_bytes):
    return validation.validated_project_paths(
        files, assets, request_bytes, budget=MAX_PROJECT_WORKSPACE_BYTES,
        path_validator=safe_project_path,
    )


def _rebuttal_process(command, work, deadline):
    return rebuttal_render._rebuttal_process(command, work, deadline, runner=_run_process)


def extract_review(payload):
    return rebuttal_render.extract_review(payload, process=_rebuttal_process)


def render_rebuttal(payload):
    return rebuttal_render.render_rebuttal(payload, process=_rebuttal_process)


def restricted_tex_environment(texmf: Path) -> dict[str, str]:
    """Keep TeX reads/writes within its normal search paths and request workspace."""
    return {
        **os.environ,
        "TEXMFVAR": str(texmf),
        "TEXMFCONFIG": str(texmf),
        "openin_any": "p",
        "openout_any": "p",
    }


def _needs_rerun(output: str) -> bool:
    markers = (
        "Rerun to get cross-references right",
        "Label(s) may have changed",
        "There were undefined references",
        "There were undefined citations",
    )
    return any(marker in output for marker in markers)


def _run_latex_build(
    work: Path,
    compile_input: Path,
    files: dict[str, str],
    client_id: str | BuildGeneration,
    texmf: Path,
    warm: bool,
    previous_bibliography_signature: str,
    runner=None,
) -> tuple[int, int, str]:
    process = runner if runner is not None else _run_process
    environment = restricted_tex_environment(texmf)

    def run_latex() -> subprocess.CompletedProcess[str]:
        result = process(
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
    aux = read_bounded(aux_path, latex.MAX_AUXILIARY_BYTES, "generated auxiliary data").decode("utf-8", errors="replace")
    bibliography_signature = _bibliography_signature(aux, files)
    used_bibtex = "\\bibdata" in aux and (
        not (work / "preview.bbl").is_file()
        or bibliography_signature != previous_bibliography_signature
    )
    bibtex_runs = 0
    if used_bibtex:
        bibtex = process(
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
    timeout = 15

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            errors = compiler_health_errors()
            self._json(
                HTTPStatus.SERVICE_UNAVAILABLE if errors else HTTPStatus.OK,
                {"status": "dependency-error" if errors else "ok", "error_count": len(errors)},
            )
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    @property
    def runtime(self) -> CompilerRuntime:
        return getattr(self.server, "runtime", _default_runtime)

    def do_POST(self) -> None:  # noqa: N802
        if not self.runtime.request_slots.acquire(blocking=False):
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "compiler request capacity reached; retry shortly"})
            return
        try:
            if self.path in {"/extract-review", "/rebuttal-render"}:
                self._rebuttal()
            elif self.path == "/synctex":
                self._synctex()
            elif self.path == "/synctex-view":
                self._synctex_view()
            elif self.path == "/package":
                self._package()
            elif self.path == "/compile":
                self._compile()
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except RecursionError:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": "request is nested too deeply"})
        finally:
            self.runtime.request_slots.release()

    def _read_body(self, limit: int, size_error="project exceeds 48 MB") -> bytes:
        size = int(self.headers.get("Content-Length", "0"))
        if not 1 <= size <= limit:
            raise ValueError(size_error)
        raw = self.rfile.read(size)
        if len(raw) != size:
            raise ValueError("incomplete request body")
        return raw

    def _compile(self) -> None:
        try:
            raw = self._read_body(MAX_REQUEST_BYTES)
            payload = load_payload(raw)
            actor = self.headers.get("X-Paper-Actor", "")
            digest = hashlib.sha256(actor.encode() + b"\0")
            digest.update(raw)
            key = digest.hexdigest()
            size = len(raw)
            del raw

            client_id = self.headers.get("X-Compile-Client", "")
            if client_id and not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", client_id):
                raise ValueError("invalid compile client")
            workspace_id = payload.get("workspace_id", "")
            if not isinstance(workspace_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", workspace_id):
                raise ValueError("invalid workspace id")
            entrypoint = payload.get("entrypoint", "main.tex")
            root_entrypoint = payload.get("root_entrypoint", "main.tex")
            preview_mode = payload.get("preview_mode", "document")
            build_mode = payload.get("build_mode", "incremental")
            if preview_mode not in ("document", "fragment") or build_mode not in ("incremental", "clean"):
                raise ValueError("invalid preview or build mode")
            files = payload["files"]
            assets = payload.get("assets", {})
            if payload.get("remote_assets"):
                raise ValueError("remote project assets are not accepted; include request-scoped assets")
            if not isinstance(files, dict) or not isinstance(files.get("main.tex"), str):
                raise ValueError("main.tex is required")
            entrypoint_path = safe_project_path(entrypoint, {".tex"})
            root_path = safe_project_path(root_entrypoint, {".tex"})
            scope = (actor, client_id, workspace_id)
            binding = (*scope, entrypoint_path.as_posix(), root_path.as_posix(), preview_mode)
            requested_state_id = self.headers.get("X-Compile-State", "") if client_id else ""
            runtime = self.runtime
            if result := runtime.cache_get(key):
                if client_id:
                    runtime.supersede_for_cache_hit(scope, key)
                del payload, files, assets
                self._send_compile_result(result, binding, requested_state_id, cached=True)
                return

            source_paths, asset_paths = validated_project_paths(files, assets, size)
            source_files = {path.as_posix(): files[name] for name, path in source_paths.items()}
            if entrypoint_path.as_posix() not in source_files or root_path.as_posix() not in source_files:
                raise ValueError("entrypoint or root entrypoint is missing")
            if any(not isinstance(content, str) for content in source_files.values()):
                raise ValueError("invalid project file")
            validate_asset_budget(assets, MAX_ASSET_BYTES)
            del payload, files, source_paths
            leader, flight, generation = runtime.claim_build(key, scope if client_id else None)
            if not leader:
                del assets, asset_paths, source_files
                if flight.wait(COMPILE_SINGLEFLIGHT_WAIT_SECONDS) and flight.outcome is not None:
                    self._send_compile_result(flight.outcome, binding, requested_state_id, cached=True)
                else:
                    self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "identical compile is still running; retry shortly"})
                return

            outcome = CompileFailure(HTTPStatus.INTERNAL_SERVER_ERROR, "compiler failed to build project")
            cached = False
            try:
                if result := runtime.cache_get(key):
                    outcome = result
                    cached = True
                else:
                    _compile_slots = runtime.compile_slots
                    if not _compile_slots.acquire(blocking=False):
                        outcome = CompileFailure(HTTPStatus.SERVICE_UNAVAILABLE, "compiler is busy; retry shortly")
                    else:
                        try:
                            decoded_assets = decode_assets(assets, MAX_ASSET_BYTES)
                            del assets
                            bound_state = runtime.build_state_get(requested_state_id, binding)
                            result = self._build_project(
                                source_files, asset_paths, decoded_assets, entrypoint_path, root_path,
                                preview_mode, bound_state if build_mode == "incremental" else None,
                                generation, actor,
                            )
                            del decoded_assets, source_files, asset_paths
                            outcome = runtime.cache_put(key, result, actor, generation=generation)
                        finally:
                            _compile_slots.release()
            except (ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                outcome = CompileFailure(HTTPStatus.UNPROCESSABLE_ENTITY, str(error))
            except OSError:
                outcome = CompileFailure(HTTPStatus.INTERNAL_SERVER_ERROR, "compiler workspace I/O failed")
            except Exception:
                logger.exception("Unexpected compiler failure")
            finally:
                runtime.end_generation(generation)
                runtime.finish_flight(key, flight, outcome)
            self._send_compile_result(outcome, binding, requested_state_id, cached=cached)
        except (KeyError, ValueError) as error:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error)})
        except OSError:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "compiler I/O failed"})

    def _build_project(self, files, asset_paths, assets, entrypoint, root_entrypoint,
                       preview_mode, bound_state, generation, actor) -> CompileResult:
        started = time.monotonic()
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            texmf = work / ".texmf"
            try:
                texmf.mkdir()
                for name, content in files.items():
                    destination = work / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_text(content, encoding="utf-8")
                for name, content in assets.items():
                    destination = work / asset_paths[name]
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(content)
                if bound_state is not None:
                    _restore_build_artifacts(work, bound_state.artifacts)
                if preview_mode == "fragment":
                    preamble, marker, _ = files[root_entrypoint.as_posix()].partition("\\begin{document}")
                    if not marker:
                        raise ValueError("root entrypoint has no document preamble")
                    wrapper = (
                        f"{preamble}\n\\begin{{document}}\n\\appendix\n"
                        f"\\input{{{entrypoint.as_posix()}}}\n\\end{{document}}\n"
                    )
                    entrypoint = Path(FRAGMENT_WRAPPER)  # __fragment_preview.tex
                    (work / entrypoint).write_text(wrapper, encoding="utf-8")
            except (FileExistsError, IsADirectoryError, NotADirectoryError) as error:
                raise ValueError("project paths conflict with compiler workspace files") from error

            warm = bound_state is not None
            passes, bibtex_runs, signature = _run_latex_build(
                work, entrypoint, files, generation or "", texmf, warm,
                bound_state.bibliography_signature if warm else "", partial(_run_process, runtime=self.runtime),
            )
            pdf = read_bounded(work / "preview.pdf", MAX_PDF_BYTES, "generated PDF")
            project_tex_paths = frozenset(name for name in files if Path(name).suffix.lower() == ".tex")
            synctex = normalized_synctex(
                read_bounded(work / "preview.synctex.gz", MAX_SYNCTEX_BYTES, "generated SyncTeX"),
                work, project_tex_paths, mask_unmapped=True,
            )
            synctex = sync.sign_synctex(synctex, actor, self.runtime.synctex_key)
            if len(synctex) > MAX_SYNCTEX_BYTES:
                raise ValueError("signed SyncTeX data exceeds size limit")
            artifacts = _snapshot_build_artifacts(work)
        audit = _pdf_audit(pdf)
        return CompileResult(
            pdf, synctex, round((time.monotonic() - started) * 1000),
            paths=project_tex_paths, artifacts=artifacts, bibliography_signature=signature,
            warm=warm, passes=passes, bibtex_runs=bibtex_runs, pdf_audit=audit,
        )

    def _send_compile_result(self, outcome, binding, requested_state_id, *, cached):
        if isinstance(outcome, CompileFailure):
            self._json(outcome.status, {"error": outcome.message})
            return
        actor, client_id, *_ = binding
        if cached:
            self.runtime.refresh_synctex(outcome, actor)
        token = self.runtime.build_state_put(
            binding, outcome.artifacts, outcome.bibliography_signature, requested_state_id,
        ) if client_id else None
        self._json(HTTPStatus.OK, {
            "elapsed_ms": 0 if cached else outcome.elapsed_ms,
            "cached": cached,
            "build_mode": "cached" if cached else "incremental" if outcome.warm else "clean",
            "passes": 0 if cached else outcome.passes,
            "bibtex_runs": 0 if cached else outcome.bibtex_runs,
            "build_state_id": token or "",
            "compile_id": outcome.compile_id,
            "pdf_audit": outcome.pdf_audit,
            "pdf_base64": base64.b64encode(outcome.pdf).decode(),
            "synctex_base64": base64.b64encode(outcome.synctex).decode(),
        })

    def _synctex(self) -> None:
        try:
            payload = load_payload(self._read_body(MAX_REQUEST_BYTES, "SyncTeX request is too large"))
            page = int(payload["page"])
            x = float(payload["x"])
            y = float(payload["y"])
            if page < 1 or page > 200 or not 0 <= x <= 2000 or not 0 <= y <= 3000:
                raise ValueError("invalid PDF coordinate")
            reference = self._read_synctex_reference(payload)
            if isinstance(reference, bytes):
                actor = self.headers.get("X-Paper-Actor", "")
                synctex = sync.verify_synctex(reference, actor, self.runtime.synctex_key)
                project_paths = sync.project_paths(expanded_synctex(synctex))
            else:
                synctex = reference.data
                project_paths = reference.paths
            with tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                (work / "main.synctex.gz").write_bytes(synctex)
                (work / "main.pdf").write_bytes(b"%PDF-1.4\n")
                result = subprocess.run(
                    ["synctex", "edit", "-o", f"{page}:{x:.3f}:{y:.3f}:main.pdf"],
                    cwd=work, text=True, encoding="utf-8", errors="replace",
                    capture_output=True, timeout=10, check=False,
                )
                location = sync.reverse_location(result, work, project_paths)
            if location is None:
                raise ValueError("해당 PDF 위치에 연결된 LaTeX 줄을 찾지 못했습니다.")
            self._json(HTTPStatus.OK, location)
        except (KeyError, ValueError, TypeError, OSError, subprocess.TimeoutExpired) as error:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error)})

    def _read_synctex_reference(self, payload):
        compile_id = payload.get("compile_id")
        if isinstance(compile_id, str) and re.fullmatch(r"[0-9a-f]{24}", compile_id):
            actor = self.headers.get("X-Paper-Actor", "")
            record = self.runtime.get_synctex(actor, compile_id=compile_id)
            if record is None:
                raise ValueError("SyncTeX cache expired; render the PDF again.")
            return record
        return decode_base64(payload.get("synctex_base64"), MAX_SYNCTEX_BYTES, "SyncTeX")

    def _read_synctex_payload(self, payload):
        reference = self._read_synctex_reference(payload)
        return validated_synctex(reference) if isinstance(reference, bytes) else reference.data

    def _synctex_view(self) -> None:
        try:
            payload = load_payload(self._read_body(MAX_REQUEST_BYTES, "SyncTeX request is too large"))
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
        except (KeyError, ValueError, TypeError, OSError, subprocess.TimeoutExpired) as error:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error)})

    def _package(self) -> None:
        try:
            raw = self._read_body(MAX_REQUEST_BYTES)
            size = len(raw)
            payload = load_payload(raw)
            del raw
            files = payload.get("files", {})
            assets = payload.get("assets", {})
            if payload.get("remote_assets"):
                raise ValueError("remote project assets are not accepted; include request-scoped assets")
            if not isinstance(files, dict) or not isinstance(files.get("main.tex"), str):
                raise ValueError("main.tex is required")
            source_paths, asset_paths = validated_project_paths(files, assets, size)
            decoded_assets = decode_assets(assets, MAX_ASSET_BYTES)
            packaged: dict[str, bytes] = {}
            for name, content in files.items():
                if not isinstance(content, str):
                    raise ValueError("invalid source file")
                packaged[source_paths[name].as_posix()] = content.encode("utf-8")
            packaged.update((asset_paths[name].as_posix(), data) for name, data in decoded_assets.items())
            checksums = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(packaged.items()))
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
                for name, data in sorted(packaged.items()):
                    bundle.writestr(name, data)
                bundle.writestr("SHA256SUMS", checksums.encode("utf-8"))
            self._json(HTTPStatus.OK, {"zip_base64": base64.b64encode(archive.getvalue()).decode(), "file_count": len(packaged), "sha256": hashlib.sha256(archive.getvalue()).hexdigest()})
        except (KeyError, ValueError, OSError) as error:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error)})

    def _rebuttal(self) -> None:
        acquired = False
        try:
            acquired = self.runtime.rebuttal_slots.acquire(blocking=False)
            if not acquired:
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "rebuttal compiler is busy"})
                return
            payload = load_payload(self._read_body(MAX_REBUTTAL_REQUEST_BYTES, "rebuttal request exceeds limit"))
            result = extract_review(payload) if self.path == "/extract-review" else render_rebuttal(payload)
            self._json(HTTPStatus.OK, result)
        except (ValueError, KeyError, TypeError, OSError, binascii.Error, subprocess.TimeoutExpired) as error:
            self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error)})
        finally:
            if acquired:
                self.runtime.rebuttal_slots.release()

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



def create_server(address=("0.0.0.0", 8000), *, runtime: CompilerRuntime | None = None) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(address, Handler)
    server.runtime = runtime if runtime is not None else CompilerRuntime(compile_limit=MAX_CONCURRENT_COMPILES)
    return server


if __name__ == "__main__":
    create_server().serve_forever()
