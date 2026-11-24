"""Snapshot-grounded rebuttal analysis. No scheduling or persistent writes live here."""
from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from urllib.parse import urlsplit

# Support script execution and direct importlib loaders as well as package imports.
if not __package__:
    import sys
    from pathlib import Path

    module_dir = str(Path(__file__).resolve().parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    from anchoring import AnalysisError, _anchor, _array, _hash, _index, _multiple_sentences, _rewrite_anchor, _text, _sentence_boundaries, _sentence_options, _REFERENCE_ABBREVIATION, _REFERENCE_TARGET
    from validators import ARRAYS, TASKS, _rule_candidates, _technical_only, _validate_korean_translation, validate_result, validation_issue
else:
    from .anchoring import AnalysisError, _anchor, _array, _hash, _index, _multiple_sentences, _rewrite_anchor, _text, _sentence_boundaries, _sentence_options, _REFERENCE_ABBREVIATION, _REFERENCE_TARGET
    from .validators import ARRAYS, TASKS, _rule_candidates, _technical_only, _validate_korean_translation, validate_result, validation_issue

CHUNK_CHARS = 8000
CONTEXT_CHARS = 24000
MAX_REQUEST_CHARS = 64000


class AnalysisCancelled(RuntimeError):
    pass


def _chunks(text):
    if not text:
        yield ""
    for start in range(0, len(text), CHUNK_CHARS - 256):
        yield text[start:start + CHUNK_CHARS]


def _batches(items, limit=CONTEXT_CHARS):
    batch, size = [], 0
    for item in items:
        n = len(json.dumps(item, ensure_ascii=False))
        if batch and (size + n > limit or len(batch) >= 100):
            yield batch
            batch, size = [], 0
        batch.append(item)
        size += n
    if batch:
        yield batch


def _research_payload(payload):
    # This is the only task permitting search; manuscript/reviewer content cannot escape.
    source = payload.get("research", payload)
    clean = {k: source[k] for k in ("venue", "year", "track", "stage") if k in source}
    urls = source.get("official_urls", [])
    if not isinstance(urls, list):
        raise AnalysisError("official_urls must be a list")
    clean.setdefault("track", "")
    clean.setdefault("stage", "")
    clean["official_urls"] = [u for u in urls if isinstance(u, str) and urlsplit(u).scheme == "https" and urlsplit(u).hostname and not urlsplit(u).username]
    return clean


def run_analysis(task, payload, call_bridge, progress, cancelled, profile=None):
    """Run explicit user-requested analysis using bounded, grounded bridge calls."""
    if task not in TASKS:
        raise AnalysisError("Unsupported analysis task")
    snapshot = deepcopy(payload)
    result = {name: [] for name in ARRAYS}
    connection_warnings = []
    connection_diagnostics = []

    def check():
        if cancelled():
            raise AnalysisCancelled("Analysis cancelled")

    def call(kind, request, stage, validation=None, carried_spans=None, ignore_translations=False):
        check()
        progress(stage)
        check()
        request_limit = 750_000 if kind == 'direct_connect' and request.get('manuscript') else MAX_REQUEST_CHARS
        if len(json.dumps(request, ensure_ascii=False)) > request_limit:
            raise AnalysisError("Analysis context exceeds bounded request size; narrow the selected scope")
        feedback = None
        failures = []
        contextual_pairs = set()
        max_model_attempts = 3 if kind == 'direct_connect' else 2
        for attempt in range(max_model_attempts + (1 if kind == 'direct_connect' else 0)):
            check()
            if attempt < max_model_attempts:
                current = request if attempt == 0 else {**request, "phase": f"{request.get('phase', kind)}_verify_quotes", "validation_feedback": feedback}
                raw = call_bridge(kind, current, profile)
            else:
                # Keep only independently verified sentence pairs; never weaken
                # grounding or guess how a multi-sentence reason should split.
                candidates = last_raw.get('links') if isinstance(last_raw, dict) else None
                if not isinstance(candidates, list):
                    last_error.validation_failures = failures
                    raise last_error
                def usable(candidate, allow_context=False):
                    try:
                        if not isinstance(candidate, dict): raise AnalysisError('Invalid link')
                        reason = _text(candidate.get('reason'), 'connection reason')
                        if not any('가' <= char <= '힣' for char in reason): raise AnalysisError('Connection reason must be Korean')
                        if candidate.get('relationship') not in {'direct', 'partial', 'context'}: raise AnalysisError('Invalid connection relationship')
                        source = _array(candidate.get('source_spans'), 'source_spans')
                        response = _array(candidate.get('response_spans'), 'response_spans')
                        if len(source) != 1 or len(response) != 1: raise AnalysisError('Each connection requires one review sentence and one response sentence')
                        if not allow_context and (_multiple_sentences(source[0].get('quote')) or _multiple_sentences(response[0].get('quote'))): raise AnalysisError('Each connection must use a single sentence per side')
                        if allow_context and (len(source[0].get('quote','')) > 1200 or len(response[0].get('quote','')) > 1200 or len(_sentence_options(source[0].get('quote'))) > 3 or len(_sentence_options(response[0].get('quote'))) > 3): raise AnalysisError('Context span too long')
                        concern = {'id':'verified', 'title':candidate.get('title'), 'reviewer_id':request['reviews'][0].get('reviewer_id'), 'source_spans':source, 'strategy':'clarify'}
                        mapping = {'concern_id':'verified', 'response_spans':response, 'coverage':'related', 'relationship':candidate['relationship'], 'reason':reason, 'missing':[]}
                        verified = validate_result('connect', {'concerns':[concern], 'mappings':[mapping]}, validation if validation is not None else snapshot)
                        if allow_context:
                            source_anchor=verified['concerns'][0]['source_spans'][0]
                            response_anchors=verified['mappings'][0]['response_spans']
                            if 'start' not in source_anchor or len(response_anchors)!=1 or 'start' not in response_anchors[0]: return False
                        return True
                    except AnalysisError:
                        return False
                kept = [candidate for candidate in candidates if usable(candidate)]
                rejected = [candidate for candidate in candidates if not usable(candidate)]
                repaired = set()
                # Only multi-sentence candidates with exactly grounded spans can
                # be narrowed. Never create connections from unverified text.
                repairable = []
                repair_diagnostics = {'ungrounded_original': 0, 'invalid_candidate': 0, 'attempted': 0, 'returned': 0, 'accepted': 0, 'error': None}
                for index, candidate in enumerate(rejected):
                    try:
                        source = _array(candidate.get('source_spans'), 'source_spans')
                        response = _array(candidate.get('response_spans'), 'response_spans')
                        if len(source) != 1 or len(response) != 1: continue
                        if not (_multiple_sentences(source[0].get('quote')) or _multiple_sentences(response[0].get('quote'))): continue
                        reviews = _index(request['reviews'], 'reviews')
                        documents = _index(request['documents'], 'documents')
                        # Candidate text may contain a typo or an extra space.
                        # Repair may narrow it, but final quotes must independently
                        # match the named original and be substrings of the candidate.
                        try:
                            _anchor(source[0], reviews, True); _anchor(response[0], documents)
                        except AnalysisError as error:
                            if validation_issue(error) != 'quote_absent': raise
                            repair_diagnostics['ungrounded_original'] += 1
                        repairable.append((index, candidate))
                    except (AnalysisError, AttributeError, TypeError):
                        repair_diagnostics['invalid_candidate'] += 1
                        continue
                if repairable:
                    repair_request = {**request, 'phase':'direct_connect_repair', 'candidate_mappings':[{**c, 'source_options':_sentence_options(c['source_spans'][0]['quote']), 'response_options':_sentence_options(c['response_spans'][0]['quote'])} for _,c in repairable]}
                    try:
                        repair_diagnostics['attempted'] = len(repairable)
                        progress(f'{stage}_repair_sentences')
                        proposed = call_bridge(kind, repair_request, profile)
                        check()
                        proposed_links = _array(proposed.get('links') if isinstance(proposed, dict) else None, 'links')
                        repair_diagnostics['returned'] = len(proposed_links)
                        for link in proposed_links:
                            if not usable(link): continue
                            for index, original in repairable:
                                src, dst = link['source_spans'][0], link['response_spans'][0]
                                old_src, old_dst = original['source_spans'][0], original['response_spans'][0]
                                if (src.get('review_id') == old_src.get('review_id') and src.get('field') == old_src.get('field')
                                    and dst.get('document_id') == old_dst.get('document_id')
                                    and src.get('quote') in _sentence_options(old_src.get('quote', '')) and dst.get('quote') in _sentence_options(old_dst.get('quote', ''))):
                                    if not any(existing.get('source_spans') == link['source_spans'] and existing.get('response_spans') == link['response_spans'] for existing in kept): kept.append(link)
                                    repaired.add(index); repair_diagnostics['accepted'] = len(repaired); break
                    except AnalysisCancelled:
                        raise
                    except Exception as error:
                        # Retain only a safe category, never the model output.
                        repair_diagnostics['error'] = 'validation' if isinstance(error, AnalysisError) else 'request_failed'
                        check()
                # A single sentence can lose the point of a multi-sentence
                # response. Retain exact, unique, short passages as uncertain
                # context, never as a verified direct answer.
                for index, original in repairable:
                    if index in repaired or not usable(original, allow_context=True): continue
                    candidate = deepcopy(original)
                    candidate['relationship'] = 'context'
                    candidate['reason'] = '여러 문장의 맥락을 포함한 연결이므로 내용 확인이 필요합니다. ' + candidate['reason']
                    key = json.dumps([candidate['source_spans'], candidate['response_spans']], sort_keys=True, ensure_ascii=False)
                    contextual_pairs.add(key)
                    kept.append(candidate); repaired.add(index)
                    source_anchor, _ = _anchor(candidate['source_spans'][0], _index(request['reviews'], 'reviews'), True)
                    response_anchor, _ = _anchor(candidate['response_spans'][0], _index(request['documents'], 'documents'))
                    connection_diagnostics.append({'stage': stage, 'type': 'contextual_candidate', 'source': {k:v for k,v in source_anchor.items() if k != 'quote'}, 'response': {k:v for k,v in response_anchor.items() if k not in {'quote','content_hash'}}})
                omitted = len(rejected) - len(repaired)
                if not kept and stage != 'direct_connect_audit':
                    last_error.validation_failures = failures
                    raise last_error
                # Context fallback remains uncertain even when no candidate was
                # omitted; publishers must preserve earlier verified links.
                if omitted or contextual_pairs:
                    connection_warnings.append({'stage': stage, 'omitted_links': omitted, 'contextual_links': len(contextual_pairs), 'validation_failures': failures, 'repair': repair_diagnostics})
                raw = {'links': kept}
            # Extraction returns no mappings, so model-generated concern IDs have
            # no references to preserve. Canonical IDs are derived from grounded
            # evidence; repeated model placeholders must not collide.
            if kind in {"analyze", "extract_concerns"} and isinstance(raw, dict) and isinstance(raw.get("concerns"), list):
                raw = {**raw, "concerns": [{k: v for k, v in item.items() if k != "id"} if isinstance(item, dict) else item for item in raw["concerns"]]}
            if ignore_translations and isinstance(raw, dict):
                raw = {**raw, "translations": []}
            if carried_spans is not None and isinstance(raw, dict):
                for mapping in raw.get("mappings", []):
                    if not mapping.get("response_spans"):
                        mapping["response_spans"] = deepcopy(carried_spans)
            check()
            link_index = None
            try:
                validation_kind = kind
                if kind == "direct_connect":
                    last_raw = deepcopy(raw)
                    links = _array(raw.get("links"), "links") if isinstance(raw, dict) else _array(None, "links")
                    concerns, mappings, groups = [], [], {}
                    reviewer = request["reviews"][0].get("reviewer_id")
                    for index, link in enumerate(links):
                        link_index = index
                        reason = _text(link.get("reason"), "connection reason")
                        relationship = link.get("relationship")
                        if relationship not in {"direct", "partial", "context"}:
                            raise AnalysisError("Invalid connection relationship")
                        if not any('\uac00' <= char <= '\ud7a3' for char in reason):
                            raise AnalysisError("Connection reason must be Korean")
                        source_spans = _array(link.get("source_spans"), "source_spans")
                        response_spans = _array(link.get("response_spans"), "response_spans")
                        if len(source_spans) != 1 or len(response_spans) != 1:
                            raise AnalysisError("Each connection requires one review sentence and one response sentence")
                        pair_key = json.dumps([source_spans, response_spans], sort_keys=True, ensure_ascii=False)
                        contextual = pair_key in contextual_pairs
                        if not contextual and (_multiple_sentences(source_spans[0].get("quote")) or _multiple_sentences(response_spans[0].get("quote"))):
                            raise AnalysisError("Each connection must use a single sentence per side")
                        key = json.dumps(source_spans, sort_keys=True, ensure_ascii=False)
                        if key not in groups:
                            groups[key] = f"direct_link_{index}"
                            concerns.append({"id": groups[key], "title": link.get("title"), "reviewer_id": reviewer,
                                             "source_spans": source_spans, "strategy": "clarify"})
                        identity = groups[key]
                        mappings.append({"concern_id": identity, "response_spans": response_spans,
                                         "coverage": "uncertain" if contextual else "related", "relationship": relationship, "reason": reason, "missing": []})
                    raw = {"concerns": concerns, "mappings": mappings}
                    validation_kind = "connect"
                validated = validate_result(validation_kind, raw, validation if validation is not None else snapshot)
                if kind in {"analyze", "translate"} and not ignore_translations and len(validated["translations"]) != 1:
                    raise AnalysisError("Each review chunk requires exactly one Korean translation")
                return validated
            except AnalysisError as error:
                issue = validation_issue(error)
                failures.append({'issue': issue, 'attempt': attempt + 1, **({'link_index': link_index} if isinstance(link_index, int) else {})})
                if attempt + 1 >= max_model_attempts:
                    if kind == 'direct_connect' and attempt + 1 == max_model_attempts:
                        last_error = error
                        continue
                    error.validation_failures = failures
                    raise
                message = str(error)
                if message in {"Each review chunk requires exactly one Korean translation", "Duplicate translation review and field", "Translation must be Korean; regenerate the review translation", "Empty review field must have an empty translation", "Invalid translation", "Unknown translation review or field"}:
                    feedback = "translation"
                elif message.startswith(("Quote absent from snapshot:", "Unknown review_id:", "Unknown document_id:", "Unknown review field:", "Concern reviewer does not match its source", "Unknown mapping concern ID")):
                    feedback = "evidence"
                else:
                    feedback = issue if kind == 'direct_connect' and issue in {'span_count', 'multiple_sentences', 'relationship', 'korean_reason', 'empty_reason', 'links_format', 'source_spans_format', 'response_spans_format', 'missing_evidence'} else 'structure'
                progress(f"{stage}_verify_quotes")

    def merge(part, names=ARRAYS):
        for name in names:
            for item in part[name]:
                if name == "translations" or item not in result[name]:
                    result[name].append(item)

    check()
    if task == "research_rules":
        clean = _research_payload(snapshot)
        return call(task, clean, "research_rules", clean)
    base = {"reviews": [{key: review[key] for key in ("id", "reviewer_id", "fields") if key in review}
                        for review in snapshot.get("reviews", [])], "concerns": snapshot.get("concerns", []),
            "documents": snapshot.get("documents", []), "glossary": snapshot.get("glossary", {}), "rules": snapshot.get("rules", [])}
    scope = snapshot.get("scope", {})
    if not isinstance(scope, dict):
        raise AnalysisError("Invalid analysis scope")
    for key, collection in (("document_ids", "documents"), ("concern_ids", "concerns")):
        if key in scope:
            ids = scope[key]
            if not isinstance(ids, list) or any(i not in {x["id"] for x in base[collection]} for i in ids):
                raise AnalysisError("Unknown analysis scope ID")
            base[collection] = [x for x in base[collection] if x["id"] in ids]
    if task == "connect":
        reviews = base["reviews"]
        documents = base["documents"]
        if not reviews or len(documents) != 1 or len({r.get("reviewer_id") for r in reviews}) != 1:
            raise AnalysisError("Select one reviewer and one response document")
        request = {"reviews": reviews, "documents": documents, "concerns": [], "phase": "direct_connect"}
        if snapshot.get("manuscript"):
            request["manuscript"] = deepcopy(snapshot["manuscript"])
        first = call("direct_connect", request, "direct_connect", request)
        by_id = {concern["id"]: concern for concern in first["concerns"]}
        candidates = []
        for mapping in first["mappings"]:
            concern = by_id[mapping["concern_id"]]
            for response in mapping["response_spans"]:
                candidates.append({"title": concern["title"],
                                   "source_spans": [{k: span[k] for k in ("review_id", "field", "quote")} for span in concern["source_spans"]],
                                   "response_spans": [{k: response[k] for k in ("document_id", "quote")}],
                                   "relationship": mapping.get("relationship", "context"), "reason": mapping["reason"]})
        audit_request = {**request, "phase": "direct_connect_audit", "candidate_mappings": candidates}
        audit = call("direct_connect", audit_request, "direct_connect_audit", request)
        # Preserve all first-pass links. Merge only additional exact sentence pairs,
        # reusing the first concern when both passes quote the same review sentence.
        def source_key(concern):
            return tuple((span["review_id"], span["field"], span["quote"]) for span in concern["source_spans"])
        known_sources = {source_key(concern): concern["id"] for concern in first["concerns"]}
        seen = {(source_key(by_id[m["concern_id"]]), tuple((span["document_id"], span["quote"]) for span in m["response_spans"])) for m in first["mappings"]}
        audit_by_id = {concern["id"]: concern for concern in audit["concerns"]}
        for mapping in audit["mappings"]:
            concern = audit_by_id[mapping["concern_id"]]
            key = source_key(concern)
            pair = (key, tuple((span["document_id"], span["quote"]) for span in mapping["response_spans"]))
            if pair in seen:
                continue
            seen.add(pair)
            if key not in known_sources:
                first["concerns"].append(concern)
                known_sources[key] = concern["id"]
            mapping["concern_id"] = known_sources[key]
            first["mappings"].append(mapping)
        if connection_warnings: first["connection_warnings"] = connection_warnings
        if connection_diagnostics: first["connection_diagnostics"] = connection_diagnostics
        return first
    if task in {"analyze", "translate"}:
        translations = []
        for review in base["reviews"]:
            for field, text in review.get("fields", {}).items():
                translated_chunks, uncertainty, segments = [], [], []
                for start in range(0, max(1, len(text)), CHUNK_CHARS):
                    chunk = text[start:start + CHUNK_CHARS]
                    request = {**base, "reviews": [{**review, "fields": {field: chunk}}], "documents": [], "concerns": [], "phase": "extract"}
                    part = call(task, request, "translation_and_concerns" if task == "analyze" else "translation", request)
                    if len(part["translations"]) != 1:
                        raise AnalysisError("Each review chunk requires exactly one Korean translation")
                    translated_chunks.append(part["translations"][0]["text"])
                    uncertainty.extend(part["translations"][0]["uncertain"])
                    segments.extend(part["translations"][0].get("segments", []))
                    if "concern_ids" not in scope:
                        merge(part, ("concerns",))
                # Source chunks do not overlap. Preserve their order and genuine
                # repeated source passages without deduplicating translated text.
                translations.append({"review_id": review["id"], "field": field, "text": "\n".join(translated_chunks), "uncertain": uncertainty, "segments": segments})
                if task == "analyze" and "concern_ids" not in scope:
                    for boundary in range(CHUNK_CHARS, len(text), CHUNK_CHARS):
                        request = {**base, "reviews": [{**review, "fields": {field: text[max(0, boundary - 256):boundary + 256]}}], "documents": [], "concerns": [], "phase": "extract"}
                        merge(call(task, request, "boundary_concerns", request, ignore_translations=True), ("concerns",))
        result["translations"] = translations
        if task == "translate":
            return validate_result(task, result, snapshot)
        # Preserve existing IDs for exact repeated extraction.
        all_concerns = {c["id"]: c for c in base["concerns"]}
        all_concerns.update({c["id"]: c for c in result["concerns"]})
        base["concerns"] = list(all_concerns.values())
    working = {**snapshot, "concerns": base["concerns"]}
    if task in {"analyze", "map"}:
        candidates = []
        for document in base["documents"]:
            for chunk in _chunks(document.get("text", "")):
                for concerns in _batches(base["concerns"], CHUNK_CHARS):
                    request = {**base, "reviews": [], "concerns": concerns, "documents": [{**document, "text": chunk}], "phase": "mapping"}
                    candidates.extend(call("map", request, "mapping", working)["mappings"])
        candidates = list({json.dumps(m, sort_keys=True): m for m in candidates}.values())
        # Reconcile each concern over evidence from every document, including partial spans.
        for concern in base["concerns"]:
            relevant = [m for m in candidates if m["concern_id"] == concern["id"]]
            evidence = []
            for m in relevant:
                evidence.extend(m["response_spans"])
            if not evidence:
                uncertain = any(m["coverage"] == "uncertain" for m in relevant)
                result["mappings"].append({"concern_id": concern["id"], "response_spans": [], "coverage": "uncertain" if uncertain else "missing", "reason": "No uniquely grounded response evidence", "missing": []})
                continue
            # Reduce long evidence in bounded passes while retaining all document sources.
            partials = []
            for batch in _batches(relevant, CONTEXT_CHARS // 2):
                quotes = [s for m in batch for s in m["response_spans"]]
                docs = [{"id": d, "text": "\n".join(dict.fromkeys(s["quote"] for s in quotes if s["document_id"] == d))} for d in dict.fromkeys(s["document_id"] for s in quotes)]
                request = {**base, "reviews": [], "concerns": [concern], "documents": docs, "candidate_mappings": batch, "phase": "global_coverage"}
                partials.extend(call("map", request, "global_coverage", working)["mappings"])
            if len(partials) > 1:
                # A final judgment receives concise decisions and all discontiguous evidence.
                compact = [{"concern_id": m["concern_id"], "coverage": m["coverage"], "reason": m["reason"], "missing": m["missing"]} for m in partials]
                request = {**base, "reviews": [], "documents": [], "concerns": [concern], "candidate_mappings": compact, "phase": "global_coverage"}
                all_spans = list({json.dumps(s, sort_keys=True): s for p in partials for s in p["response_spans"]}.values())
                merged = call("map", request, "global_coverage", working, carried_spans=all_spans)["mappings"]
                for m in merged:
                    m["response_spans"] = list({json.dumps(s, sort_keys=True): s for p in partials for s in p["response_spans"]}.values())
                partials = merged
            if partials:
                result["mappings"].extend(partials)
            else:
                result["mappings"].append({"concern_id": concern["id"], "response_spans": evidence, "coverage": "uncertain", "reason": "Global coverage judgment omitted concern", "missing": []})
    if task in {"analyze", "style", "consistency"}:
        kinds = ["style", "consistency"] if task == "analyze" else [task]
        doc_chunks = [{**d, "text": chunk} for d in base["documents"] for chunk in _chunks(d.get("text", ""))]
        for kind in kinds:
            batches = list(_batches(doc_chunks, CONTEXT_CHARS // 2))
            for docs in batches:
                merge(call(kind, {**base, "reviews": [], "concerns": [], "documents": docs}, kind, working), ("findings", "consistency"))
            if kind == "consistency" and len(batches) > 1:
                # Compare chunks across batch boundaries; no document is isolated by chunking.
                for i, left in enumerate(doc_chunks):
                    for right in doc_chunks[i + 1:]:
                        if left["id"] != right["id"]:
                            merge(call(kind, {**base, "reviews": [], "concerns": [], "documents": [left, right]}, "cross_document_consistency", working), ("consistency",))
    if task == "simulate":
        docs = [{**d, "text": chunk} for d in base["documents"] for chunk in _chunks(d.get("text", ""))]
        for document_batch in list(_batches(docs, CHUNK_CHARS)) or [[]]:
            for concern_batch in list(_batches(base["concerns"], CHUNK_CHARS)) or [[]]:
                request = {**base, "reviews": [], "documents": document_batch, "concerns": concern_batch}
                merge(call(task, request, task, working), ("simulated_questions",))
    if task == "rewrite":
        selection = snapshot.get("selection", {})
        if not isinstance(selection, dict):
            raise AnalysisError("Rewrite requires a grounded selection")
        documents = _index(base["documents"], "documents")
        anchor = _rewrite_anchor(selection, documents)
        document = documents[anchor["document_id"]]
        original = document["text"]
        start = len(original.encode("utf-16-le")[:anchor["start"] * 2].decode("utf-16-le"))
        context_start = max(0, start - 1000)
        context = original[context_start:start + len(anchor["quote"]) + 1000]
        offset = len(original[:context_start].encode("utf-16-le")) // 2
        excerpt_selection = {**anchor, "start": anchor["start"] - offset, "end": anchor["end"] - offset,
                             "content_hash": hashlib.sha256(context.encode()).hexdigest()}
        request = {**base, "reviews": [], "concerns": [], "documents": [{**document, "text": context}],
                   "selection": excerpt_selection}
        return call(task, request, task, working)
    check()
    progress("validating")
    return validate_result(task, result, working)
