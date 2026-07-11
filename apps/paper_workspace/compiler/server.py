from __future__ import annotations

import base64
import binascii
import json
import os
import subprocess
import tempfile
import time
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
SOURCE_EXTENSIONS = {".tex", ".bib", ".sty", ".bst", ".cls", ".csv", ".txt", ".json", ".dat"}
ASSET_EXTENSIONS = {".png", ".jpg", ".jpeg", ".pdf", ".eps"}
MAX_REQUEST_BYTES = 12_000_000
MAX_PROJECT_FILES = 120
MAX_ASSET_BYTES = 8_000_000


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
    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/synctex":
            self._synctex()
            return
        if self.path != "/compile":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > MAX_REQUEST_BYTES:
                raise ValueError("project exceeds 12 MB")
            payload = json.loads(self.rfile.read(size))
            files = payload["files"]
            assets = payload.get("assets", {})
            if not isinstance(files, dict) or not isinstance(files.get("main.tex"), str):
                raise ValueError("main.tex is required")
            if not isinstance(assets, dict) or len(files) + len(assets) > MAX_PROJECT_FILES:
                raise ValueError("too many project files")
            source_paths = {name: safe_project_path(name, SOURCE_EXTENSIONS) for name in files}
            asset_paths = {name: safe_project_path(name, ASSET_EXTENSIONS) for name in assets}
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
                    raise ValueError("assets exceed 8 MB")
                decoded_assets[name] = decoded
            started = time.monotonic()
            with tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                texmf = work / ".texmf"
                texmf.mkdir()
                for name, content in files.items():
                    destination = work / source_paths[name]
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_text(content, encoding="utf-8")
                for name, content in decoded_assets.items():
                    destination = work / asset_paths[name]
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(content)
                for _ in range(1):
                    result = subprocess.run(
                        ["pdflatex", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "main.tex"],
                        cwd=work, text=True, encoding="utf-8", errors="replace",
                        capture_output=True, timeout=30, check=False,
                        env={**os.environ, "TEXMFVAR": str(texmf), "TEXMFCONFIG": str(texmf)},
                    )
                    if result.returncode:
                        raise RuntimeError((result.stdout + result.stderr)[-6000:])
                aux = (work / "main.aux").read_text(encoding="utf-8", errors="replace")
                if "\\bibdata" in aux:
                    bibtex = subprocess.run(
                        ["bibtex", "main"], cwd=work, text=True, encoding="utf-8",
                        errors="replace", capture_output=True,
                        timeout=30, check=False, env={**os.environ, "TEXMFVAR": str(texmf)},
                    )
                    if bibtex.returncode:
                        raise RuntimeError((bibtex.stdout + bibtex.stderr)[-6000:])
                for _ in range(3):
                    result = subprocess.run(
                        ["pdflatex", "-synctex=1", "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "main.tex"],
                        cwd=work, text=True, encoding="utf-8", errors="replace",
                        capture_output=True, timeout=30, check=False,
                        env={**os.environ, "TEXMFVAR": str(texmf), "TEXMFCONFIG": str(texmf)},
                    )
                    if result.returncode:
                        raise RuntimeError((result.stdout + result.stderr)[-6000:])
                pdf = (work / "main.pdf").read_bytes()
                synctex = (work / "main.synctex.gz").read_bytes()
            self._json(HTTPStatus.OK, {"elapsed_ms": round((time.monotonic() - started) * 1000), "pdf_base64": base64.b64encode(pdf).decode(), "synctex_base64": base64.b64encode(synctex).decode()})
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

    def _json(self, status: HTTPStatus, value: dict[str, object]) -> None:
        encoded = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
