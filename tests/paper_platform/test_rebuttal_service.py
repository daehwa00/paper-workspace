from __future__ import annotations

import base64
import copy
import importlib.util
import io
import json
import threading
import time
import urllib.error
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
PATH = ROOT / 'apps/paper_workspace/rebuttal/server.py'


def load():
    spec = importlib.util.spec_from_file_location('paper_rebuttal_server', PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def api():
    return load()


@pytest.fixture
def domain(tmp_path, api):
    assets = {}
    def compiler(path, payload):
        if path == '/extract-review': return {'pages': [{'page': 1, 'text': 'Original PDF review'}], 'text': 'Original PDF review'}
        return {'pdf': base64.b64encode(b'%PDF-fake').decode(), 'page_count': len(payload['documents']), 'files': {'rebuttal.tex': 'Safe generated source'}, 'warnings': []}
    store = api.RebuttalStore(tmp_path / 'rebuttal.sqlite3', compiler=compiler,
                              asset_write=lambda project, path, data, actor: assets.__setitem__((project, path), data),
                              asset_read=lambda project, path: assets[(project, path)])
    state = store.create_round('paper', {'title': 'Round one', 'expected_revision': 0})
    round_id = state['rounds'][0]['id']
    return store, round_id, assets


def mutation(store, round_id, method, **payload):
    payload['expected_revision'] = store.state('paper')['revision']
    return getattr(store, method)('paper', round_id, payload)


def document(store, round_id, title='Reviewer response', kind='reviewer'):
    result = mutation(store, round_id, 'create_document', title=title, kind=kind)
    return result['result']['document']['id']


def import_review(store, round_id, value='Please clarify the result.'):
    staged = mutation(store, round_id, 'stage_import', kind='text', text=value)['result']['import']
    store.commit_import('paper', round_id, staged['id'], {'reviews': staged['reviews'], 'expected_revision': store.state('paper')['revision']}, 'Dae')
    return store.state('paper')['rounds'][0]['reviews'][0]


def test_optimistic_revision_is_atomic_and_persistent(api, domain):
    store, round_id, _ = domain
    assert store.state('paper')['revision'] == 1
    with pytest.raises(api.Conflict) as error:
        store.create_document('paper', round_id, {'title': 'Lost edit', 'kind': 'common', 'expected_revision': 0})
    assert error.value.revision == 1
    document(store, round_id)
    reopened = api.RebuttalStore(store.database_path)
    assert reopened.state('paper') == store.state('paper')
    assert reopened.state('other')['rounds'] == []


def test_import_preview_commit_preserves_source_and_manual_translation_history(api, domain):
    store, round_id, _ = domain
    staged = mutation(store, round_id, 'stage_import', kind='text', text='Original text')['result']['import']
    edited = copy.deepcopy(staged['reviews']); edited[0]['fields']['review'] = 'Edited extraction'
    store.commit_import('paper', round_id, staged['id'], {'reviews': edited, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    round_ = store.state('paper')['rounds'][0]
    assert round_['imports'][0]['raw']['text'] == 'Original text'
    assert round_['reviews'][0]['fields']['review'] == 'Edited extraction'
    round_['reviews'][0]['translations'] = {'review': '수동 번역'}
    result = mutation(store, round_id, 'update_round', round=round_)
    review = result['rounds'][0]['reviews'][0]
    assert review['translation_revisions'][0]['origin'] == 'manual'
    round_ = result['rounds'][0]; round_['reviews'][0]['fields']['review'] = 'Tampered source'
    with pytest.raises(api.ValidationError, match='immutable'):
        mutation(store, round_id, 'update_round', round=round_)
    assert store.state('paper')['rounds'][0]['reviews'][0]['fields']['review'] == 'Edited extraction'


def test_pdf_sources_use_asset_refs_and_portable_zip(domain):
    store, round_id, assets = domain
    staged = mutation(store, round_id, 'stage_import', kind='pdf', filename='review.pdf', data_base64=base64.b64encode(b'%PDF-review').decode())['result']['import']
    assert 'data_base64' not in staged['raw']
    assert staged['raw']['asset']['path'].startswith('rebuttal/sources/')
    assert len(assets) == 1
    doc_id = document(store, round_id)
    result = store.export('paper', round_id, {'format': 'zip', 'texts': {doc_id: 'A useful answer.'}, 'expected_revision': store.state('paper')['revision']})['result']
    archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(result['data_base64'])))
    assert archive.read('sources/' + staged['raw']['asset']['sha256'] + '.pdf') == b'%PDF-review'
    assert json.loads(archive.read('round.json'))['texts'][doc_id] == 'A useful answer.'


def test_many_spans_utf16_offsets_and_edit_invalidation(api, domain):
    store, round_id, _ = domain
    review = import_review(store, round_id, '😀 first issue and second issue')
    doc = document(store, round_id)
    round_ = store.state('paper')['rounds'][0]
    round_['concerns'] = [{'id': 'concern-one', 'title': 'Explain both', 'reviewer_id': review['reviewer_id'], 'source_spans': [
        {'review_id': review['id'], 'field': 'review', 'quote': 'first issue'}, {'review_id': review['id'], 'field': 'review', 'quote': 'second issue'}]}]
    round_['mappings'] = [{'id': 'map-one', 'concern_id': 'concern-one', 'coverage': 'addressed', 'decision': 'confirmed', 'response_spans': [
        {'document_id': doc, 'quote': 'Answer one', 'start': 999}, {'document_id': doc, 'quote': 'Answer two', 'start': 999}]}]
    result = mutation(store, round_id, 'update_round', round=round_, texts={doc: '😀 Answer one. Answer two.'})
    mapping = result['rounds'][0]['mappings'][0]
    assert mapping['response_spans'][0]['start'] == 3
    assert result['rounds'][0]['concerns'][0]['source_spans'][0]['start'] == 3
    result = mutation(store, round_id, 'update_round', round=result['rounds'][0], texts={doc: 'The answer changed'})
    assert result['rounds'][0]['mappings'][0]['stale'] is True
    assert result['rounds'][0]['mappings'][0]['decision'] == 'proposed'
    assert result['rounds'][0]['mappings'][0]['decision_history'][0]['decision'] == 'confirmed'
    result = mutation(store, round_id, 'update_round', round=result['rounds'][0], texts={doc: 'Changed again'})
    assert result['rounds'][0]['mappings'][0]['stale'] is True
    assert result['jobs'] == []
    malicious = result['rounds'][0]; malicious['mappings'][0]['response_spans'][0]['quote'] = 'Invented'
    with pytest.raises(api.ValidationError, match='quote'):
        mutation(store, round_id, 'update_round', round=malicious, texts={doc: 'The answer changed'})


def apply_rules(store, round_id, rules):
    draft = store.add_rules('paper', round_id, {'rules': rules, 'expected_revision': store.state('paper')['revision']}, 'Dae')['result']['rules']
    return store.apply_rules('paper', round_id, draft['id'], {'expected_revision': store.state('paper')['revision']}, 'Dae')


def test_rules_explicit_application_counts_and_freezes_clean_submission(api, domain):
    store, round_id, _ = domain
    doc = document(store, round_id, title='Heading')
    draft = store.add_rules('paper', round_id, {'rules': {'venue': 'Test', 'limits': []}, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    assert draft['rounds'][0]['active_rules_id'] is None
    apply_rules(store, round_id, {'layout': 'per_reviewer', 'allow_common': True, 'limits': [{'scope': 'document', 'unit': 'characters', 'max': 3,
                 'include_headings': False, 'count_spaces': False, 'count_newlines': False, 'character_mode': 'utf16'}]})
    payload = {'format': 'txt', 'texts': {doc: '😀 a'}, 'expected_revision': store.state('paper')['revision']}
    exported = store.export('paper', round_id, payload)
    assert exported['result']['checks'][0]['count'] == 3
    assert store.state('paper')['revision'] == payload['expected_revision']
    submitted = store.submit('paper', round_id, payload, 'Dae')
    assert 'concerns' not in submitted['result']['submission']['output']
    assert submitted['result']['submission']['texts'][doc] == '😀 a'
    with pytest.raises(api.ValidationError, match='exceeds'):
        store.submit('paper', round_id, {'format': 'txt', 'texts': {doc: 'Too long'}, 'expected_revision': submitted['revision']}, 'Dae')
    assert len(store.state('paper')['rounds'][0]['submissions']) == 1


def test_document_page_limits_render_each_document_and_total_needs_all_texts(api, domain):
    store, round_id, _ = domain
    first = document(store, round_id); second = document(store, round_id)
    apply_rules(store, round_id, {'limits': [{'scope': 'document', 'unit': 'pages', 'max': 1}]})
    result = store.export('paper', round_id, {'format': 'txt', 'texts': {first: 'one', second: 'two'}, 'expected_revision': store.state('paper')['revision']})
    assert [c['count'] for c in result['result']['checks']] == [1, 1]
    apply_rules(store, round_id, {'limits': [{'scope': 'total', 'unit': 'words', 'max': 2, 'include_headings': False}]})
    with pytest.raises(api.ValidationError, match='every response'):
        store.export('paper', round_id, {'format': 'txt', 'target': {'document_ids': [first]}, 'texts': {first: 'one'}, 'expected_revision': store.state('paper')['revision']})


def test_restore_clones_ids_preserves_raw_and_uses_live_text_key(domain):
    store, round_id, _ = domain
    review = import_review(store, round_id)
    doc = document(store, round_id)
    snapshot = store.snapshot('paper')
    snapshot['texts'] = {doc: 'Live collaboration text'}
    result = store.restore('paper', {'snapshot': snapshot, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    original, cloned = result['rounds']
    assert cloned['id'] != original['id']
    assert cloned['reviews'][0]['id'] != review['id']
    assert cloned['reviews'][0]['source_id'] == cloned['imports'][0]['id']
    assert cloned['imports'][0]['raw'] == original['imports'][0]['raw']
    new_doc = cloned['documents'][0]
    assert new_doc['seed_text'] == 'Live collaboration text'
    assert result['result']['texts'] == {new_doc['text_key']: 'Live collaboration text'}
    assert result['result']['id_map'][round_id] == cloned['id']
    assert result['result']['id_map'][doc] == new_doc['id']


def test_fair_queue_persists_and_recovers(api, domain):
    store, round_id, _ = domain
    other = store.create_round('other', {'title': 'Other', 'expected_revision': 0})['rounds'][0]['id']
    for project, rid in [('paper', round_id), ('paper', round_id), ('other', other)]:
        store.queue(project, rid, {'task': 'style', 'texts': {}, 'expected_revision': store.state(project)['revision']}, 'Dae')
    first = store._claim(); second = store._claim()
    assert [first[0], second[0]] == ['paper', 'other']
    reopened = api.RebuttalStore(store.database_path)
    assert {j['status'] for j in reopened.state('paper')['jobs']} == {'failed', 'queued'}
    interrupted = next(j for j in reopened.state('paper')['jobs'] if j['status'] == 'failed')
    assert interrupted['stage'] == 'interrupted'
    assert reopened.state('other')['jobs'][0]['status'] == 'failed'
    assert reopened._last_project == 'other'
    assert reopened._claim()[0] == 'paper'


def test_worker_validates_result_and_publishes_proposal_without_manual_overwrite(domain):
    store, round_id, _ = domain
    doc = document(store, round_id)
    calls = []
    def bridge(task, payload, profile, job_id):
        calls.append(job_id)
        return {'findings': [{'document_id': doc, 'quote': 'answer', 'type': 'style', 'reason': 'Be precise', 'suggestion': 'specific answer'}]}
    store.bridge = bridge
    store.queue('paper', round_id, {'task': 'style', 'texts': {doc: 'The answer'}, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    store.start()
    try:
        deadline = time.time() + 3
        while time.time() < deadline:
            state = store.state('paper')
            if state['jobs'][0]['status'] in {'completed', 'failed'}: break
            time.sleep(.01)
        assert state['jobs'][0]['status'] == 'completed'
        finding = state['rounds'][0]['findings'][0]
        assert finding['origin'] == 'ai' and finding['input_hash']
        assert finding['start'] == 4
        assert finding['stale'] is False
        round_ = state['rounds'][0]; round_['findings'][0]['status'] = 'confirmed'
        mutation(store, round_id, 'update_round', round=round_, texts={doc: 'The answer'})
        before = len(calls)
        result = store.queue('paper', round_id, {'task': 'style', 'texts': {doc: 'The answer'}, 'expected_revision': store.state('paper')['revision']}, 'Dae')
        assert result['result']['job']['stage'] == 'cached'
        assert len(calls) == before
        assert result['rounds'][0]['findings'][0]['status'] == 'confirmed'
    finally: store.close()


def test_completed_connections_survive_server_reopen(api, domain):
    store, round_id, _ = domain
    review=import_review(store,round_id,'Please clarify the result.')
    doc=document(store,round_id,kind='common')
    field=next(iter(review['fields']))
    def bridge(task,payload,profile,job_id):
        assert task=='direct_connect'
        return {'links':[{'title':'Result','source_spans':[{'review_id':review['id'],'field':field,'quote':'Please clarify the result.'}],'response_spans':[{'document_id':doc,'quote':'We explain the result.'}],'relationship':'direct','reason':'리뷰의 결과 설명 요청에 답변합니다.'}]}
    store.bridge=bridge
    store.queue('paper',round_id,{'task':'connect','texts':{doc:'We explain the result.'},'scope':{'review_ids':[review['id']],'document_ids':[doc]},'expected_revision':store.state('paper')['revision']},'Dae')
    store.start()
    try:
        deadline=time.time()+3
        while time.time()<deadline:
            state=store.state('paper')
            if state['jobs'][0]['status'] in {'completed','failed'}:break
            time.sleep(.01)
        assert state['jobs'][0]['status']=='completed'
        assert len(state['rounds'][0]['mappings'])==1
    finally:store.close()
    reopened=api.RebuttalStore(store.database_path)
    saved=reopened.state('paper')['rounds'][0]
    assert len(saved['concerns'])==1 and len(saved['mappings'])==1
    assert saved['mappings'][0]['response_spans'][0]['quote']=='We explain the result.'


def test_cancel_retry_and_stale_job_result(api, domain, monkeypatch):
    store, round_id, _ = domain
    doc = document(store, round_id)
    queued = store.queue('paper', round_id, {'task': 'style', 'texts': {doc: 'answer'}, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    job_id = queued['result']['job']['id']
    monkeypatch.setattr(api, 'json_request', lambda *a, **k: {})
    cancelled = store.job_action('paper', round_id, job_id, {'expected_revision': queued['revision']}, 'cancel')
    assert cancelled['result']['job']['status'] == 'cancelled'
    retried = store.job_action('paper', round_id, job_id, {'expected_revision': cancelled['revision']}, 'retry')
    assert retried['result']['job']['attempt'] == 2
    store._claim()
    round_ = store.state('paper')['rounds'][0]
    mutation(store, round_id, 'update_round', round=round_, texts={doc: 'changed'})
    store._job_update('paper', job_id, {'status': 'completed', 'result': {'findings': [{'document_id': doc, 'quote': 'answer'}]}}, publish=True)
    assert store.state('paper')['rounds'][0]['findings'][0]['stale'] is True


def test_research_payload_contains_only_public_form_metadata(domain):
    store, round_id, _ = domain
    import_review(store, round_id, 'Private review')
    document(store, round_id)
    result = store.queue('paper', round_id, {'task': 'research_rules', 'texts': {store.state('paper')['rounds'][0]['documents'][0]['id']: 'Private answer'},
        'research': {'venue': 'Venue', 'year': 2026, 'track': 'Main', 'stage': 'rebuttal', 'sources': [{'url': 'https://venue.example/rules'}]},
        'expected_revision': store.state('paper')['revision']}, 'Dae')
    with store._connect() as db: payload = json.loads(db.execute('SELECT data FROM jobs').fetchone()[0])['payload']
    assert set(payload) == {'venue', 'year', 'track', 'stage', 'official_urls'}
    assert 'Private' not in json.dumps(payload)


def test_credentials_and_unsafe_ids_rejected(api, domain):
    store, round_id, _ = domain
    with pytest.raises(api.ValidationError): store.state('../paper')
    with pytest.raises(api.ValidationError, match='credential'):
        store.add_rules('paper', round_id, {'rules': {'limits': [], 'password': 'Never persist'}, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    with store._connect() as db:
        assert 'Never persist' not in db.execute('SELECT state FROM projects').fetchone()[0]


@pytest.fixture
def http_server(api, domain):
    store, round_id, _ = domain
    class Handler(api.RebuttalHandler):
        pass
    Handler.store = store; Handler.enabled = True; Handler.actor_mode = 'proxy'
    Handler.allowed_projects = {'paper'}; Handler.catalog = None
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    yield f'http://127.0.0.1:{server.server_port}', store, round_id, Handler
    server.shutdown(); server.server_close(); thread.join()


def request_http(base, path, method='GET', body=None, role='editor', actor='Dae', **headers):
    request_headers = {'X-Paper-Role': role, 'X-Paper-Actor': actor, 'X-Paper-Allowed-Projects': 'paper', **headers}
    if body is not None:
        request_headers['Content-Type'] = 'application/json'; data = json.dumps(body).encode()
    else: data = None
    request = urllib.request.Request(base + '/api/rebuttal/projects/' + path, method=method, data=data, headers=request_headers)
    try: response = urllib.request.urlopen(request)
    except urllib.error.HTTPError as error: response = error
    raw = response.read()
    return response.code, json.loads(raw) if raw else None, response.headers


def test_http_auth_revision_etag_and_export_viewer_exception(http_server):
    base, store, round_id, handler = http_server
    status, state, headers = request_http(base, 'paper/state')
    assert status == 200
    assert request_http(base, 'paper/state', **{'If-None-Match': headers['ETag']})[0] == 304
    assert request_http(base, 'unknown/state')[0] == 404
    assert request_http(base, 'paper/state', actor='')[0] == 403
    assert request_http(base, 'paper/rounds', method='POST', role='viewer', body={'title': 'bad', 'expected_revision': state['revision']})[0] == 403
    assert request_http(base, 'paper/rounds', method='POST', body={'title': 'bad', 'expected_revision': 0})[:2] == (409, {'error': 'revision conflict', 'revision': state['revision']})
    doc = document(store, round_id)
    revision = store.state('paper')['revision']
    status, result, _ = request_http(base, f'paper/rounds/{round_id}/exports', method='POST', role='viewer', body={'format': 'txt', 'texts': {doc: 'Answer'}, 'expected_revision': revision})
    assert status == 200 and result['result']['content'].endswith('Answer')
    assert store.state('paper')['revision'] == revision
    assert request_http(base, 'paper/rounds', method='POST', body={'title': 'bad', 'expected_revision': revision}, Origin='https://attacker.example')[0] == 403
    handler.enabled = False
    assert request_http(base, 'paper/state')[1]['enabled'] is False
    assert request_http(base, 'paper/rounds', method='POST', body={'title': 'bad', 'expected_revision': revision})[0] == 404


def test_slug_resolves_manifest_backup_id(api, tmp_path):
    (tmp_path / 'project').mkdir(); (tmp_path / 'projects').mkdir()
    (tmp_path / 'projects/index.json').write_text(json.dumps({'projects': [{'slug': 'public-slug', 'source': 'default'}]}))
    (tmp_path / 'project/project.json').write_text(json.dumps({'id': 'backup-id'}))
    assert api.ProjectCatalog(tmp_path).resolve('public-slug') == 'backup-id'
    with pytest.raises(api.NotFound): api.ProjectCatalog(tmp_path).resolve('backup-id')


def test_catalog_reads_only_manifest_paper_sources_and_rejects_escape(api, tmp_path):
    (tmp_path / 'project').mkdir(); (tmp_path / 'projects').mkdir()
    (tmp_path / 'projects/index.json').write_text(json.dumps({'projects': [{'slug': 'paper', 'source': 'default'}]}))
    root=tmp_path / 'project'
    (root / 'main.tex').write_text('Paper source')
    (root / 'references.bib').write_text('References')
    (root / 'private.txt').write_text('Not paper')
    manifest={'id':'paper','entrypoint':'main.tex','files':[{'path':'main.tex'},{'path':'references.bib'},{'path':'private.txt'}]}
    (root / 'project.json').write_text(json.dumps(manifest))
    paper=api.ProjectCatalog(tmp_path).manuscript('paper')
    assert paper['entrypoint']=='main.tex'
    assert paper['files']==[{'path':'main.tex','text':'Paper source'},{'path':'references.bib','text':'References'}]
    (tmp_path/'escape.tex').write_text('outside')
    manifest['files'].append({'path':'../escape.tex'})
    (root / 'project.json').write_text(json.dumps(manifest))
    with pytest.raises(api.ValidationError): api.ProjectCatalog(tmp_path).manuscript('paper')


def test_default_bridge_profile_omits_null_and_selection_public_is_safe(api, monkeypatch, domain):
    requests = []
    monkeypatch.setattr(api, 'json_request', lambda url, payload, token, **kwargs: requests.append(payload) or {'result': {}})
    api.RebuttalStore._bridge('style', {'documents': []}, job_id='job')
    assert 'profile' not in requests[0]
    api.RebuttalStore._bridge('style', {'documents': []}, profile='careful', job_id='job')
    assert requests[1]['profile'] == 'careful'
    store, rid, _ = domain
    doc = document(store, rid)
    result = store.queue('paper', rid, {'task': 'rewrite', 'selection': {'document_id': doc, 'quote': 'Answer', 'start': 0, 'end': 6, 'secret': 'omit'},
        'texts': {doc: 'Answer'}, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    assert result['result']['job']['selection'] == {'document_id': doc, 'quote': 'Answer', 'start': 0, 'end': 6}


def test_proxy_wildcard_scope_requires_explicit_shared_mode_and_known_project(http_server):
    base, store, rid, handler = http_server
    headers = {'X-Paper-Allowed-Projects': '*'}
    assert request_http(base, 'paper/state', **headers)[0] == 403
    handler.shared_scope = True
    assert request_http(base, 'paper/state', **headers)[0] == 200
    assert request_http(base, 'unregistered/state', **headers)[0] == 404


def test_auth_cookie_change_revokes_openreview_connection_binding(api):
    handler = api.RebuttalHandler.__new__(api.RebuttalHandler)
    handler.headers = {'Cookie': 'paper_session=old-auth; _oauth2_proxy=old-proxy'}
    raw = 'a' * 64
    old_binding = handler._session_binding(raw)
    pool = api.SessionPool(request=lambda *a, **k: {'token': 'PRIVATE'})
    result = pool.connect('Dae', old_binding, 'user', 'password')
    handler.headers = {'Cookie': 'paper_session=new-auth; _oauth2_proxy=old-proxy'}
    assert handler._session_binding(raw) != old_binding
    with pytest.raises(api.ValidationError, match='expired'):
        pool.notes('Dae', handler._session_binding(raw), 'Forum', connection_id=result['connection_id'])


def test_concern_change_and_new_document_invalidate_coverage_with_history(domain):
    store, rid, _ = domain
    review = import_review(store, rid, 'first issue and second issue')
    doc = document(store, rid)
    round_ = store.state('paper')['rounds'][0]
    round_['concerns'] = [{'id': 'concern', 'title': 'First issue', 'requires_response': True, 'source_spans': [
        {'review_id': review['id'], 'field': 'review', 'quote': 'first issue'}]}]
    round_['mappings'] = [{'id': 'mapping', 'concern_id': 'concern', 'coverage': 'addressed', 'decision': 'confirmed',
        'response_spans': [{'document_id': doc, 'quote': 'Answer'}]}]
    state = mutation(store, rid, 'update_round', round=round_, texts={doc: 'Answer'})
    assert not state['rounds'][0]['mappings'][0].get('stale')
    round_ = state['rounds'][0]
    round_['concerns'][0]['title'] = 'First AND second issues'
    round_['concerns'][0]['source_spans'].append({'review_id': review['id'], 'field': 'review', 'quote': 'second issue'})
    state = mutation(store, rid, 'update_round', round=round_, texts={doc: 'Answer'})
    mapping = state['rounds'][0]['mappings'][0]
    assert mapping['stale'] and mapping['needs_reconfirmation'] and mapping['decision'] == 'proposed'
    assert mapping['decision_history'][0]['decision'] == 'confirmed'
    round_ = state['rounds'][0]
    round_['mappings'] = [{'id': 'missing', 'concern_id': 'concern', 'coverage': 'missing', 'decision': 'confirmed', 'response_spans': []}]
    state = mutation(store, rid, 'update_round', round=round_, texts={doc: 'Answer'})
    state = mutation(store, rid, 'update_round', round=state['rounds'][0], texts={doc: 'A new answer'})
    assert state['rounds'][0]['mappings'][0]['stale']
    # A new response document also invalidates a missing judgment with no response spans.
    state['rounds'][0]['mappings'][0].update(stale=False, needs_reconfirmation=False, decision='confirmed')
    mutation(store, rid, 'update_round', round=state['rounds'][0], texts={doc: 'A new answer'})
    document(store, rid, title='Added answer')
    mapping = store.state('paper')['rounds'][0]['mappings'][0]
    assert mapping['stale'] and mapping['needs_reconfirmation']


def test_restore_removes_original_yjs_anchors_and_rejects_invalid_active_spans(domain):
    store, rid, _ = domain
    review = import_review(store, rid)
    doc = document(store, rid)
    round_ = store.state('paper')['rounds'][0]
    round_['concerns'] = [{'id': 'concern', 'title': 'Concern', 'source_spans': []}]
    round_['mappings'] = [{'id': 'mapping', 'concern_id': 'concern', 'coverage': 'addressed', 'decision': 'confirmed',
        'invalidated_spans': [{'document_id': doc, 'quote': 'Previous', 'anchorRelative': [8, 9], 'headRelative': [10, 11]}], 'dependency_document_ids': [doc], 'response_spans': [{'document_id': doc, 'quote': 'Answer', 'anchorRelative': [1, 2], 'headRelative': [3, 4]}]}]
    mutation(store, rid, 'update_round', round=round_, texts={doc: 'Answer'})
    snapshot = store.snapshot('paper'); snapshot['texts'] = {doc: 'Answer'}
    state = store.restore('paper', {'snapshot': snapshot, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    span = state['rounds'][-1]['mappings'][0]['response_spans'][0]
    assert 'anchorRelative' not in span and 'headRelative' not in span
    assert 'anchorRelative' not in state['rounds'][-1]['mappings'][0]['invalidated_spans'][0]
    assert span['start'] == 0 and span['end'] == 6
    assert state['rounds'][-1]['mappings'][0]['dependency_document_ids'] == [state['rounds'][-1]['documents'][0]['id']]
    snapshot['texts'] = {doc: 'Changed text'}
    state = store.restore('paper', {'snapshot': snapshot, 'expected_revision': state['revision']}, 'Dae')
    mapping = state['rounds'][-1]['mappings'][0]
    assert mapping['response_spans'] == [] and mapping['needs_reconfirmation']
    assert mapping['invalidated_spans'][-1]['quote'] == 'Answer'


def test_body_only_export_and_mechanical_limit_ignore_document_metadata_title(domain):
    store, rid, _ = domain
    doc = document(store, rid, title='Response')
    apply_rules(store, rid, {'limits': [{'scope': 'document', 'unit': 'characters', 'max': 5}]})
    result = store.export('paper', rid, {'format': 'txt', 'texts': {doc: 'Hello'}, 'expected_revision': store.state('paper')['revision']})['result']
    assert result['content'] == 'Hello'
    assert result['checks'][0]['count'] == 5 and result['checks'][0]['passed']


def test_cancelled_previous_attempt_cannot_publish_into_retried_job(api, domain, monkeypatch):
    store, rid, _ = domain
    monkeypatch.setattr(api, 'json_request', lambda *a, **k: {})
    queued = store.queue('paper', rid, {'task': 'style', 'texts': {}, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    job_id = queued['result']['job']['id']; store._claim()
    cancelled = store.job_action('paper', rid, job_id, {'expected_revision': store.state('paper')['revision']}, 'cancel')
    retried = store.job_action('paper', rid, job_id, {'expected_revision': cancelled['revision']}, 'retry')
    assert store._cancelled(job_id, expected_attempt=1)
    store._job_update('paper', job_id, {'status': 'completed', 'result': {}}, expected_attempt=1)
    assert store.state('paper')['jobs'][0]['status'] == 'queued'
    assert store.state('paper')['revision'] == retried['revision']


def test_stale_mapping_reconfirmation_requires_explicit_signal_and_current_quotes(api, domain):
    store, rid, _ = domain
    doc = document(store, rid)
    round_ = store.state('paper')['rounds'][0]
    round_['concerns'] = [{'id': 'concern', 'title': 'Concern', 'source_spans': []}]
    round_['mappings'] = [{'id': 'mapping', 'concern_id': 'concern', 'coverage': 'addressed', 'decision': 'confirmed',
        'response_spans': [{'document_id': doc, 'quote': 'Answer'}]}]
    state = mutation(store, rid, 'update_round', round=round_, texts={doc: 'Answer'})
    state = mutation(store, rid, 'update_round', round=state['rounds'][0], texts={doc: 'Answer plus more'})
    round_ = state['rounds'][0]; round_['mappings'][0].update(stale=False, needs_reconfirmation=False)
    state = mutation(store, rid, 'update_round', round=round_, texts={doc: 'Answer plus more'})
    assert state['rounds'][0]['mappings'][0]['stale'] is True
    round_ = state['rounds'][0]; round_['mappings'][0].update(reconfirm=True, decision='confirmed')
    state = mutation(store, rid, 'update_round', round=round_, texts={doc: 'Answer plus more'})
    mapping = state['rounds'][0]['mappings'][0]
    assert mapping['stale'] is False and mapping['needs_reconfirmation'] is False
    assert mapping['decision'] == 'confirmed' and mapping['confirmed_input_hash']
    assert 'reconfirm' not in mapping
    mapping.update(reconfirm=True)
    with pytest.raises(api.ValidationError, match='quote'):
        mutation(store, rid, 'update_round', round=state['rounds'][0], texts={doc: 'Text removed'})


def test_failure_diagnostics_are_specific_without_leaking_model_text(api):
    class AnalysisError(ValueError):
        pass
    code, message = api.analysis_failure(AnalysisError('Quote absent from snapshot: PRIVATE_TOKEN'))
    assert code == 'unverified_quote'
    assert 'PRIVATE_TOKEN' not in message
    assert 'PRIVATE_TOKEN' not in api.analysis_failure(RuntimeError('PRIVATE_TOKEN'))[1]
    assert api.analysis_failure(AnalysisError('Translation must be Korean; regenerate the review translation'))[0] == 'invalid_translation_result'
    assert api.analysis_failure(AnalysisError('Connection reason must be Korean'))[0] == 'invalid_connection_reason'


def test_selected_review_analysis_snapshot_excludes_other_reviewers(api):
    round_ = {
        'reviews': [{'id':'r1','reviewer_id':'a','fields':{'review':'First review'}}, {'id':'r2','reviewer_id':'b','fields':{'review':'Second review'}}],
        'documents': [{'id':'d1','title':'First'}, {'id':'d2','title':'Second'}],
        'concerns': [{'id':'c1','reviewer_id':'a','source_spans':[{'review_id':'r1'}]}, {'id':'c2','reviewer_id':'b','source_spans':[{'review_id':'r2'}]}, {'id':'cross','reviewer_id':'a','source_spans':[{'review_id':'r1'},{'review_id':'r2'}]}],
        'glossary':{}, 'rules':[], 'active_rules_id':None,
    }
    request = {'texts':{'d1':'First answer','d2':'Second answer'}, 'scope':{'review_ids':['r1'],'document_ids':['d1']}}
    snapshot = api.RebuttalStore.analysis_payload(round_, request)
    assert [r['id'] for r in snapshot['reviews']] == ['r1']
    assert [d['id'] for d in snapshot['documents']] == ['d1']
    assert [c['id'] for c in snapshot['concerns']] == ['c1']
    request['scope']['document_ids'] = []
    assert api.RebuttalStore.analysis_payload(round_, request)['documents'] == []
    request['scope']['review_ids'] = ['unknown']
    with pytest.raises(api.ValidationError): api.RebuttalStore.analysis_payload(round_, request)


def test_connection_snapshot_requires_matching_reviewer_and_single_answer(api):
    round_ = {'reviews':[{'id':'r1','reviewer_id':'a','fields':{'review':'First'}},{'id':'r2','reviewer_id':'b','fields':{'review':'Second'}}],
              'documents':[{'id':'d1','title':'First','kind':'reviewer','reviewer_id':'a'}, {'id':'d2','title':'Second','kind':'reviewer','reviewer_id':'b'}],
              'concerns':[],'glossary':{},'rules':[],'active_rules_id':None}
    request={'task':'connect','texts':{'d1':'Answer one','d2':'Answer two'},'scope':{'review_ids':['r1'],'document_ids':['d1']}}
    snapshot=api.RebuttalStore.analysis_payload(round_,request)
    assert [r['id'] for r in snapshot['reviews']]==['r1']
    assert [d['id'] for d in snapshot['documents']]==['d1']
    request['scope']['document_ids']=['d2']
    with pytest.raises(api.ValidationError,match='does not match reviewer'):api.RebuttalStore.analysis_payload(round_,request)
    request['scope']['document_ids']=['d1','d2']
    with pytest.raises(api.ValidationError,match='one reviewer and one response'):api.RebuttalStore.analysis_payload(round_,request)


def test_new_sentence_connections_supersede_old_ai_links(api):
    review={'id':'r1','reviewer_id':'a','fields':{'review':'One. Two.'}}
    doc={'id':'d1','title':'Answer'}
    old={'id':'old','origin':'ai','decision':'proposed','comments':[],'source_spans':[{'review_id':'r1','field':'review','quote':'One. Two.'}]}
    kept={'id':'kept','origin':'manual','decision':'confirmed','comments':[],'source_spans':[{'review_id':'r1','field':'review','quote':'One.'}]}
    old_map={'id':'m1','concern_id':'old','origin':'ai','decision':'proposed','response_spans':[{'document_id':'d1','quote':'Answer.'}]}
    kept_map={'id':'m2','concern_id':'kept','origin':'ai','decision':'confirmed','response_spans':[{'document_id':'d1','quote':'Answer.'}]}
    round_={'reviews':[review],'documents':[doc],'glossary':{},'active_rules_id':None,'concerns':[old,kept],'mappings':[old_map,kept_map],'findings':[],'text_hashes':{'d1':'hash'}}
    job={'id':'newjob','task':'connect','prompt_version':'rebuttal-direct-connect-v2','input_hash':'new','text_hashes':{'d1':'hash'},'payload':{'reviews':[review],'documents':[doc]},'metadata_hash':api.RebuttalStore._metadata_hash(round_),'result':{'concerns':[{'id':'new','source_spans':[{'review_id':'r1','field':'review','quote':'One.'}]}],'mappings':[{'concern_id':'new','response_spans':[{'document_id':'d1','quote':'Answer.'}]}]}}
    api.RebuttalStore._publish(round_,job)
    assert old_map['superseded'] and old['superseded']
    assert not kept_map.get('superseded') and not kept.get('superseded')
    assert any(m.get('concern_id')=='new' and not m.get('superseded') for m in round_['mappings'])


def test_translation_publish_persists_sentence_alignment(api):
    review={'id':'r1','reviewer_id':'a','fields':{'review':'First sentence.'},'translations':{},'translation_revisions':[]}
    round_={'reviews':[review],'documents':[],'glossary':{},'active_rules_id':None,'concerns':[],'mappings':[],'findings':[],'text_hashes':{}}
    job={'task':'translate','input_hash':'hash','text_hashes':{},'metadata_hash':api.RebuttalStore._metadata_hash(round_),'result':{'translations':[{'review_id':'r1','field':'review','text':'첫 번째 문장입니다.','uncertain':[],'segments':[{'source':'First sentence.','text':'첫 번째 문장입니다.'}]}]}}
    api.RebuttalStore._publish(round_,job)
    assert review['translation_alignments']['review'] == {'source':'First sentence.','segments':[{'source':'First sentence.','text':'첫 번째 문장입니다.'}]}


def test_model_timeout_has_a_safe_specific_diagnostic(api):
    assert api.analysis_failure(TimeoutError('PRIVATE_TOKEN'))[0] == 'upstream_timeout'
    assert 'PRIVATE_TOKEN' not in api.analysis_failure(TimeoutError('PRIVATE_TOKEN'))[1]


def test_bridge_diagnostics_only_expose_allowlisted_categories(api, monkeypatch):
    import io
    import urllib.error
    def failed(*args, **kwargs):
        body = b'{"error_code":"model_auth_failed","error":"PRIVATE_REVIEW_OR_TOKEN"}'
        raise urllib.error.HTTPError('https://example.test', 422, 'private detail', {}, io.BytesIO(body))
    monkeypatch.setattr(urllib.request, 'urlopen', failed)
    with pytest.raises(api.UpstreamRequestError) as exc:
        api.json_request('https://example.test')
    code, message = api.analysis_failure(exc.value)
    assert code == 'model_auth_failed'
    assert 'PRIVATE' not in message and 'PRIVATE' not in str(exc.value)
    assert api.analysis_failure(api.UpstreamRequestError(401))[0] == 'bridge_auth_failed'
    assert api.analysis_failure(api.UpstreamRequestError(422, 'unknown_private_text'))[0] == 'upstream_http_error'


def test_bridge_waits_longer_than_the_model_process_deadline(api, monkeypatch):
    calls = []
    monkeypatch.setattr(api, 'json_request', lambda *args, **kwargs: calls.append(kwargs) or {'result': {}})
    api.RebuttalStore._bridge('analyze', {}, job_id='test')
    assert calls == [{'timeout': 140}]


def test_response_history_is_scoped_deduplicated_and_persistent(api, domain, monkeypatch):
    monkeypatch.delenv('BACKUP_URL', raising=False)
    store, round_id, _ = domain
    first = document(store, round_id)
    second = document(store, round_id)
    before = store.state('paper')['revision']
    store.save_response_version('paper', round_id, first, {'content': 'first'}, 'Dae')
    store.save_response_version('paper', round_id, first, {'content': 'first'}, 'Dae')
    store.save_response_version('paper', round_id, first, {'content': 'second', 'reason': 'pre-restore'}, 'Dae')
    store.save_response_version('paper', round_id, second, {'content': 'other'}, 'Dae')
    reopened = api.RebuttalStore(store.database_path)
    assert [v['content'] for v in reopened.response_versions('paper', round_id, first)['versions']] == ['second', 'first']
    assert [v['content'] for v in reopened.response_versions('paper', round_id, second)['versions']] == ['other']
    assert store.state('paper')['revision'] == before
    with pytest.raises(api.NotFound):
        reopened.response_versions('another-paper', round_id, first)


def test_response_history_includes_existing_paper_backup_and_missing_data(domain, monkeypatch):
    store, round_id, _ = domain
    doc = document(store, round_id)
    class BackupHandler(ThreadingHTTPServer):
        pass
    from http.server import BaseHTTPRequestHandler
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.endswith('/snapshots'):
                data = {'snapshots': [{'id': 1, 'created_at': '2026-01-01T00:00:00Z'}, {'id': 2, 'created_at': '2025-01-01T00:00:00Z'}]}
            else:
                snapshot = {'rounds': [{'id': round_id, 'documents': [{'id': doc, 'text_key': doc}]}], 'texts': {doc: 'old answer'}} if self.path.endswith('/1') else None
                data = {'snapshot': {'payload': {'rebuttal': snapshot}}}
            raw = json.dumps(data).encode()
            self.send_response(200); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
        def log_message(self, *_): pass
    server = BackupHandler(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    monkeypatch.setenv('BACKUP_URL', f'http://127.0.0.1:{server.server_port}')
    try:
        result = store.response_versions('paper', round_id, doc)
        assert [v['content'] for v in result['versions']] == ['old answer', None]
        assert result['paper_unavailable'] is False
    finally:
        server.shutdown(); server.server_close(); thread.join()


def test_partial_connection_results_preserve_existing_links(api):
    review={'id':'r1','reviewer_id':'a','fields':{'review':'One.'}}
    doc={'id':'d1','title':'Answer'}
    old={'id':'old','origin':'ai','decision':'proposed','comments':[],'source_spans':[{'review_id':'r1','field':'review','quote':'One.'}]}
    old_map={'id':'m1','concern_id':'old','origin':'ai','decision':'proposed','response_spans':[{'document_id':'d1','quote':'Answer.'}]}
    round_={'reviews':[review],'documents':[doc],'glossary':{},'active_rules_id':None,'concerns':[old],'mappings':[old_map],'findings':[],'text_hashes':{'d1':'hash'}}
    job={'id':'newjob','task':'connect','prompt_version':'rebuttal-direct-connect-v5','input_hash':'new','text_hashes':{'d1':'hash'},'payload':{'reviews':[review],'documents':[doc]},'metadata_hash':api.RebuttalStore._metadata_hash(round_),'connection_warnings':[{'omitted_links':1}],'result':{'concerns':[],'mappings':[]}}
    api.RebuttalStore._publish(round_,job)
    assert not old_map.get('superseded') and not old.get('superseded')


def test_response_translation_queues_only_selected_response_and_does_not_change_review(api, domain):
    store, round_id, _ = domain
    review = import_review(store, round_id)
    doc = document(store, round_id)
    state = store.queue('paper', round_id, {'task': 'translate_response', 'expected_revision': store.state('paper')['revision'], 'texts': {doc: 'A response.'}, 'scope': {'document_ids': [doc]}}, 'Dae')
    job_id = state['result']['job']['id']
    with store._connect() as db:
        job = json.loads(db.execute('SELECT data FROM jobs WHERE id=?', (job_id,)).fetchone()['data'])
    assert job['payload']['reviews'] == [{'id': doc, 'reviewer_id': doc, 'fields': {'response': 'A response.'}}]
    assert job['payload']['documents'] == []
    snapshot = copy.deepcopy(state['rounds'][0])
    api.RebuttalStore._publish(snapshot, {**job, 'result': {'translations': [{'review_id': review['id'], 'field': 'review', 'text': '변경되면 안 됨'}]}})
    assert not snapshot['reviews'][0]['translations']


def test_response_translation_worker_uses_incremental_light_pipeline(api, domain):
    store, round_id, _ = domain
    doc = document(store, round_id)
    def bridge(task, payload, profile=None, job_id=None):
        assert task == 'translate_block'
        assert profile == 'rebuttal-translation-light'
        return {'text': '실험을 추가했습니다.'}
    store.bridge = bridge
    state = store.queue('paper', round_id, {'task': 'translate_response', 'expected_revision': store.state('paper')['revision'], 'texts': {doc: 'We added an experiment.'}, 'scope': {'document_ids': [doc]}}, 'Dae')
    job_id = state['result']['job']['id']
    store.start()
    try:
        end = time.monotonic() + 5
        while time.monotonic() < end:
            job = next(j for j in store.state('paper')['jobs'] if j['id'] == job_id)
            if job['status'] in {'completed', 'failed'}:
                break
            time.sleep(.02)
        assert job['status'] == 'completed', job.get('error')
        assert job['result']['translations'][0]['text'] == '실험을 추가했습니다.'
    finally:
        store.close()


def wait_translation(store, job_id, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = next(item for item in store.state('paper')['jobs'] if item['id'] == job_id)
        if job['status'] in {'completed', 'failed', 'cancelled'}:
            return job
        time.sleep(.01)
    pytest.fail('translation job did not finish')


def queue_response_translation(store, round_id, doc, source):
    return store.queue('paper', round_id, {'task': 'translate_response', 'texts': {doc: source},
        'scope': {'document_ids': [doc]}, 'expected_revision': store.state('paper')['revision']}, 'Dae')['result']['job']


def test_translation_worker_reports_protected_content_failure_without_private_text(api, domain):
    store, round_id, _ = domain
    doc = document(store, round_id)
    store.bridge = lambda *args: {'text': '이 수식은 $x=2$입니다. PRIVATE_TOKEN'}
    job = queue_response_translation(store, round_id, doc, 'This formula is $x=1$.')
    store.start()
    try:
        done = wait_translation(store, job['id'])
        assert done['status'] == 'failed'
        assert done['error_code'] == 'invalid_translation_result'
        assert done['validation_details']['issue'] == 'translation_protected_content'
        assert '수식·코드 보존 오류' in done['error']
        assert 'PRIVATE_TOKEN' not in json.dumps(done)
    finally:
        store.close()


def test_translation_lane_bypasses_running_analysis_and_is_deduplicated(api, domain):
    store, round_id, _ = domain
    doc = document(store, round_id)
    blocked, release = threading.Event(), threading.Event()
    calls = []
    def bridge(task, payload, profile=None, job_id=None):
        calls.append(task)
        if task == 'style':
            blocked.set()
            assert release.wait(5)
            return {'findings': []}
        assert task == 'translate_block'
        return {'text': '실험을 추가했습니다.'}
    store.bridge = bridge
    store.queue('paper', round_id, {'task': 'style', 'texts': {doc: 'We added an experiment.'},
        'expected_revision': store.state('paper')['revision']}, 'Dae')
    store.start()
    try:
        assert blocked.wait(3)
        job = queue_response_translation(store, round_id, doc, 'We added an experiment.')
        done = wait_translation(store, job['id'])
        assert done['status'] == 'completed', done.get('error')
        assert not release.is_set()
        assert calls == ['style', 'translate_block']
        compact = store.job('paper', round_id, job['id'])['job']
        assert compact['source'] == 'We added an experiment.'
        assert compact['document_id'] == doc and 'payload' not in compact
        with pytest.raises(api.NotFound):
            store.job('other', round_id, job['id'])
        with pytest.raises(api.NotFound):
            store.job('paper', 'other-round', job['id'])
    finally:
        release.set()
        store.close()


def test_translation_progress_deduplication_and_changed_paragraph_reuse(api, domain):
    store, round_id, _ = domain
    doc = document(store, round_id)
    entered, release = threading.Event(), threading.Event()
    calls = []
    def bridge(task, payload, profile=None, job_id=None):
        source = payload['reviews'][0]['fields']['response']
        calls.append(source)
        if source == 'Second paragraph.':
            entered.set()
            assert release.wait(5)
        return {'text': {'First paragraph.':'첫 번째 문단입니다.', 'Second paragraph.':'두 번째 문단입니다.',
            'Changed paragraph.':'수정된 문단입니다.'}[source]}
    store.bridge = bridge
    source = 'First paragraph.\n\nSecond paragraph.'
    job = queue_response_translation(store, round_id, doc, source)
    duplicate = queue_response_translation(store, round_id, doc, source)
    assert duplicate['id'] == job['id']
    assert len(store.state('paper')['jobs']) == 1
    revision = store.state('paper')['revision']
    store.start()
    try:
        assert entered.wait(3)
        progress = store.job('paper', round_id, job['id'])['job']['translation_progress']
        assert progress['completed'] == 1 and progress['total'] == 2
        assert progress['translations'][0]['text'] == '첫 번째 문단입니다.\n\n'
        assert store.state('paper')['revision'] == revision
        release.set()
        assert wait_translation(store, job['id'])['status'] == 'completed'
        updated = queue_response_translation(store, round_id, doc, 'First paragraph.\n\nChanged paragraph.')
        done = wait_translation(store, updated['id'])
        assert done['status'] == 'completed', done.get('error')
        assert done['result']['translations'][0]['text'] == '첫 번째 문단입니다.\n\n수정된 문단입니다.'
        assert calls == ['First paragraph.', 'Second paragraph.', 'Changed paragraph.']
        assert store._translation_cache_get('other', next(iter_cache_keys(store))) is None
    finally:
        release.set()
        store.close()


def iter_cache_keys(store):
    with store._connect() as db:
        return iter([row['cache_key'] for row in db.execute('SELECT cache_key FROM translation_cache WHERE project_id=?', ('paper',))])


def test_translation_job_http_endpoint_is_scoped_and_has_no_payload(http_server):
    base, store, round_id, _ = http_server
    doc = document(store, round_id)
    job = queue_response_translation(store, round_id, doc, 'A response.')
    path = f'paper/rounds/{round_id}/analyses/{job["id"]}'
    status, result, _ = request_http(base, path, role='viewer')
    assert status == 200 and result['job']['source'] == 'A response.'
    assert 'payload' not in result['job']
    assert request_http(base, path, actor='')[0] == 403
    assert request_http(base, f'paper/rounds/other/analyses/{job["id"]}')[0] == 404
    assert request_http(base, f'unknown/rounds/{round_id}/analyses/{job["id"]}')[0] == 404


def test_translation_job_changes_etag_without_changing_metadata_revision(http_server):
    base, store, round_id, _ = http_server
    doc = document(store, round_id)
    queue_response_translation(store, round_id, doc, 'A response.')
    _, before, headers = request_http(base, 'paper/state')
    store._claim('translation')
    status, after, _ = request_http(base, 'paper/state', **{'If-None-Match':headers['ETag']})
    assert status == 200 and after['revision'] == before['revision']
    assert after['jobs'][0]['status'] == 'running'


@pytest.mark.parametrize('decision', ['confirmed', 'rejected'])
def test_connection_rerun_preserves_author_decisions_and_their_concerns(api, decision):
    review={'id':'review','reviewer_id':'reviewer','fields':{'review':'Explain the experiment.'}}
    doc={'id':'response','title':'Response'}
    concern={'id':'concern','origin':'ai','decision':'proposed','superseded':True,'comments':[],
        'source_spans':[{'review_id':'review','field':'review','quote':'Explain the experiment.'}]}
    mapping={'id':'mapping','concern_id':'concern','origin':'ai','decision':decision,'superseded':True,
        'reason':'Author decision must survive','response_spans':[{'document_id':'response','quote':'We added the experiment.'}]}
    round_={'reviews':[review],'documents':[doc],'glossary':{},'active_rules_id':None,
        'concerns':[concern],'mappings':[mapping],'findings':[],'text_hashes':{'response':'hash'}}
    job={'id':'rerun','task':'connect','prompt_version':'rebuttal-direct-connect-v9','input_hash':'new',
        'text_hashes':{'response':'hash'},'payload':{'reviews':[review],'documents':[doc]},
        'metadata_hash':api.RebuttalStore._metadata_hash(round_),'result':{'concerns':[],'mappings':[]}}
    api.RebuttalStore._publish(round_,job)
    assert mapping['decision']==decision and mapping['reason']=='Author decision must survive'
    assert not mapping.get('superseded') and not concern.get('superseded')


def test_restore_publishes_immutable_korean_seed_before_collaboration_initialization(api, domain):
    store, round_id, _=domain
    doc=document(store,round_id)
    saved=store.snapshot('paper');saved['texts']={doc:'English response.'}
    saved['koreanResponses']={doc:{'text':'직접 다듬은 한국어 초안',
        'meta':{'source':'English response.','translation':'기계 번역 초안','glossary':{},'segments':[]}}}
    restored=store.restore('paper',{'snapshot':saved,'expected_revision':store.state('paper')['revision']},'Dae')
    new_doc=restored['rounds'][-1]['documents'][0]
    assert new_doc['id']!=doc and new_doc['korean_seed']==saved['koreanResponses'][doc]
    assert store.state('paper')['rounds'][-1]['documents'][0]['korean_seed']==saved['koreanResponses'][doc]
    changed=copy.deepcopy(restored['rounds'][-1]);changed['documents'][0]['title']='Renamed'
    changed['documents'][0].pop('korean_seed')
    state=store.update_round('paper',changed['id'],{'round':changed,'texts':{new_doc['id']:'English response.'},
        'expected_revision':store.state('paper')['revision']},'Dae')
    assert state['rounds'][-1]['documents'][0]['korean_seed']==saved['koreanResponses'][doc]
    changed=copy.deepcopy(state['rounds'][-1]);changed['documents'][0]['korean_seed']['text']='Forged'
    with pytest.raises(api.ValidationError,match='Korean seed is immutable'):
        store.update_round('paper',changed['id'],{'round':changed,'texts':{new_doc['id']:'English response.'},
            'expected_revision':store.state('paper')['revision']},'Dae')
    # A second restore uses the actual live backup, not provenance copied from the document.
    again={'schema_version':1,'rounds':[state['rounds'][-1]],'texts':{new_doc['id']:'English response.'}}
    second=store.restore('paper',{'snapshot':again,'expected_revision':store.state('paper')['revision']},'Dae')
    assert 'korean_seed' not in second['rounds'][-1]['documents'][0]


def test_partial_connection_fallback_preserves_previous_proposals(api):
    review={'id':'r','reviewer_id':'a','fields':{'review':'Question.'}}
    doc={'id':'d','title':'Answer'}
    concern={'id':'c','origin':'ai','comments':[],'source_spans':[{'review_id':'r','field':'review','quote':'Question.'}]}
    mapping={'id':'m','concern_id':'c','origin':'ai','decision':'proposed','response_spans':[{'document_id':'d','quote':'Answer.'}]}
    round_={'reviews':[review],'documents':[doc],'glossary':{},'active_rules_id':None,'concerns':[concern],
        'mappings':[mapping],'findings':[],'text_hashes':{'d':'hash'}}
    job={'id':'partial','task':'connect','prompt_version':'rebuttal-direct-connect-v9','input_hash':'new',
        'text_hashes':{'d':'hash'},'payload':{'reviews':[review],'documents':[doc]},
        'metadata_hash':api.RebuttalStore._metadata_hash(round_),
        'connection_warnings':[{'omitted_links':0,'contextual_links':1}], 'result':{'concerns':[],'mappings':[]}}
    api.RebuttalStore._publish(round_,job)
    assert not mapping.get('superseded') and not concern.get('superseded')


def test_cached_partial_connection_preserves_warning_diagnostics_and_prior_links(domain):
    store, round_id, _=domain
    review=import_review(store,round_id,'Please explain.')
    doc=document(store,round_id,kind='common')
    round_=copy.deepcopy(store.state('paper')['rounds'][0])
    round_['concerns']=[{'id':'prior-concern','title':'Explain','origin':'ai','reviewer_id':review['reviewer_id'],
        'source_spans':[{'review_id':review['id'],'field':'review','quote':'Please explain.'}], 'strategy':'clarify','comments':[]}]
    round_['mappings']=[{'id':'prior-link','concern_id':'prior-concern','origin':'ai','decision':'proposed',
        'coverage':'related','response_spans':[{'document_id':doc,'quote':'We explain.'}]}]
    store.update_round('paper',round_id,{'round':round_,'texts':{doc:'We explain.'},
        'expected_revision':store.state('paper')['revision']},'Dae')
    def queue():
        return store.queue('paper',round_id,{'task':'connect','texts':{doc:'We explain.'},
            'scope':{'review_ids':[review['id']],'document_ids':[doc]},
            'expected_revision':store.state('paper')['revision']},'Dae')['result']['job']
    first=queue();store._claim('analysis')
    warnings=[{'stage':'direct_connect','omitted_links':0,'contextual_links':1}]
    diagnostics=[{'stage':'direct_connect','type':'contextual_candidate'}]
    store._job_update('paper',first['id'],{'status':'completed','stage':'completed','result':{'concerns':[],'mappings':[]},
        'connection_warnings':warnings,'connection_diagnostics':diagnostics},publish=True)
    cached=queue()
    assert cached['stage']=='cached' and cached['cached_from']==first['id']
    assert cached['connection_warnings']==warnings and cached['connection_diagnostics']==diagnostics
    assert cached['prompt_version']=='rebuttal-direct-connect-v10'
    current=store.state('paper')['rounds'][0]
    assert not current['mappings'][0].get('superseded') and not current['concerns'][0].get('superseded')


def test_workers_recover_from_claim_and_failure_update_locks(domain, monkeypatch):
    import sqlite3

    store, round_id, _ = domain
    doc = document(store, round_id)
    revision = store.state('paper')['revision']
    failed = store.queue('paper', round_id, {'task': 'style', 'texts': {doc: 'Answer.'}, 'expected_revision': revision}, 'Dae')
    later = store.queue('paper', round_id, {'task': 'simulate', 'texts': {doc: 'Answer.'}, 'expected_revision': failed['revision']}, 'Dae')
    failed_id, later_id = (state['result']['job']['id'] for state in (failed, later))
    claim, update = store._claim, store._job_update
    claim_locked = threading.Event()
    update_locked = threading.Event()

    def flaky_claim(lane):
        if lane == 'analysis' and not claim_locked.is_set():
            claim_locked.set()
            raise sqlite3.OperationalError('database is locked')
        return claim(lane)

    def flaky_update(project, job_id, values, **kwargs):
        if values.get('status') == 'failed' and not update_locked.is_set():
            update_locked.set()
            raise sqlite3.OperationalError('database is locked')
        return update(project, job_id, values, **kwargs)

    def bridge(task, *_):
        if task == 'style':
            raise RuntimeError('simulated model failure')
        return {}

    monkeypatch.setattr(store, '_claim', flaky_claim)
    monkeypatch.setattr(store, '_job_update', flaky_update)
    store.bridge = bridge
    store.start()
    try:
        assert wait_translation(store, failed_id)['status'] == 'failed'
        assert wait_translation(store, later_id)['status'] == 'completed'
        assert claim_locked.is_set() and update_locked.is_set()
        assert store.workers_alive()
    finally:
        store.close()


def test_health_reports_unavailable_when_one_worker_exits(http_server, monkeypatch):
    base, store, _, _ = http_server
    exit_translation = threading.Event()
    run = store._work

    def worker(lane='analysis'):
        if lane == 'translation':
            exit_translation.wait(3)
        else:
            run(lane)

    monkeypatch.setattr(store, '_work', worker)
    store.start()
    try:
        with urllib.request.urlopen(base + '/health', timeout=3) as response:
            assert response.status == 200
        exit_translation.set()
        store._translation_worker.join(2)
        assert store._worker.is_alive()
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(base + '/health', timeout=3)
        assert error.value.code == 503
        assert json.load(error.value)['status'] == 'unhealthy'
    finally:
        exit_translation.set()
        store.close()


def test_delayed_remote_cancel_keeps_retry_attempt_distinct(api, domain, monkeypatch):
    store, round_id, _ = domain
    doc = document(store, round_id)
    cancel_started = threading.Event()
    release_cancel = threading.Event()
    remote = []
    results = []

    def request(url, payload, token, **kwargs):
        remote.append(payload)
        if url.endswith('/cancel'):
            cancel_started.set()
            if not release_cancel.wait(3):
                raise RuntimeError('cancel synchronization timed out')
            return {'cancelled': payload['attempt'] == remote[-1]['attempt']}
        return {'result': {}}

    monkeypatch.setattr(api, 'json_request', request)
    queued = store.queue('paper', round_id, {'task': 'style', 'texts': {doc: 'Answer.'}, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    job_id = queued['result']['job']['id']
    store._claim()
    def cancel():
        results.append(store.job_action('paper', round_id, job_id, {'expected_revision': queued['revision']}, 'cancel'))

    cancelling = threading.Thread(target=cancel)
    cancelling.start()
    try:
        assert cancel_started.wait(2)
        retried = store.job_action('paper', round_id, job_id, {'expected_revision': store.state('paper')['revision']}, 'retry')
        _, _, job = store._claim()
        assert job['attempt'] == retried['result']['job']['attempt'] == 2
        store._run_job('paper', job)
        assert store.job('paper', round_id, job_id)['job']['status'] == 'completed'
    finally:
        release_cancel.set()
        cancelling.join(3)
    assert results[0]['result']['job']['attempt'] == 1
    assert remote[0] == {'job_id': job_id, 'attempt': 1}
    assert remote[1]['job_id'] == job_id
    assert remote[1]['attempt'] == 2


def test_job_progress_and_completed_cancel_keep_project_revision(domain, monkeypatch):
    store, round_id, _ = domain
    queued = store.queue('paper', round_id, {'task': 'style', 'texts': {}, 'expected_revision': store.state('paper')['revision']}, 'Dae')
    job_id = queued['result']['job']['id']
    store._claim()
    store._job_update('paper', job_id, {'stage': 'validating'}, expected_attempt=1)
    assert store.job('paper', round_id, job_id)['job']['stage'] == 'validating'
    assert store.state('paper')['revision'] == queued['revision']
    imported = store.stage_import('paper', round_id, {'kind': 'text', 'text': 'Review', 'expected_revision': queued['revision']})
    store._job_update('paper', job_id, {'status': 'completed', 'stage': 'completed', 'result': {}}, publish=True, expected_attempt=1)
    calls = []
    monkeypatch.setattr(store, '_request', lambda *args: calls.append(args))
    cancelled = store.job_action('paper', round_id, job_id, {'expected_revision': imported['revision']}, 'cancel')
    assert cancelled['revision'] == imported['revision']
    assert cancelled['result']['job']['status'] == 'completed'
    assert calls == []


def pdf_payload(revision):
    return {'kind': 'pdf', 'data_base64': base64.b64encode(b'%PDF-staged').decode(), 'expected_revision': revision}


@pytest.mark.parametrize('reason', ['conflict', 'import_limit', 'project_quota'])
def test_rejected_pdf_does_not_leave_asset(api, domain, monkeypatch, reason):
    import sys

    store, round_id, assets = domain
    compiler = store.compiler
    if reason == 'conflict':
        def advance_revision(path, payload):
            store.mutate('paper', store.state('paper')['revision'], lambda *_: None)
            return compiler(path, payload)
        monkeypatch.setattr(store, 'compiler', advance_revision)
        error = api.Conflict
    else:
        if reason == 'import_limit':
            store.mutate('paper', store.state('paper')['revision'],
                         lambda state, _: state['rounds'][0].update(imports=[{}] * 200))
        else:
            store_module = sys.modules[api.RebuttalStore.__base__.__module__]
            monkeypatch.setattr(store_module, 'MAX_STATE_BYTES', 1)
        error = api.ValidationError
    with pytest.raises(error):
        store.stage_import('paper', round_id, pdf_payload(store.state('paper')['revision']))
    assert assets == {}


def test_pdf_write_failure_cleans_partial_file_without_deleting_shared_asset(api, domain, monkeypatch):
    store, round_id, assets = domain
    writer = store.asset_write

    def partial_write(*args):
        writer(*args)
        raise api.ValidationError('simulated storage failure after write')

    monkeypatch.setattr(store, 'asset_delete', lambda project, path, actor: assets.pop((project, path)))
    revision = store.state('paper')['revision']
    monkeypatch.setattr(store, 'asset_write', partial_write)
    with pytest.raises(api.ValidationError):
        store.stage_import('paper', round_id, pdf_payload(revision))
    assert assets == {}
    assert store.state('paper')['revision'] == revision
    monkeypatch.setattr(store, 'asset_write', writer)
    staged = store.stage_import('paper', round_id, pdf_payload(revision))
    monkeypatch.setattr(store, 'asset_write', partial_write)
    with pytest.raises(api.ValidationError):
        store.stage_import('paper', round_id, pdf_payload(staged['revision']))
    assert len(assets) == 1
    assert len(store.state('paper')['rounds'][0]['imports']) == 1


def test_restore_idempotency_replays_original_ids_after_restart(api, domain):
    store, round_id, _ = domain
    doc = document(store, round_id)
    snapshot = store.snapshot('paper')
    snapshot['texts'][doc] = 'Saved response'
    body = {'snapshot': snapshot, 'idempotency_key': 'restore-operation-1', 'expected_revision': snapshot['revision']}
    restored = store.restore('paper', body, 'Dae')
    reopened = api.RebuttalStore(store.database_path)
    replayed = reopened.restore('paper', body, 'Dae')
    assert restored == replayed
    assert len(replayed['rounds']) == 2
    assert replayed['result']['texts'] == {restored['result']['id_map'][doc]: 'Saved response'}
    with pytest.raises(api.ValidationError, match='different snapshot'):
        reopened.restore('paper', {**body, 'snapshot': {**snapshot, 'texts': {}}}, 'Dae')


def test_utf16_offsets_match_overlapping_quotes(api):
    assert api.utf16_offsets('aaa', 'aa', 1) == (1, 3)
    assert api.utf16_offsets('😀aaa', 'aa', 3) == (3, 5)
    with pytest.raises(api.ValidationError, match='ambiguous'):
        api.utf16_offsets('aaa', 'aa')


def test_stale_translation_never_publishes_to_changed_review(domain):
    store, round_id, _ = domain
    review = import_review(store, round_id, 'Original review.')
    state = store.state('paper')
    queued = store.queue('paper', round_id, {'task': 'translate', 'texts': {}, 'expected_revision': state['revision']}, 'Dae')
    job_id = queued['result']['job']['id']
    store._claim('translation')

    def change_source(state, _db):
        state['rounds'][0]['reviews'][0]['fields']['review'] = 'Edited review.'

    edited = store.mutate('paper', queued['revision'], change_source)
    translation = {'review_id': review['id'], 'field': 'review', 'text': '원본 리뷰입니다.'}
    store._job_update('paper', job_id, {'status': 'completed', 'result': {'translations': [translation]}},
                      publish=True, expected_attempt=1)
    current = store.state('paper')
    updated_review = current['rounds'][0]['reviews'][0]
    assert current['jobs'][0]['stale'] is True
    assert current['revision'] == edited['revision']
    assert updated_review == edited['rounds'][0]['reviews'][0]
