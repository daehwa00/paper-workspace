"""Shared domain state, validation and response anchor invalidation."""
from __future__ import annotations

from datetime import datetime, timezone
import copy
import hashlib
import re
import secrets

if __package__:
    from .imports import ValidationError, text
else:
    from imports import ValidationError, text


MAX_REQUEST_BYTES = 20_000_000
MAX_STATE_BYTES = 8_000_000
SAFE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$')
TASKS = {'analyze', 'translate', 'translate_response', 'map', 'connect', 'style', 'consistency', 'simulate', 'rewrite', 'research_rules'}
TRANSLATION_TASKS = {'translate', 'translate_response'}
SECRET_KEYS = {'password', 'access_token', 'refresh_token', 'mfapendingtoken', 'mfa_pending_token', 'openreview_token', 'connection_id', 'session_cookie'}
ROUND_ARRAYS = ('reviewers', 'reviews', 'imports', 'documents', 'concerns', 'mappings', 'findings', 'evidence', 'work_items', 'rules', 'analyses', 'submissions')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def uid():
    return secrets.token_hex(16)


def identifier(value):
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        raise ValidationError('invalid identifier')
    return value


class NotFound(LookupError):
    pass


class Conflict(ValueError):
    def __init__(self, revision):
        self.revision = revision
        super().__init__('revision conflict')


class Forbidden(PermissionError):
    pass


def reject_secrets(value):
    if isinstance(value, dict):
        if any(str(k).lower() in SECRET_KEYS for k in value):
            raise ValidationError('credential fields are forbidden in domain metadata')
        for child in value.values(): reject_secrets(child)
    elif isinstance(value, list):
        for child in value: reject_secrets(child)


def empty_state():
    return {'schema_version': 1, 'revision': 0, 'rounds': [], 'jobs': [], 'enabled': True}


def new_round(title):
    return {'id': uid(), 'title': text(title, 'title', 500), **{k: [] for k in ROUND_ARRAYS}, 'active_rules_id': None, 'glossary': {}}


def lookup(items, item_id):
    return next((item for item in items if item['id'] == item_id), None)


def find_round(state, round_id):
    round_ = lookup(state['rounds'], round_id)
    if round_ is None:
        raise NotFound('round not found')
    return round_


def utf16_offsets(source, quote, supplied_start=None):
    text(quote, 'quote')
    if not quote:
        raise ValidationError('quote must not be empty')
    first = source.find(quote)
    if first < 0:
        raise ValidationError('quote is absent from snapshot')
    encoded = source.encode('utf-16-le')
    quoted = quote.encode('utf-16-le')
    start = len(source[:first].encode('utf-16-le')) // 2
    if type(supplied_start) is int and 0 <= supplied_start <= len(encoded) // 2:
        if encoded.startswith(quoted, supplied_start * 2):
            return supplied_start, supplied_start + len(quoted) // 2
    if source.find(quote, first + 1) >= 0:
        raise ValidationError('ambiguous quote requires an exact offset')
    return start, start + len(quoted) // 2


def checked_texts(round_, texts, require_all=False):
    if not isinstance(texts, dict) or len(texts) > 400:
        raise ValidationError('texts must be an object')
    known = {d['id'] for d in round_['documents']}
    if set(texts) - known or require_all and known - set(texts):
        raise ValidationError('invalid response text snapshot')
    return {key: text(value) for key, value in texts.items()}


def stale_mapping(mapping, reason):
    if mapping.get('decision') == 'confirmed':
        mapping.setdefault('decision_history', []).append({'decision': 'confirmed', 'coverage': mapping.get('coverage'),
            'reason': mapping.get('reason'), 'input_hash': mapping.get('input_hash'), 'invalidated_at': now(), 'invalidation_reason': reason})
        mapping['decision'] = 'proposed'
    mapping['stale'] = True
    mapping['needs_reconfirmation'] = True


