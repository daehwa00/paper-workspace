"""Lossless block planning and incremental, reusable Korean translation."""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from copy import deepcopy

try:
    from .analysis import ARRAYS, AnalysisCancelled, AnalysisError, _technical_only, _validate_korean_translation
    from .imports import UpstreamRequestError
except ImportError:
    from analysis import ARRAYS, AnalysisCancelled, AnalysisError, _technical_only, _validate_korean_translation
    from imports import UpstreamRequestError

VERSION = "rebuttal-paragraph-translation-v1"
TARGET_CHARS = 1600
MIN_TARGET_CHARS = 1200
MAX_BLOCK_CHARS = 8000
_PARAGRAPH_GAP = re.compile(r"(?:\r\n|\n|\r)[ \t]*(?:(?:\r\n|\n|\r)[ \t]*)+")
_FENCE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r|$)", re.M)
_INLINE = re.compile(
    r"(?<!\\)\$\$.*?(?<!\\)\$\$|\\\[.*?\\\]|\\\(.*?\\\)|"
    r"(?<![\\$])\$(?!\$)(?:\\.|[^$])*?(?<!\\)\$(?!\$)|"
    r"(?P<ticks>`+)(?!`)[^`]*?(?P=ticks)(?!`)", re.S,
)


def _protected_ranges(source):
    """Keep fenced code, inline code and TeX intact, including blank lines."""
    ranges, position = [], 0
    while match := _FENCE.search(source, position):
        marker = match[1]
        closing = re.compile(r"^[ \t]{0,3}" + re.escape(marker[0]) + "{" + str(len(marker)) + r",}[ \t]*(?=\r?$)", re.M)
        end = closing.search(source, match.end())
        stop = end.end() if end else len(source)
        ranges.append((match.start(), stop))
        position = stop
    for match in _INLINE.finditer(source):
        if not any(start <= match.start() < end for start, end in ranges):
            ranges.append(match.span())
    return sorted(ranges)


def _inside(position, protected):
    return any(start < position < end for start, end in protected)


def _trimmed_parts(source):
    """Whitespace is a local token, independent of each paragraph's cache key."""
    left = len(source) - len(source.lstrip())
    right = len(source.rstrip())
    if left:
        yield source[:left]
    if right > left:
        yield source[left:right]
    if right < len(source) and right > left:
        yield source[right:]


def _split_long(source):
    if source and not source.strip():
        yield source
        return
    while len(source) > TARGET_CHARS:
        protected = _protected_ranges(source)
        spaces = [match.start() for match in re.finditer(r"\s+", source)
                  if match.start() and not _inside(match.start(), protected)]
        sentences = [match.end() for match in re.finditer(r"[.!?。！？](?=\s)", source)
                     if not _inside(match.end(), protected)]
        preferred = [end for end in sentences if MIN_TARGET_CHARS <= end <= TARGET_CHARS]
        candidates = [end for end in spaces if end <= TARGET_CHARS]
        if preferred or candidates:
            end = max(preferred or candidates)
        else:
            later = [end for end in spaces if end <= MAX_BLOCK_CHARS]
            if later:
                end = min(later)
            elif len(source) <= MAX_BLOCK_CHARS:
                break
            else:
                raise AnalysisError("Translation block exceeds safe splitting limit")
        yield from _trimmed_parts(source[:end])
        source = source[end:]
        # Move the split's whitespace into its own token before the next split.
        leading = len(source) - len(source.lstrip())
        if leading:
            yield source[:leading]
            source = source[leading:]
    if source:
        yield from _trimmed_parts(source)


def _blocks(source):
    protected = _protected_ranges(source)
    position = 0
    for gap in _PARAGRAPH_GAP.finditer(source):
        if any(start < gap.end() and gap.start() < end for start, end in protected):
            continue
        yield from _split_long(source[position:gap.start()])
        yield gap[0]
        position = gap.end()
    yield from _split_long(source[position:])


