from __future__ import annotations

import base64
import json
import os
import re
import tempfile
import time
from pathlib import Path

from .latex import _run_process
from .validation import decode_assets, decode_base64, read_bounded, safe_project_path, validated_project_paths

# Rebuttal artifacts use request-scoped workspaces, never the manuscript caches.
MAX_REBUTTAL_REQUEST_BYTES = 16_000_000
MAX_REVIEW_PDF_BYTES = 10_000_000
MAX_REVIEW_PAGES = 100
MAX_REBUTTAL_TEXT_BYTES = 1_000_000
MAX_REBUTTAL_OUTPUT_BYTES = 16_000_000
REBUTTAL_BODY_PLACEHOLDER = "%%REBUTTAL_BODY%%"
DEFAULT_REBUTTAL_TEMPLATE = r"""\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{amsmath,amssymb,longtable,booktabs,array,graphicx}
\usepackage[margin=1in]{geometry}
\usepackage[hidelinks]{hyperref}
\providecommand{\tightlist}{\setlength{\itemsep}{0pt}\setlength{\parskip}{0pt}}
\begin{document}
%%REBUTTAL_BODY%%
\end{document}
"""


def _rebuttal_environment(work: Path) -> dict[str, str]:
    # No application credentials, manuscript paths, or proxy settings are inherited.
    return {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": str(work), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
        "TEXMFVAR": str(work / ".texmf"), "TEXMFCONFIG": str(work / ".texmf"),
        "openin_any": "p", "openout_any": "p",
    }


def _rebuttal_process(command: list[str], work: Path, deadline: float, *, runner=_run_process) -> str:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError("rebuttal operation timed out")
    # Empty client ID avoids the manuscript compile cancellation registry entirely.
    result = runner(["prlimit", "--as=805306368", "--fsize=16777216", "--cpu=20", "--", *command], work, _rebuttal_environment(work), "", min(20, max(1, int(remaining))))
    if result.returncode:
        raise ValueError(f"{command[0]} failed during rebuttal processing")
    return result.stdout


def _review_page_count(path: Path, work: Path, deadline: float, process=_rebuttal_process) -> int:
    output = process(["pdfinfo", str(path)], work, deadline)
    match = re.search(r"^Pages:\s+(\d+)\s*$", output, re.MULTILINE)
    if not match or not 1 <= int(match.group(1)) <= MAX_REVIEW_PAGES:
        raise ValueError("PDF page count is missing or exceeds 100 pages")
    return int(match.group(1))


def extract_review(payload: dict, *, process=_rebuttal_process) -> dict[str, object]:
    if set(payload) != {"data_base64"} or not isinstance(payload["data_base64"], str):
        raise ValueError("data_base64 is required")
    data = decode_base64(payload["data_base64"], MAX_REVIEW_PDF_BYTES, "review PDF")
    if not data.startswith(b"%PDF-"):
        raise ValueError("invalid PDF or PDF exceeds 10 MB")
    deadline = time.monotonic() + 45
    with tempfile.TemporaryDirectory(prefix="rebuttal-review-") as directory:
        work = Path(directory)
        path = work / "review.pdf"
        path.write_bytes(data)
        page_count = _review_page_count(path, work, deadline, process)
        extracted = work / "review.txt"
        process(["pdftotext", "-layout", "-enc", "UTF-8", str(path), str(extracted)], work, deadline)
        chunks = read_bounded(extracted, MAX_REBUTTAL_TEXT_BYTES, "extracted review text").decode("utf-8").split("\f")
        if chunks and not chunks[-1].strip():
            chunks.pop()
        if len(chunks) > page_count:
            raise ValueError("PDF extraction returned an invalid page count")
        pages = [{"page": index + 1, "text": chunks[index].strip() if index < len(chunks) else ""} for index in range(page_count)]
        text = "\n\n".join(str(page["text"]) for page in pages)
        if not text.strip():
            raise ValueError("PDF has no extractable text; provide a text review or run OCR first")
        return {"pages": pages, "text": text}


def _validate_rebuttal_tex(text: str) -> None:
    # TeX is a programming language: restrict file access primitives in supplied
    # templates and generated math in addition to -no-shell-escape/openin_any.
    checked = re.sub(r"(?m)(?<!\\)%.*$", "", text)
    if "^^" in checked or re.search(
        r"\\(?:input|include|includeonly|openin|openout|read|readline|write|immediate|special|catcode|csname|endcsname|newread|newwrite|loop|repeat|everyjob|everyeof|scantokens|directlua|latelua|usepackage|RequirePackage|documentclass)\b", checked
    ):
        raise ValueError("unsafe TeX command in rebuttal content")


