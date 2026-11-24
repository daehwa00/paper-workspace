"""Validation and canonicalization of model results."""
from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from urllib.parse import urlsplit

if __package__:
    from .anchoring import AnalysisError, _anchor, _array, _hash, _index, _multiple_sentences, _rewrite_anchor, _text
else:
    from anchoring import AnalysisError, _anchor, _array, _hash, _index, _multiple_sentences, _rewrite_anchor, _text

TASKS = {"analyze", "translate", "map", "connect", "extract_concerns", "direct_connect", "style", "consistency", "simulate", "rewrite", "research_rules"}
ARRAYS = ("translations", "concerns", "mappings", "findings", "consistency", "simulated_questions", "rules_candidates")


def validation_issue(error):
    """Return a bounded diagnostic; never retain model output or source text."""
    message = str(error)
    exact = {
        'Each connection requires one review sentence and one response sentence': 'span_count',
        'Each connection must use a single sentence per side': 'multiple_sentences',
        'Invalid connection relationship': 'relationship',
        'Connection reason must be Korean': 'korean_reason',
        'connection reason must be nonempty text': 'empty_reason',
        'links must be an array of objects': 'links_format',
        'source_spans must be an array of objects': 'source_spans_format',
        'response_spans must be an array of objects': 'response_spans_format',
        'Actual concerns require review source evidence': 'missing_evidence',
    }
    if message in exact: return exact[message]
    if message.startswith('Quote absent from snapshot:'): return 'quote_absent'
    if message.startswith(('Unknown review_id:', 'Unknown document_id:', 'Unknown review field:', 'Unknown mapping concern ID', 'Concern reviewer does not match its source')): return 'unknown_reference'
    if message.startswith('Analysis context exceeds'): return 'context_too_large'
    if message == 'Invalid translation block: code or math changed': return 'translation_protected_content'
    if message.startswith(('Invalid translation', 'Translation block exceeds')): return 'translation'
    if message in {'Each review chunk requires exactly one Korean translation', 'Duplicate translation review and field', 'Translation must be Korean; regenerate the review translation', 'Empty review field must have an empty translation', 'Invalid translation', 'Unknown translation review or field'}: return 'translation'
    return 'other_validation'


def _rule_candidates(items):
    allowed = {"venue", "year", "track", "stage", "layout", "allow_common", "limits", "policies", "deadline", "sources", "notes"}
    result = []
    for item in _array(items, "rules_candidates"):
        candidate = {k: deepcopy(v) for k, v in item.items() if k in allowed}
        if "sources" in candidate:
            sources = _array(candidate["sources"], "sources")
            candidate["sources"] = [{**{k: v for k, v in s.items() if k in {"url", "title", "excerpt", "checked_at"}}, "status": "unverified"} for s in sources]
        result.append(candidate)
    return result


def _technical_only(text):
    """Allow unchanged numbers, identifiers and formulas, never English prose."""
    text = re.sub(r"```.*?```|\$\$.*?\$\$|\$[^$]*\$|\\\(.*?\\\)|\\\[.*?\\\]|https?://\S+", "", text, flags=re.S)
    text = re.sub(r"\b[A-Za-z_]\w*\s*=\s*[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", "", text)
    for token in re.findall(r"[^\W_]+(?:[-_.][^\W_]+)*", text):
        if token.isnumeric():
            continue
        identifier = any(c.isdigit() for c in token) or token.isupper() or len(token) == 1 or any(c.isupper() for c in token[1:])
        if not token.isascii() or not identifier:
            return False
    return True


