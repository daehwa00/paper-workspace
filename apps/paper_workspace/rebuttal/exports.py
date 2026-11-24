"""Mechanical submission assembly. Exports contain response text and rules checks only."""
from __future__ import annotations

import base64
import io
import json
import re
import zipfile
from pathlib import PurePosixPath

try:
    from .imports import ValidationError, text
except ImportError:
    from imports import ValidationError, text


def validate_rules(rules):
    if not isinstance(rules, dict):
        raise ValidationError('rules must be an object')
    result = json.loads(json.dumps(rules))
    if result.get('layout', 'per_reviewer') not in {'per_reviewer', 'unified', 'threads'}:
        raise ValidationError('invalid rules layout')
    if type(result.get('allow_common', True)) is not bool:
        raise ValidationError('invalid common response rule')
    limits = result.setdefault('limits', [])
    if not isinstance(limits, list) or len(limits) > 100:
        raise ValidationError('invalid limits')
    for limit in limits:
        if not isinstance(limit, dict) or limit.get('scope') not in {'document', 'total', 'target'}:
            raise ValidationError('invalid limit scope')
        if limit.get('unit') not in {'characters', 'words', 'pages'}:
            raise ValidationError('invalid limit unit')
        if type(limit.get('max')) is not int or not 1 <= limit['max'] <= 10_000_000:
            raise ValidationError('invalid limit maximum')
        if limit.get('basis', 'raw') not in {'raw', 'rendered'} or limit.get('character_mode', 'codepoints') not in {'codepoints', 'utf16'}:
            raise ValidationError('invalid counting basis')
        for key in ('count_spaces', 'count_newlines', 'include_headings', 'include_quotes', 'include_math', 'include_references'):
            if type(limit.get(key, True)) is not bool:
                raise ValidationError('invalid count option')
    result.setdefault('policies', {})
    result.setdefault('sources', [])
    for source in result['sources']:
        if not isinstance(source, dict) or source.get('status', 'unverified') not in {'verified', 'unverified', 'conflict'}:
            raise ValidationError('invalid rule source')
        source.setdefault('status', 'unverified')
    return result


def selected_documents(round_, payload):
    texts = payload.get('texts')
    if not isinstance(texts, dict) or len(texts) > 400:
        raise ValidationError('texts snapshot must be an object')
    target = payload.get('target') or {}
    if not isinstance(target, dict):
        raise ValidationError('invalid export target')
    ids = target.get('document_ids', [d['id'] for d in round_['documents']])
    if not isinstance(ids, list) or not ids or len(ids) != len(set(ids)):
        raise ValidationError('select at least one document')
    by_id = {d['id']: d for d in round_['documents']}
    if any(identifier not in by_id for identifier in ids) or any(identifier not in by_id for identifier in texts):
        raise ValidationError('unknown document')
    common_mode = target.get('common_mode', 'include')
    if common_mode not in {'include', 'exclude', 'prepend', 'append'}:
        raise ValidationError('invalid common response mode')
    if common_mode == 'prepend':
        ids = [d['id'] for d in round_['documents'] if d['kind'] == 'common'] + [i for i in ids if by_id[i]['kind'] != 'common']
    if common_mode == 'append':
        ids = [i for i in ids if by_id[i]['kind'] != 'common'] + [d['id'] for d in round_['documents'] if d['kind'] == 'common']
    documents = []
    for identifier in ids:
        document = by_id[identifier]
        if common_mode == 'exclude' and document['kind'] == 'common':
            continue
        if identifier not in texts:
            raise ValidationError('live response snapshot is missing a document')
        documents.append({'id': identifier, 'title': document['title'], 'kind': document['kind'], 'text': text(texts[identifier])})
    if not documents:
        raise ValidationError('empty export target')
    return documents, target


def count_text(value, limit):
    if not limit.get('include_headings', True):
        value = re.sub(r'^\s{0,3}#{1,6}\s.*$', '', value, flags=re.M)
    if not limit.get('include_quotes', True):
        value = re.sub(r'^\s*>.*$', '', value, flags=re.M)
    if not limit.get('include_math', True):
        value = re.sub(r'\$\$[\s\S]*?\$\$|\$[^\n$]*\$', '', value)
    if not limit.get('include_references', True):
        value = re.split(r'^\s*#{0,6}\s*(?:References|Bibliography)\s*$', value, flags=re.M | re.I)[0]
    if limit.get('basis', 'raw') == 'rendered':
        # Conservative plain representation. Complex markup must be checked in PDF.
        value = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', value)
        value = re.sub(r'(^\s{0,3}#{1,6}\s+)|[`*_]', '', value, flags=re.M)
    if limit['unit'] == 'words':
        return len(re.findall(r'\S+', value))
    if not limit.get('count_spaces', True):
        value = re.sub(r'[^\S\r\n]', '', value)
    if not limit.get('count_newlines', True):
        value = value.replace('\r', '').replace('\n', '')
    return len(value.encode('utf-16-le')) // 2 if limit.get('character_mode') == 'utf16' else len(value)


