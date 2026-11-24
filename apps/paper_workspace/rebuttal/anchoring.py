"""Quote and sentence grounding against immutable snapshots."""
from __future__ import annotations

import hashlib
import json
import re


class AnalysisError(ValueError):
    pass


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _array(value, name):
    if not isinstance(value, list) or any(not isinstance(x, dict) for x in value):
        raise AnalysisError(f"{name} must be an array of objects")
    return value


def _text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise AnalysisError(f"{name} must be nonempty text")
    return value


# Numbered scholarly references use a period as part of the abbreviation.
_REFERENCE_ABBREVIATION = re.compile(
    r"\b(?:prop|props|cor|cors|thm|thms|lem|lems|def|defs|sec|secs|sect|sects|"
    r"tab|tabs|alg|algs|app|apps|supp|ex|exs|ref|refs|chap|chaps|vol|vols)\.$", re.I)
_REFERENCE_TARGET = re.compile(r"\s*(?:\d|[A-Z](?:\b|(?=\d))|[\[(]\s*(?:\d|[IVX]+\b)|\\(?:ref|eqref|autoref|cref|Cref)\b)")


def _sentence_boundaries(value):
    """Find clear boundaries while preserving numbered labels and citations."""
    if not isinstance(value, str): return []
    boundaries = []
    for match in re.finditer(r'[.!?。！？](?=\s+\S)', value):
        prefix = value[:match.end()]
        if match.group() == '.' and re.match(r'^\s*(?:[-*]\s*)?(?:Q\d+|\d+)\.$', prefix, re.I):
            continue
        if match.group() == '.' and re.search(r'(?:\b(?:e\.g|i\.e|etc|fig|eq|dr|mr|mrs|ms|vs|al|no)|\b[A-Z])\.$', prefix, re.I):
            continue
        if match.group() == '.' and _REFERENCE_ABBREVIATION.search(prefix) and _REFERENCE_TARGET.match(value[match.end():]):
            continue
        boundaries.append(match.end())
    return boundaries


def _multiple_sentences(value):
    return bool(_sentence_boundaries(value))


def _sentence_options(value):
    if not isinstance(value, str): return []
    starts = [0] + _sentence_boundaries(value)
    ends = _sentence_boundaries(value) + [len(value)]
    return [part for start, end in zip(starts, ends) if (part := value[start:end].strip())]


def _index(items, name):
    result = {}
    for item in _array(items, name):
        identity = _text(item.get("id"), f"{name}.id")
        if identity in result:
            raise AnalysisError(f"Duplicate {name} ID: {identity}")
        result[identity] = item
    return result


def _anchor(span, snapshots, source=False, *, use_supplied_start=False):
    if not isinstance(span, dict):
        raise AnalysisError("Span must be an object")
    key = "review_id" if source else "document_id"
    identity = span.get(key)
    if identity not in snapshots:
        raise AnalysisError(f"Unknown {key}: {identity}")
    item = snapshots[identity]
    if source:
        field = span.get("field")
        if field not in item.get("fields", {}):
            raise AnalysisError(f"Unknown review field: {field}")
        text = item["fields"][field]
    else:
        text = item.get("text", "")
    quote = _text(span.get("quote"), "quote")
    start = text.find(quote)
    if start < 0:
        raise AnalysisError(f"Quote absent from snapshot: {key}={identity}")
    result = {key: identity, "quote": quote}
    if source:
        result["field"] = field
    # Only offsets from a user's selection can disambiguate repeated text.
    start_units = len(text[:start].encode("utf-16-le")) // 2
    quote_bytes = quote.encode("utf-16-le")
    if text.find(quote, start + 1) >= 0:
        supplied = span.get("start")
        if not use_supplied_start or type(supplied) is not int or supplied < 0:
            return result, False
        encoded = text.encode("utf-16-le")
        if supplied > len(encoded) // 2 or not encoded.startswith(quote_bytes, supplied * 2):
            return result, False
        start_units = supplied
    result.update(start=start_units, end=start_units + len(quote_bytes) // 2)
    if not source:
        result["content_hash"] = hashlib.sha256(text.encode()).hexdigest()
    return result, True


def _rewrite_anchor(selection, documents):
    anchor, certain = _anchor(selection, documents, use_supplied_start=True)
    if not certain:
        raise AnalysisError("Ambiguous rewrite selection requires an exact offset")
    return anchor
