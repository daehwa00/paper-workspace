"""Portable snapshot and idempotent round restore."""
from __future__ import annotations

import copy
import hashlib
import json

if __package__:
    from .imports import ValidationError, digest, text
    from .state import MAX_STATE_BYTES, ROUND_ARRAYS, now, uid, identifier, utf16_offsets, stale_mapping
else:
    from imports import ValidationError, digest, text
    from state import MAX_STATE_BYTES, ROUND_ARRAYS, now, uid, identifier, utf16_offsets, stale_mapping


class RestoreStore:
    def snapshot(self, project):
        state = self.state(project)
        return {'schema_version': 1, 'revision': state['revision'], 'rounds': state['rounds'], 'texts': {}}

    def restore(self, project, payload, actor):
        snapshot = payload.get('snapshot')
        if not isinstance(snapshot, dict) or snapshot.get('schema_version') != 1 or not isinstance(snapshot.get('rounds'), list):
            raise ValidationError('invalid rebuttal snapshot')
        if len(json.dumps(snapshot).encode()) > MAX_STATE_BYTES or len(snapshot['rounds']) > 100:
            raise ValidationError('snapshot is too large')
        request_key = payload.get('idempotency_key')
        if request_key is not None:
            if not text(request_key, 'idempotency_key', 240).strip():
                raise ValidationError('idempotency_key must not be empty')
            request = (project, actor, request_key)
            snapshot_hash = digest(snapshot)

        def replay(db):
            row = db.execute(
                'SELECT snapshot_hash,result FROM restore_requests WHERE project_id=? AND actor=? AND request_key=?',
                request).fetchone()
            if row is None:
                return None
            if row['snapshot_hash'] != snapshot_hash:
                raise ValidationError('idempotency_key was already used for a different snapshot')
            return json.loads(row['result'])

        def apply(state, db):
            rounds = copy.deepcopy(snapshot['rounds'])
            remap = {}
            def collect(value):
                if isinstance(value, dict):
                    if isinstance(value.get('id'), str):
                        remap.setdefault(value['id'], uid())
                    for key, child in value.items():
                        if key not in {'raw', 'extraction_revision', 'fields', 'translations', 'glossary', 'output', 'texts', 'korean_seed'}: collect(child)
                elif isinstance(value, list):
                    for child in value: collect(child)
            collect(rounds)
            reference_keys = {'id', 'reviewer_id', 'review_id', 'source_id', 'document_id', 'concern_id', 'parent_id',
                              'active_rules_id', 'draft_id', 'rules_id', 'text_key', 'cached_from'}
            def replace(value, key=None):
                if isinstance(value, dict):
                    return {remap.get(k, k) if key in {'texts', 'text_hashes'} else k:
                            copy.deepcopy(v) if k in {'raw', 'extraction_revision', 'fields', 'translations', 'glossary', 'output', 'korean_seed'} else replace(v, k)
                            for k, v in value.items()}
                if isinstance(value, list): return [replace(v, key) for v in value]
                if isinstance(value, str) and (key in reference_keys or key in {'document_ids', 'dependency_document_ids', 'concern_ids', 'round_ids'}):
                    return remap.get(value, value)
                return value
            rounds = replace(rounds)
            texts = {}
            supplied = snapshot.get('texts', {})
            if not isinstance(supplied, dict): raise ValidationError('invalid snapshot texts')
            korean = snapshot.get('koreanResponses', {})
            if not isinstance(korean, dict): raise ValidationError('invalid snapshot Korean responses')
            for round_ in rounds:
                for key in ROUND_ARRAYS:
                    if not isinstance(round_.get(key), list):
                        raise ValidationError('invalid restored round')
                identifier(round_.get('id'))
                round_.setdefault('glossary', {}); round_.setdefault('active_rules_id', None)
                round_.update(restored_at=now(), restored_by=actor, title=text(round_.get('title'), 'title', 500))
                round_['analyses'] = []
                for document in round_['documents']:
                    identifier(document.get('id'))
                    if document.get('kind') not in {'reviewer', 'common', 'unified'}: raise ValidationError('invalid restored document')
                    text(document.get('title'), 'title', 500)
                    old_id = next((old for old, new in remap.items() if new == document['id']), None)
                    old_key = next((old for old, new in remap.items() if new == document.get('text_key')), document.get('text_key'))
                    value = supplied.get(old_key, supplied.get(old_id, document.get('seed_text', '')))
                    document['text_key'] = document['id']; document['seed_text'] = text(value)
                    # Publish restored Korean provenance with the cloned document so
                    # every tab initializes the same text, before the restoring tab runs.
                    document.pop('korean_seed', None)
                    if old_id in korean:
                        item = korean[old_id]
                        if not isinstance(item, dict) or item.get('meta') is not None and not isinstance(item.get('meta'), dict):
                            raise ValidationError('invalid snapshot Korean response')
                        document['korean_seed'] = {'text': text(item.get('text'), 'Korean response'), 'meta': copy.deepcopy(item.get('meta'))}
                    texts[document['id']] = value
                def strip_relative(value):
                    if isinstance(value, dict):
                        value.pop('anchorRelative', None); value.pop('headRelative', None)
                        for child in value.values(): strip_relative(child)
                    elif isinstance(value, list):
                        for child in value: strip_relative(child)
                for mapping in round_['mappings']:
                    strip_relative(mapping)
                    valid_spans = []
                    for span in mapping.get('response_spans', []):
                        span.pop('anchorRelative', None); span.pop('headRelative', None)
                        try:
                            if span.get('document_id') not in texts: raise ValidationError('missing restored text')
                            span['start'], span['end'] = utf16_offsets(texts[span['document_id']], span.get('quote'), span.get('start'))
                            span['content_hash'] = hashlib.sha256(texts[span['document_id']].encode()).hexdigest()
                            valid_spans.append(span)
                        except ValidationError:
                            span.pop('start', None); span.pop('end', None)
                            mapping.setdefault('invalidated_spans', []).append(span)
                            stale_mapping(mapping, 'restored_anchor_invalid')
                    mapping['response_spans'] = valid_spans
                for imported in round_['imports']:
                    if 'extraction_revision' in imported: imported['extraction_revision']['id'] = uid()
                for submission in round_['submissions']:
                    submission['restored'] = True
                state['rounds'].append(round_)
            if len(state['rounds']) > 100:
                raise ValidationError('too many rounds')
            result = {'round_ids': [r['id'] for r in rounds], 'texts': texts, 'id_map': remap}
            if request_key is not None:
                db.execute('INSERT INTO restore_requests VALUES(?,?,?,?,?)', (*request, snapshot_hash, json.dumps(result)))
            return result
        return self.mutate(project, payload.get('expected_revision'), apply, replay=replay if request_key is not None else None)