def assemble(round_, payload, compiler):
    documents, target = selected_documents(round_, payload)
    rules = next((r for r in round_['rules'] if r['id'] == round_.get('active_rules_id')), None)
    title = text(target.get('title', round_['title']), 'title', 500)
    output_text = '\n\n'.join(d['text'] for d in documents)
    format_ = payload.get('format', target.get('format', 'markdown'))
    if format_ not in {'txt', 'markdown', 'json', 'zip', 'pdf', 'source'}:
        raise ValidationError('invalid export format')
    render_cache = {}
    def render_documents(items):
        key = json.dumps(items, ensure_ascii=False, sort_keys=True)
        if key not in render_cache:
            request = {'documents': [{k: d[k] for k in ('id', 'title', 'text')} for d in items]}
            if payload.get('template') is not None: request['template'] = payload['template']
            compiled = compiler('/rebuttal-render', request)
            if not isinstance(compiled, dict) or not isinstance(compiled.get('pdf'), str) or type(compiled.get('page_count')) is not int:
                raise ValidationError('invalid compiler render response')
            render_cache[key] = compiled
        return render_cache[key]
    render = render_documents(documents) if format_ in {'pdf', 'source'} else None
    checks = []
    if rules:
        if not rules.get('allow_common', True) and any(d['kind'] == 'common' for d in documents):
            checks.append({'id': 'common', 'passed': False, 'reason': 'Common responses are not allowed'})
        for index, limit in enumerate(rules.get('limits', [])):
            targets = documents
            if limit['scope'] == 'document':
                targets = [d for d in documents if not limit.get('document_id') or limit['document_id'] == d['id']]
            elif limit['scope'] == 'total':
                if any(d['id'] not in payload['texts'] for d in round_['documents']):
                    raise ValidationError('total limits require every response text')
                targets = [{**d, 'text': text(payload['texts'][d['id']])} for d in round_['documents']]
            groups = [[d] for d in targets] if limit['scope'] == 'document' else [targets]
            for group in groups:
                source = '\n\n'.join(d['text'] for d in group)
                if limit['unit'] == 'pages':
                    count = render_documents(group)['page_count']
                elif limit.get('basis', 'raw') == 'rendered':
                    # Count the compiler's actual extracted PDF text, including math and references.
                    # Exclusion options are applied to source before rendering for reproducibility.
                    count_docs = []
                    for d in group:
                        cleaned = d['text']
                        if not limit.get('include_headings', True): cleaned = re.sub(r'^\s{0,3}#{1,6}\s.*$', '', cleaned, flags=re.M)
                        if not limit.get('include_quotes', True): cleaned = re.sub(r'^\s*>.*$', '', cleaned, flags=re.M)
                        if not limit.get('include_math', True): cleaned = re.sub(r'\$\$[\s\S]*?\$\$|\$[^\n$]*\$', '', cleaned)
                        if not limit.get('include_references', True): cleaned = re.split(r'^\s*#{0,6}\s*(?:References|Bibliography)\s*$', cleaned, flags=re.M | re.I)[0]
                        count_docs.append({**d, 'title': d['title'] if limit.get('include_headings', True) else '', 'text': cleaned})
                    compiled = render_documents(count_docs)
                    extracted = compiler('/extract-review', {'data_base64': compiled['pdf']})
                    source = text(extracted.get('text'), 'rendered text')
                    # PDF extraction already removes markup. Count exact extracted text once.
                    count = count_text(source, {**limit, 'basis': 'raw', 'include_headings': True, 'include_quotes': True, 'include_math': True, 'include_references': True})
                else:
                    count = count_text(source, limit)
                check = {'id': limit.get('id', f'limit-{index}'), 'unit': limit['unit'], 'count': count,
                         'max': limit['max'], 'passed': count <= limit['max'], 'basis': limit.get('basis', 'raw')}
                if len(group) == 1: check['document_id'] = group[0]['id']
                checks.append(check)
    filename = 'rebuttal-' + round_['id']
    public = {'title': title, 'documents': documents, 'text': output_text, 'checks': checks}
    result = {'text': output_text, 'checks': checks, 'filename': filename}
    if format_ in {'txt', 'markdown'}:
        result.update(filename=filename + ('.txt' if format_ == 'txt' else '.md'), mime='text/plain' if format_ == 'txt' else 'text/markdown', content=output_text)
    elif format_ == 'json':
        result.update(filename=filename + '.json', mime='application/json', content=json.dumps(public, ensure_ascii=False, indent=2))
    elif format_ == 'pdf':
        result.update(filename=filename + '.pdf', mime='application/pdf', data_base64=render['pdf'], page_count=render['page_count'])
    else:
        files = {'rebuttal.md': output_text, 'submission.json': json.dumps(public, ensure_ascii=False, indent=2)}
        if render:
            for path, value in render.get('files', {}).items():
                p = PurePosixPath(path)
                if p.is_absolute() or '\\' in path or any(part in {'', '.', '..'} for part in path.split('/')):
                    raise ValidationError('unsafe compiler source path')
                files['source/' + path] = text(value)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            for path, value in files.items():
                archive.writestr(path, value)
        result.update(filename=filename + '.zip', mime='application/zip', data_base64=base64.b64encode(buffer.getvalue()).decode())
    if render:
        result['warnings'] = render.get('warnings', [])
    return result