def invalidate(round_, texts):
    hashes = round_.setdefault('text_hashes', {})
    changed = {key for key, value in texts.items() if hashes.get(key) != hashlib.sha256(value.encode()).hexdigest()}
    hashes.update({key: hashlib.sha256(value.encode()).hexdigest() for key, value in texts.items()})
    for finding in round_['findings']:
        if finding.get('document_id') in changed:
            finding['stale'] = True
    for mapping in round_['mappings']:
        dependent = mapping.get('dependency_document_ids')
        global_changed = bool(changed) and (mapping.get('origin') == 'ai' or not mapping.get('response_spans')) and (dependent is None or bool(changed & set(dependent)))
        span_changed = any(span.get('document_id') in changed and span.get('content_hash') != hashes.get(span.get('document_id')) for span in mapping.get('response_spans', []))
        if global_changed or span_changed:
            stale_mapping(mapping, 'response_text_changed')


def validate_edit(round_, edits, texts, actor='Shared user'):
    if not isinstance(edits, dict):
        raise ValidationError('round must be an object')
    old_mappings = {m['id']: copy.deepcopy(m) for m in round_['mappings']}
    old_concerns = {c['id']: copy.deepcopy(c) for c in round_['concerns']}
    reconfirmed = set()
    allowed = {'title', 'reviewers', 'documents', 'concerns', 'mappings', 'findings', 'evidence', 'work_items', 'glossary', 'reviews'}
    if set(edits) - allowed - set(round_):
        raise ValidationError('unknown round field')
    if 'title' in edits:
        round_['title'] = text(edits['title'], 'title', 500)
    if 'glossary' in edits:
        glossary = edits['glossary']
        if not isinstance(glossary, dict) or len(glossary) > 1000:
            raise ValidationError('invalid glossary')
        round_['glossary'] = {text(k, 'glossary term', 300): text(v, 'glossary value', 2000) for k, v in glossary.items()}
    # The client sends a full round. Ignore immutable copies, but reject attempted changes.
    for key in ('imports', 'rules', 'submissions', 'analyses', 'active_rules_id'):
        if key in edits and edits[key] != round_.get(key):
            raise ValidationError(f'{key} are immutable through round edits')
    if 'reviews' in edits:
        if not isinstance(edits['reviews'], list):
            raise ValidationError('invalid reviews')
        originals = {r['id']: r for r in round_['reviews']}
        if {r.get('id') for r in edits['reviews']} != set(originals):
            raise ValidationError('reviews cannot be added or removed through round edits')
        for incoming in edits['reviews']:
            original = originals[incoming['id']]
            for key in ('fields', 'source_id', 'note_id', 'source_version', 'reviewer_id'):
                if key in incoming and incoming[key] != original.get(key):
                    raise ValidationError('review sources are immutable')
            translations = incoming.get('translations', original.get('translations', {}))
            if not isinstance(translations, dict) or set(translations) - set(original['fields']):
                raise ValidationError('invalid translation fields')
            translations = {k: text(v, 'translation') for k, v in translations.items()}
            if translations != original.get('translations', {}):
                original.setdefault('translation_revisions', []).append({'id': uid(), 'translations': translations, 'origin': 'manual', 'created_at': now(), 'actor': actor})
                original['translations'] = translations
    for key in ('reviewers', 'documents', 'concerns', 'mappings', 'findings', 'evidence', 'work_items'):
        if key not in edits:
            continue
        values = edits[key]
        if not isinstance(values, list) or len(values) > 2000 or any(not isinstance(v, dict) for v in values):
            raise ValidationError(f'invalid {key}')
        ids = [identifier(v.get('id')) for v in values]
        if len(ids) != len(set(ids)):
            raise ValidationError(f'duplicate {key} identifiers')
        if key == 'documents':
            originals = {d['id']: d for d in round_['documents']}
            if set(ids) != set(originals):
                raise ValidationError('documents must be created through the documents endpoint')
            for value in values:
                original = originals[value['id']]
                if value.get('text_key', original['text_key']) != original['text_key'] or value.get('seed_text', original['seed_text']) != original['seed_text']:
                    raise ValidationError('document seed and text key are immutable')
                if 'korean_seed' in value and value['korean_seed'] != original.get('korean_seed'):
                    raise ValidationError('document Korean seed is immutable')
                if value.get('kind', original['kind']) not in {'reviewer', 'common', 'unified'}:
                    raise ValidationError('invalid document kind')
                value.update({key: original[key] for key in ('text_key', 'seed_text')})
                if 'korean_seed' in original: value['korean_seed'] = copy.deepcopy(original['korean_seed'])
                else: value.pop('korean_seed', None)
                value.setdefault('kind', original['kind']); value.setdefault('reviewer_id', original['reviewer_id'])
                value['title'] = text(value.get('title', original['title']), 'title', 500)
        round_[key] = copy.deepcopy(values)
    reviews = {r['id']: r for r in round_['reviews']}
    reviewer_ids = {r['id'] for r in round_['reviewers']}
    for review in round_['reviews']:
        if review['reviewer_id'] not in reviewer_ids: raise ValidationError('unknown review reviewer')
    for document in round_['documents']:
        if document.get('reviewer_id') is not None and document['reviewer_id'] not in reviewer_ids:
            raise ValidationError('unknown document reviewer')
    for concern in round_['concerns']:
        text(concern.get('title'), 'concern title', 1000)
        if concern.get('strategy', 'clarify') not in {'clarify', 'accept', 'dispute', 'scope'} or concern.get('work_status', 'todo') not in {'todo', 'review', 'confirmed'}:
            raise ValidationError('invalid concern status or strategy')
        for span in concern.get('source_spans', []):
            review = reviews.get(span.get('review_id'))
            if not review or span.get('field') not in review['fields']:
                raise ValidationError('unknown source span')
            span['start'], span['end'] = utf16_offsets(review['fields'][span['field']], span.get('quote'), span.get('start'))
    concerns = {c['id'] for c in round_['concerns']}
    documents = {d['id'] for d in round_['documents']}
    for mapping in round_['mappings']:
        reconfirm = mapping.pop('reconfirm', False)
        if type(reconfirm) is not bool: raise ValidationError('invalid reconfirm signal')
        if reconfirm:
            if mapping.get('decision') != 'confirmed': raise ValidationError('reconfirmation requires a confirmed decision')
            if (mapping.get('origin') == 'ai' or not mapping.get('response_spans')) and documents - set(texts):
                raise ValidationError('reconfirmation requires every response text')
            reconfirmed.add(mapping['id'])
        if mapping.get('concern_id') not in concerns or mapping.get('coverage') not in {'addressed', 'partial', 'related', 'missing', 'uncertain'}:
            raise ValidationError('invalid mapping')
        if mapping.get('decision', 'proposed') not in {'proposed', 'confirmed', 'rejected'}:
            raise ValidationError('invalid mapping decision')
        if mapping['id'] not in old_mappings: mapping['origin'] = 'manual'
        mapping.setdefault('origin', 'manual')
        for span in mapping.get('response_spans', []):
            document_id = span.get('document_id')
            if document_id not in documents:
                raise ValidationError('unknown response document')
            if not reconfirm and span in old_mappings.get(mapping['id'], {}).get('response_spans', []):
                # Stored evidence may be stale. Text edits must remain saveable.
                continue
            if document_id not in texts:
                raise ValidationError('manual response anchors require live text snapshot')
            span['start'], span['end'] = utf16_offsets(texts[document_id], span.get('quote'), span.get('start'))
            span['content_hash'] = hashlib.sha256(texts[document_id].encode()).hexdigest()
    for mapping in round_['mappings']:
        previous = old_mappings.get(mapping['id'])
        if not previous: continue
        concern = lookup(round_['concerns'], mapping['concern_id'])
        old = old_concerns.get(previous.get('concern_id'))
        semantic = lambda c: {k: c.get(k) for k in ('id', 'title', 'source_spans', 'requires_response')} if c else None
        if semantic(old) != semantic(concern): stale_mapping(mapping, 'concern_changed')
        elif previous.get('stale'):
            mapping['stale'] = True; mapping['needs_reconfirmation'] = True
    for finding in round_['findings']:
        if finding.get('document_id') not in documents:
            raise ValidationError('unknown finding document')
    return reconfirmed