def render_rebuttal(payload: dict, *, process=_rebuttal_process) -> dict[str, object]:
    if set(payload) - {"documents", "template", "assets"}:
        raise ValueError("invalid rebuttal render fields")
    documents = payload.get("documents")
    if not isinstance(documents, list) or not 1 <= len(documents) <= 50:
        raise ValueError("1 to 50 rebuttal documents are required")
    ids: set[str] = set()
    sections: list[str] = []
    for document in documents:
        if not isinstance(document, dict) or set(document) != {"id", "title", "text"}:
            raise ValueError("invalid rebuttal document")
        identifier, title, text = (document[key] for key in ("id", "title", "text"))
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", identifier) or identifier in ids:
            raise ValueError("invalid or duplicate rebuttal document id")
        ids.add(identifier)
        if not isinstance(title, str) or len(title) > 500 or not isinstance(text, str):
            raise ValueError("invalid rebuttal document text")
        if not text.strip():
            raise ValueError("blank rebuttal documents cannot be rendered")
        # Titles are literal headings; documents remain user-authored Markdown.
        safe_title = re.sub(r"([\\`*_{}\[\]<>#!|])", r"\\\1", title.replace("\r", " ").replace("\n", " "))
        sections.append(f"# {safe_title}\n\n{text}")
    markdown = "\n\n".join(sections)
    if len(markdown.encode()) > MAX_REBUTTAL_TEXT_BYTES:
        raise ValueError("rebuttal text exceeds 1 MB")
    template = payload.get("template")
    files: dict[str, str] = {"main.tex": DEFAULT_REBUTTAL_TEMPLATE}
    entrypoint = "main.tex"
    if template is not None:
        if not isinstance(template, dict) or set(template) != {"files", "entrypoint"}:
            raise ValueError("invalid rebuttal template")
        files, entrypoint = template["files"], template["entrypoint"]
        if not isinstance(files, dict) or not 1 <= len(files) <= 30 or not isinstance(entrypoint, str) or entrypoint not in files:
            raise ValueError("invalid rebuttal template files")
        for name, content in files.items():
            safe_project_path(name, {".tex", ".sty", ".cls"})
            if not isinstance(content, str) or len(content.encode()) > 200_000:
                raise ValueError("invalid rebuttal template source")
            # Permit normal class/package declarations, while rejecting arbitrary
            # file primitives; custom style/class files are checked identically.
            safe_content = re.sub(r"\\(?:documentclass|usepackage|RequirePackage)(?:\[[^\]\r\n]*\])?\{[A-Za-z0-9,._-]+\}", "", content)
            _validate_rebuttal_tex(safe_content)
        if safe_project_path(entrypoint, {".tex"}).suffix != ".tex":
            raise ValueError("template entrypoint must be TeX")
    if files[entrypoint].count(REBUTTAL_BODY_PLACEHOLDER) != 1:
        raise ValueError("template entrypoint requires one %%REBUTTAL_BODY%% placeholder")
    assets = payload.get("assets", {})
    if not isinstance(assets, dict) or len(assets) > 30:
        raise ValueError("invalid rebuttal assets")
    source_paths, asset_paths = validated_project_paths(
        files, assets, len(json.dumps(payload).encode()),
        reserved_names=frozenset({"body.md", "body.tex", "rebuttal.pdf", "rebuttal.tex"}),
    )
    decoded_assets = decode_assets(assets, MAX_REVIEW_PDF_BYTES)
    deadline = time.monotonic() + 60
    with tempfile.TemporaryDirectory(prefix="rebuttal-render-") as directory:
        work = Path(directory)
        (work / "body.md").write_text(markdown, encoding="utf-8")
        # No raw TeX/HTML blocks, image fetching, Lua, filters, or user CLI flags.
        process(["pandoc", "--sandbox", "--from=markdown-raw_tex-raw_html", "--to=latex", "--output=body.tex", "body.md"], work, deadline)
        body = read_bounded(work / "body.tex", 2 * MAX_REBUTTAL_TEXT_BYTES, "converted rebuttal text").decode("utf-8")
        _validate_rebuttal_tex(body)
        if re.search(r"\\includegraphics(?:\[[^\]]*\])?\{(?:[a-z]+:|/|[^}]*\.\.)", body, re.I):
            raise ValueError("external or escaping image paths are not accepted")
        rendered_files = {**files, entrypoint: files[entrypoint].replace(REBUTTAL_BODY_PLACEHOLDER, body)}
        for name, content in rendered_files.items():
            destination = work / source_paths[name]
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content, encoding="utf-8")
        for name, data in decoded_assets.items():
            destination = work / asset_paths[name]
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        for _ in range(2):
            process(["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "-jobname=rebuttal", entrypoint], work, deadline)
        pdf_path = work / "rebuttal.pdf"
        pdf = read_bounded(pdf_path, MAX_REBUTTAL_OUTPUT_BYTES, "rendered PDF")
        if not pdf.startswith(b"%PDF-"):
            raise ValueError("renderer did not produce a PDF")
        pages = _review_page_count(pdf_path, work, deadline, process)
        return {"pdf": base64.b64encode(pdf).decode(), "page_count": pages, "files": rendered_files, "warnings": []}