def _validate_korean_translation(text, source):
    if not source.strip():
        if text.strip():
            raise AnalysisError("Empty review field must have an empty translation")
        return
    if _technical_only(source) and text.strip() == source.strip():
        return
    hangul = sum("\uac00" <= c <= "\ud7a3" or "\u1100" <= c <= "\u11ff" or "\u3130" <= c <= "\u318f" for c in text)
    han = sum("\u3400" <= c <= "\u9fff" or "\U00020000" <= c <= "\U0002fa1f" for c in text)
    if not hangul or han > max(2, hangul // 4):
        raise AnalysisError("Translation must be Korean; regenerate the review translation")


def validate_result(task, result, payload):
    """Canonicalize model proposals against immutable input; raise on forged evidence."""
    if task not in TASKS or not isinstance(result, dict) or not isinstance(payload, dict):
        raise AnalysisError("Invalid analysis task, result or snapshot")
    out = {name: [] for name in ARRAYS}
    for name in ARRAYS:
        _array(result.get(name, []), name)
    if task == "research_rules":
        out["rules_candidates"] = _rule_candidates(result.get("rules_candidates", []))
        return out
    reviews = _index(payload.get("reviews", []), "reviews")
    documents = _index(payload.get("documents", []), "documents")
    known = _index(payload.get("concerns", []), "concerns")
    original_concerns = deepcopy(known)
    aliases = {identity: identity for identity in known}
    ambiguous_concerns = set()
    for identity, existing in known.items():
        for span in _array(existing.get("source_spans", []), "source_spans"):
            _, unique = _anchor(span, reviews, True)
            if not unique:
                ambiguous_concerns.add(identity)
    for c in result.get("concerns", []):
        title = _text(c.get("title"), "concern title")
        spans, certain = [], True
        for span in _array(c.get("source_spans", []), "source_spans"):
            anchored, unique = _anchor(span, reviews, True)
            spans.append(anchored)
            certain &= unique
        if not spans:
            raise AnalysisError("Actual concerns require review source evidence")
        reviewers = {reviews[s["review_id"]].get("reviewer_id") for s in spans}
        reviewer = c.get("reviewer_id")
        if reviewer is not None and reviewer not in reviewers:
            raise AnalysisError("Concern reviewer does not match its source")
        grounded = sorted([{k: s[k] for k in ("review_id", "field", "quote")} for s in spans], key=lambda s: (s["review_id"], s["field"], s["quote"]))
        identity = "concern_" + _hash([title.strip().casefold(), grounded])[:24]
        # Reuse a uniquely grounded existing concern even if the model paraphrases
        # its title. Multiple atomic concerns sharing a quote remain distinct.
        matches = []
        for old_id, old in original_concerns.items():
            old_spans = [{k: span.get(k) for k in ("review_id", "field", "quote")} for span in old.get("source_spans", [])]
            if sorted(old_spans, key=lambda span: (span["review_id"], span["field"], span["quote"])) == grounded:
                matches.append((old_id, old))
        exact_titles = [old_id for old_id, old in matches if old.get("title", "").strip().casefold() == title.strip().casefold()]
        if len(exact_titles) == 1:
            identity = exact_titles[0]
        elif len(matches) == 1:
            identity = matches[0][0]
        # Existing concerns keep their IDs on revalidation or reuse by exact ground.
        if c.get("id") in known:
            existing = known[c["id"]]
            old_ground = [{k: s.get(k) for k in ("review_id", "field", "quote")} for s in existing.get("source_spans", [])]
            if sorted(old_ground, key=lambda s: (s["review_id"], s["field"], s["quote"])) == grounded:
                identity = c["id"]
            else:
                raise AnalysisError("Existing concern evidence changed")
        raw_id = c.get("id")
        if raw_id is not None:
            if raw_id in aliases and aliases[raw_id] != identity:
                raise AnalysisError("Conflicting concern IDs")
            aliases[raw_id] = identity
        aliases[identity] = identity
        canonical = {"id": identity, "title": title, "reviewer_id": reviewer, "source_spans": spans,
                     "requires_response": c.get("requires_response", True) is not False,
                     "strategy": c.get("strategy", "clarify"), "work_status": "todo", "comments": []}
        if canonical["strategy"] not in {"clarify", "accept", "dispute", "scope"}:
            raise AnalysisError("Unknown concern strategy")
        if not certain:
            ambiguous_concerns.add(identity)
            canonical["uncertain"] = True
        known[identity] = canonical
        if not any(x["id"] == identity for x in out["concerns"]):
            out["concerns"].append(canonical)
    translated_fields = set()
    for item in result.get("translations", []):
        review = reviews.get(item.get("review_id"))
        if review is None or item.get("field") not in review.get("fields", {}):
            raise AnalysisError("Unknown translation review or field")
        if not isinstance(item.get("text"), str) or not isinstance(item.get("uncertain", []), list):
            raise AnalysisError("Invalid translation")
        key = (item["review_id"], item["field"])
        if key in translated_fields:
            raise AnalysisError("Duplicate translation review and field")
        translated_fields.add(key)
        _validate_korean_translation(item["text"], review["fields"][item["field"]])
        original = review["fields"][item["field"]]
        segments = []
        for segment in item.get("segments", []):
            if not isinstance(segment, dict):
                continue
            source, translated = segment.get("source"), segment.get("text")
            if not isinstance(source, str) or not source.strip() or not isinstance(translated, str) or not any('\uac00' <= c <= '\ud7a3' for c in translated):
                continue
            start = original.find(source)
            if start < 0 or original.find(source, start + 1) >= 0:
                continue
            segments.append({"source": source, "text": translated})
        translation = {"review_id": item["review_id"], "field": item["field"], "text": item["text"], "uncertain": deepcopy(item.get("uncertain", []))}
        if "segments" in item:
            translation["segments"] = segments
        out["translations"].append(translation)
    for item in result.get("mappings", []):
        concern_id = aliases.get(item.get("concern_id"))
        if concern_id not in known:
            raise AnalysisError("Unknown mapping concern ID")
        coverage = item.get("coverage")
        if coverage not in {"addressed", "partial", "related", "missing", "uncertain"}:
            raise AnalysisError("Invalid coverage")
        spans, ambiguous = [], concern_id in ambiguous_concerns or known[concern_id].get("uncertain", False)
        for span in _array(item.get("response_spans", []), "response_spans"):
            anchored, certain = _anchor(span, documents)
            if certain:
                if anchored not in spans:
                    spans.append(anchored)
            else:
                ambiguous = True
        if ambiguous:
            coverage = "uncertain"
        elif not spans and coverage != "missing":
            coverage = "uncertain"
        if coverage == "missing":
            spans = []
        missing = item.get("missing", [])
        if not isinstance(missing, list) or any(not isinstance(x, str) for x in missing):
            raise AnalysisError("Invalid missing requirements")
        if coverage == "addressed" and missing:
            coverage = "partial"
        mapping = {"id": "mapping_" + _hash([concern_id, spans])[:24], "concern_id": concern_id,
                   "response_spans": spans, "coverage": coverage, "reason": str(item.get("reason", "")),
                   "missing": missing, "origin": "ai", "decision": "proposed"}
        if task == "connect" and "relationship" in item:
            if item["relationship"] not in {"direct", "partial", "context"}:
                raise AnalysisError("Invalid connection relationship")
            mapping["relationship"] = item["relationship"]
        if ambiguous or (coverage == "uncertain" and item.get("validation_notes")):
            mapping["validation_notes"] = ["Repeated quote has no unique snapshot anchor"]
        out["mappings"].append(mapping)
    for item in result.get("findings", []):
        span, certain = _anchor(item, documents)
        finding = {"id": "finding_" + _hash([span, item.get("type"), item.get("reason")])[:24], **span,
                   "type": str(item.get("type", "style")), "reason": str(item.get("reason", "")),
                   "suggestion": str(item.get("suggestion", "")), "meaning_change": bool(item.get("meaning_change", False)), "status": "proposed"}
        if not certain:
            finding["status"] = "uncertain"
        out["findings"].append(finding)
    for item in result.get("consistency", []):
        ids = item.get("document_ids", [])
        if not isinstance(ids, list) or any(i not in documents for i in ids):
            raise AnalysisError("Unknown consistency document")
        quotes = [_anchor(s, documents)[0] for s in _array(item.get("quotes", []), "quotes")]
        if not quotes:
            raise AnalysisError("Consistency findings require quoted evidence")
        if any(q["document_id"] not in ids for q in quotes):
            raise AnalysisError("Consistency quote/document mismatch")
        out["consistency"].append({"document_ids": ids, "quotes": quotes, "reason": str(item.get("reason", "")), "suggestion": str(item.get("suggestion", ""))})
    for item in result.get("simulated_questions", []):
        ids = item.get("concern_ids", [])
        if not isinstance(ids, list) or any(i not in aliases for i in ids):
            raise AnalysisError("Unknown simulated question concern")
        out["simulated_questions"].append({"question": _text(item.get("question"), "question"), "concern_ids": [aliases[i] for i in ids], "reason": str(item.get("reason", "")), "inferred": True})
    if task == "rewrite":
        selection = payload.get("selection")
        if not isinstance(selection, dict):
            raise AnalysisError("Rewrite requires a grounded selection")
        _rewrite_anchor(selection, documents)
        out["replacement"] = _text(result.get("replacement"), "replacement")
    if "summary" in result:
        out["summary"] = str(result["summary"])
    # Simulated questions never become actual concerns or coverage proposals.
    if task == "simulate":
        out["concerns"], out["mappings"] = [], []
    return out