def _cache_key(source, glossary, profile):
    try:
        value = json.dumps([VERSION, source, glossary, profile], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise AnalysisError("Invalid translation glossary or profile") from error
    return hashlib.sha256(value.encode()).hexdigest()


def _protected_content(source):
    tokens, blocks = [], []
    for start, end in _protected_ranges(source):
        token = source[start:end]
        tokens.append(token)
        if _FENCE.match(source, start) or source.startswith(('$$', r'\['), start):
            blocks.append(token)
    # Korean grammar can move inline expressions. Preserve their exact values
    # and occurrence counts, while keeping displayed equations and code in order.
    return Counter(tokens), blocks


def _validate_text(text, source):
    if not isinstance(text, str) or not text.strip():
        raise AnalysisError("Invalid translation block: nonempty text required")
    text = text.strip()
    if len(text) > max(512, len(source) * 4):
        raise AnalysisError("Invalid translation block: output is too long")
    if len(source) >= 80 and len(text.strip()) < max(12, len(source.strip()) // 7):
        raise AnalysisError("Invalid translation block: output is too short")
    if _protected_content(source) != _protected_content(text):
        raise AnalysisError("Invalid translation block: code or math changed")
    # Fenced code (including tilde fences) may contain prose comments verbatim.
    plain = source
    for start, end in reversed(_protected_ranges(source)):
        plain = plain[:start] + plain[end:]
    if text == source and _technical_only(plain):
        return text
    _validate_korean_translation(text, source)
    return text


def run_translation(payload, call_bridge, progress, cancelled, profile=None, cache_get=None, cache_put=None):
    """Translate missing blocks; emit immutable snapshots of contiguous prefixes.

    Cache storage and project isolation belong to the caller. A cache key never
    contains review IDs, so edits and moved or repeated paragraphs can reuse it.
    Retry a model timeout once for the affected block without replaying cached
    work. Validation failures retain their separate single repair attempt.
    """
    def check():
        if cancelled():
            raise AnalysisCancelled("Analysis cancelled")

    check()
    if not isinstance(payload, dict) or not isinstance(payload.get("reviews", []), list):
        raise AnalysisError("Invalid translation snapshot")
    snapshot = deepcopy(payload)
    glossary = snapshot.get("glossary", {})
    if not isinstance(glossary, dict):
        raise AnalysisError("Invalid translation glossary")
    fields, pending, review_ids = [], {}, set()
    for review in snapshot.get("reviews", []):
        check()
        if not isinstance(review, dict) or not isinstance(review.get("id"), str) or not review["id"].strip():
            raise AnalysisError("Invalid translation review ID")
        if review["id"] in review_ids:
            raise AnalysisError("Duplicate translation review ID")
        review_ids.add(review["id"])
        if not isinstance(review.get("fields", {}), dict):
            raise AnalysisError("Invalid translation review fields")
        for field, source in review.get("fields", {}).items():
            if not isinstance(field, str) or not field.strip() or not isinstance(source, str):
                raise AnalysisError("Invalid translation review field")
            record = {"review_id": review["id"], "field": field, "parts": []}
            for block in _blocks(source):
                part = {"source": block, "text": block if not block.strip() else None}
                record["parts"].append(part)
                if part["text"] is None:
                    if len(block) > MAX_BLOCK_CHARS:
                        raise AnalysisError("Translation block exceeds safe splitting limit")
                    key = _cache_key(block, glossary, profile)
                    if key not in pending:
                        pending[key] = {"source": block, "review_id": review["id"],
                                        "reviewer_id": review.get("reviewer_id"), "field": field, "parts": []}
                    pending[key]["parts"].append(part)
            fields.append(record)
    total = sum(len(item["parts"]) for item in pending.values())

    def translations():
        values = []
        for record in fields:
            segments = []
            for part in record["parts"]:
                if part["text"] is None:
                    break
                segments.append({"source": part["source"], "text": part["text"]})
            values.append({"review_id": record["review_id"], "field": record["field"],
                           "text": "".join(part["text"] for part in segments), "segments": segments, "uncertain": []})
        return values

    def emit(*, retrying=False):
        check()
        completed = sum(len(item["parts"]) for item in pending.values() if item["parts"][0]["text"] is not None)
        event = {"translations": translations(), "completed": completed, "total": total}
        if retrying:
            event["retrying"] = True
        progress(event)
        check()

    # Resolve every reusable block before the first new model invocation. Cached
    # suffixes count as complete but remain hidden behind a missing prefix.
    for key, item in pending.items():
        check()
        cached = cache_get(key) if cache_get else None
        check()
        if cached is not None:
            try:
                cached = _validate_text(cached, item["source"])
            except AnalysisError:
                continue
            for part in item["parts"]:
                part["text"] = cached
    emit()
    for key, item in pending.items():
        check()
        if item["parts"][0]["text"] is not None:
            continue
        request = {"reviews": [{"id": item["review_id"], "reviewer_id": item["reviewer_id"],
                                "fields": {item["field"]: item["source"]}}],
                   "documents": [], "concerns": [], "glossary": deepcopy(glossary), "phase": "translate_block"}
        timeout_retries = 0
        for attempt in range(2):
            while True:
                check()
                try:
                    raw = call_bridge("translate_block", deepcopy(request), profile)
                    break
                except UpstreamRequestError as error:
                    check()
                    if error.code != "model_timeout" or timeout_retries >= 1:
                        raise
                    timeout_retries += 1
                    emit(retrying=True)
            check()
            try:
                if not isinstance(raw, dict) or set(raw) != {"text"}:
                    raise AnalysisError("Invalid translation block: expected only text")
                text = _validate_text(raw["text"], item["source"])
                break
            except AnalysisError:
                if attempt:
                    raise
                request["phase"] = "translate_block_verify_quotes"
                request["validation_feedback"] = "translation"
        if cache_put:
            check()
            cache_put(key, text)
            check()
        for part in item["parts"]:
            part["text"] = text
        emit()
    result = {name: [] for name in ARRAYS}
    result["translations"] = translations()
    return result
