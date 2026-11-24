import { expect, test } from './fixtures.js'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const makeState = () => ({schema_version: 1, revision: 1, enabled: true, jobs: [], rounds: [{
  id: 'r1', title: 'Review round', reviewers: [{id: 'a', name: 'Reviewer A'}, {id: 'b', name: 'Reviewer B'}],
  reviews: [{id: 'ra', reviewer_id: 'a', fields: {review: 'Please clarify.'}, translations: {}}, {id: 'rb', reviewer_id: 'b', fields: {review: 'Please compare.'}, translations: {}}],
  documents: [
    {id: 'doc1', text_key: 'doc1', title: 'Response A', kind: 'reviewer', reviewer_id: 'a', seed_text: 'Current English A.'},
    {id: 'doc2', text_key: 'doc2', title: 'Response B', kind: 'reviewer', reviewer_id: 'b', seed_text: 'Current English B.'},
    {id: 'common', text_key: 'common', title: 'Common response', kind: 'common', reviewer_id: null, seed_text: 'Current common response.'}
  ], imports: [], concerns: [], mappings: [], findings: [], evidence: [], work_items: [], rules: [], active_rules_id: null, analyses: [], submissions: [], glossary: {baseline: '기준선'}
}]})

async function setup(page, context, {holdReady = false, viewer = false, state = makeState(), screen = 'submission'} = {}) {
  const calls = [], slug = `submission-integrity-${Date.now()}-${Math.random().toString(36).slice(2)}`
  if (viewer) await context.route('**/_auth/context.js', route => route.fulfill({contentType: 'text/javascript', body: `window.PaperAccess={projects:{${JSON.stringify(slug)}:'viewer'}};`}))
  if (holdReady) await context.route('**/vendor/paper-collab.js*', async route => {
    const response = await route.fetch()
    await route.fulfill({response, body: `${await response.text()}\n;{const create=PaperCollab.createSession;window.PaperCollab={...PaperCollab,createSession(options){const session=create(options);window.integrityInitialReady=session.whenReady;return {...session,whenReady:session.whenReady.then(()=>new Promise(resolve=>window.releaseInitialSession=resolve))};}};}`})
  })
  await context.route('**/api/rebuttal/projects/**', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON() || {}
    calls.push({path, body, method: route.request().method()})
    if (path.endsWith('/versions')) return route.fulfill({json: {versions: [], saved: true}})
    if (route.request().method() === 'GET') return route.fulfill({json: state})
    if (path.endsWith('/exports')) return route.fulfill({json: {...state, result: {filename: 'responses.txt', mime: 'text/plain;charset=utf-8', content: body.target.document_ids.map(id => body.texts[id]).join('\n\n')}}})
    if (path.endsWith('/submissions')) {
      state.rounds[0].submissions.push({id: 'snapshot1', target: body.target, texts: body.texts})
      state.revision++
    }
    return route.fulfill({json: state})
  })
  await page.goto(`/p/${slug}/rebuttal?standalone=1&round=r1&lang=en#${screen}`)
  await expect(page.locator('#screen-nav')).toBeVisible()
  await page.waitForFunction(() => Boolean(window.PaperRebuttalSession))
  if (holdReady) await page.waitForFunction(() => typeof window.releaseInitialSession === 'function')
  else {
    await page.evaluate(() => window.PaperRebuttalSession.whenReady)
    if (!viewer && screen === 'submission') await expect(page.locator('#freeze-submission')).toBeEnabled()
    else await expect(page.locator('#response-editor .cm-content')).toContainText('Current English A.')
  }
  return {state, calls, exports: () => calls.filter(call => call.path.endsWith('/exports')), submissions: () => calls.filter(call => call.path.endsWith('/submissions'))}
}

async function koreanDrafts(page, {manual = false} = {}) {
  await page.evaluate(async manual => {
    const session = window.PaperRebuttalSession, round = window.PaperRebuttal.getState().rounds[0]
    await session.ensureNamespacedTexts('rebuttalResponses', round.documents.map(doc => ({key: `ko:${doc.id}`, initial: `한국어 ${doc.id}`})))
    if (!manual) for (const doc of round.documents) session.mapFor('rebuttalKoreanMeta').set(doc.id, {source: session.mapFor('rebuttalResponses').get(doc.text_key).toString(), translation: `한국어 ${doc.id}`, glossary: round.glossary})
  }, manual)
  await page.locator('[name=export-language]').selectOption('ko', {force: true})
}

test('initial synchronization blocks export, freeze, archive and backup reads instead of exporting seeds', async ({page, context}) => {
  const mock = await setup(page, context, {holdReady: true})
  await expect(page.locator('#freeze-submission')).toBeDisabled()
  await page.locator('[data-action=export]').click()
  await expect(page.locator('#notice')).toContainText('Response text is still loading')
  expect(mock.exports()).toHaveLength(0)
  await page.evaluate(() => { location.hash = 'overview' })
  await page.locator('[data-action=archive-export]').click()
  await expect(page.locator('#notice')).toContainText('Response text is still loading')
  await expect(page.locator('#form-dialog')).not.toBeVisible()
  await page.locator('[data-action=backup]').click()
  await expect(page.locator('#notice')).toContainText('Response text is still loading')
  expect(mock.calls.filter(call => call.path.endsWith('/snapshot'))).toHaveLength(0)
  await page.evaluate(() => window.releaseInitialSession())
})

test('viewer provisional responses cannot substitute for missing shared Y.Text values', async ({page, context}) => {
  const mock = await setup(page, context, {viewer: true, screen: 'reviews'})
  expect(await page.evaluate(() => window.PaperRebuttalSession.mapFor('rebuttalResponses').size)).toBe(0)
  await page.evaluate(() => { location.hash = 'submission' })
  await page.locator('[data-action=export]').click()
  await expect(page.locator('#notice')).toContainText('Response text is still loading')
  expect(mock.exports()).toHaveLength(0)
})

test('an initialized response exports its current local text during a temporary disconnect', async ({page, context}) => {
  const mock = await setup(page, context)
  await page.evaluate(() => {
    const session = window.PaperRebuttalSession, text = session.mapFor('rebuttalResponses').get('doc1')
    session.provider.disconnect()
    text.delete(0, text.length); text.insert(0, 'Unsynced local response.')
  })
  const download = page.waitForEvent('download')
  await page.locator('[data-action=export]').click()
  await download
  expect(mock.exports().at(-1).body.texts.doc1).toBe('Unsynced local response.')
  expect(mock.exports().at(-1).body.target).toEqual({document_ids: ['doc1', 'doc2', 'common'], common_mode: 'include'})
})

test('Korean export checks implicit common translations and glossary while preserving user edits', async ({page, context}) => {
  const mock = await setup(page, context)
  await koreanDrafts(page)
  await page.locator('[data-target=common]').uncheck()
  await page.evaluate(() => {
    const session = window.PaperRebuttalSession, meta = session.mapFor('rebuttalKoreanMeta'), text = session.mapFor('rebuttalResponses').get('ko:doc1')
    text.insert(text.length, ' 직접 수정')
    meta.set('common', {...meta.get('common'), source: 'Outdated English common.'})
  })
  await page.locator('[data-action=export]').click()
  await expect(page.locator('#notice')).toContainText('A Korean translation is outdated')
  expect(mock.exports()).toHaveLength(0)
  await page.evaluate(() => {
    const session = window.PaperRebuttalSession, meta = session.mapFor('rebuttalKoreanMeta')
    meta.set('common', {...meta.get('common'), source: session.mapFor('rebuttalResponses').get('common').toString(), glossary: {baseline: '이전 용어'}})
  })
  await page.locator('[data-action=export]').click()
  await expect(page.locator('#notice')).toContainText('A Korean translation is outdated')
  expect(mock.exports()).toHaveLength(0)
  await page.evaluate(() => {
    const session = window.PaperRebuttalSession, meta = session.mapFor('rebuttalKoreanMeta')
    meta.set('common', {...meta.get('common'), glossary: window.PaperRebuttal.getState().rounds[0].glossary})
  })
  const download = page.waitForEvent('download')
  await page.locator('[data-action=export]').click()
  await download
  expect(mock.exports().at(-1).body.texts).toEqual({doc1: '한국어 doc1 직접 수정', doc2: '한국어 doc2', common: '한국어 common'})
})

test('manual Korean drafts require explicit confirmation before exporting', async ({page, context}) => {
  const mock = await setup(page, context)
  await koreanDrafts(page, {manual: true})
  await page.locator('[data-action=export]').click()
  await expect(page.locator('#dialog-title')).toHaveText('Confirm manual Korean drafts')
  await expect(page.locator('#dialog-body')).toContainText('Common response')
  expect(mock.exports()).toHaveLength(0)
  const download = page.waitForEvent('download')
  await page.locator('#dialog-save').click()
  await download
  expect(mock.exports().at(-1).body.texts.common).toBe('한국어 common')
})

test('machine Korean drafts require a glossary snapshot even when the current glossary is empty', async ({page, context}) => {
  const state = makeState(); state.rounds[0].glossary = {}
  const mock = await setup(page, context, {state})
  await koreanDrafts(page)
  await page.evaluate(() => {
    const map = window.PaperRebuttalSession.mapFor('rebuttalKoreanMeta'), {glossary, ...meta} = map.get('common')
    map.set('common', meta)
  })
  await page.locator('[data-action=export]').click()
  await expect(page.locator('#notice')).toContainText('A Korean translation is outdated')
  expect(mock.exports()).toHaveLength(0)
})

test('restored legacy machine drafts without glossary records can translate again while manual drafts stay intact', async ({page, context}) => {
  const state = makeState(), round = state.rounds[0], translations = []
  round.glossary = {}
  round.documents[0].korean_seed = {text: '예전 기계번역', meta: {source: round.documents[0].seed_text, translation: '예전 기계번역'}}
  round.documents[1].korean_seed = {text: '직접 작성한 한국어', meta: null}
  await setup(page, context, {state})
  await context.route('**/api/rebuttal/projects/**/analyses', async route => {
    const body = route.request().postDataJSON()
    translations.push(body)
    const job = {id: 'legacy-translation', round_id: 'r1', task: 'translate_response', status: 'completed', result: {translations: [{review_id: 'doc1', field: 'response', text: '최신 기계번역', segments: [{source: body.texts.doc1, text: '최신 기계번역'}]}]}}
    state.jobs = [job]; state.revision++
    await route.fulfill({json: {...state, result: {job}}})
  })
  await page.evaluate(() => { location.hash = 'reviews' })
  await page.locator('[data-answer-language=ko]').click()
  await expect(page.locator('[data-ko-text]')).toHaveText('최신 기계번역')
  expect(translations).toHaveLength(1)
  expect(await page.evaluate(() => window.PaperRebuttalSession.mapFor('rebuttalKoreanMeta').get('doc1').glossary)).toEqual({})
  await page.locator('[data-action=open-review][data-id=b]').click()
  await expect(page.locator('[data-ko-text]')).toHaveText('직접 작성한 한국어')
  await expect(page.locator('[data-action=translate-response-ko]')).toBeVisible()
  expect(translations).toHaveLength(1)
  expect(await page.evaluate(() => window.PaperRebuttalSession.mapFor('rebuttalKoreanMeta').has('doc2'))).toBe(false)
})

for (const change of ['documents', 'rules', 'body']) test(`freeze asks for review again when ${change} change during confirmation`, async ({page, context}) => {
  const mock = await setup(page, context)
  await page.locator('#freeze-submission').click()
  if (change === 'documents') {
    mock.state.rounds[0].documents.push({id: 'new-common', text_key: 'new-common', title: 'New common', kind: 'common', seed_text: 'Must not appear silently.'})
    mock.state.revision++
    await page.evaluate(() => window.PaperRebuttal.refresh())
  } else if (change === 'rules') {
    mock.state.rounds[0].rules.push({id: 'new-rule', venue: 'New venue', limits: []})
    mock.state.rounds[0].active_rules_id = 'new-rule'; mock.state.revision++
    await page.evaluate(() => window.PaperRebuttal.refresh())
  } else await page.evaluate(() => window.PaperRebuttalSession.mapFor('rebuttalResponses').get('doc1').insert(0, 'Changed while confirming. '))
  await page.locator('#dialog-save').click()
  await expect(page.locator('#dialog-error')).toContainText('Close this dialog and review the submission again')
  expect(mock.submissions()).toHaveLength(0)
})

test('freeze sends the captured common-first document order with automatic expansion disabled', async ({page, context}) => {
  const mock = await setup(page, context)
  await page.locator('[data-target=common]').uncheck()
  await page.locator('[name=common-mode]').selectOption('prepend', {force: true})
  await page.locator('#freeze-submission').click()
  await page.locator('#dialog-save').click()
  await expect(page.locator('#form-dialog')).not.toBeVisible()
  expect(mock.submissions()).toHaveLength(1)
  expect(mock.submissions()[0].body.target.document_ids).toEqual(['common', 'doc1', 'doc2'])
  expect(mock.submissions()[0].body.target.common_mode).toBe('include')
  expect(mock.submissions()[0].body.texts.common).toBe('Current common response.')
})

test('total rules keep all validation texts while partial export and freeze output only selected documents', async ({page, context}) => {
  const state = makeState(), round = state.rounds[0]
  round.rules = [{id: 'total-rule', limits: [{unit: 'characters', scope: 'total', max: 1000}]}]
  round.active_rules_id = 'total-rule'
  const mock = await setup(page, context, {state})
  await page.locator('[data-target=doc2]').uncheck()
  await page.locator('[data-target=common]').uncheck()
  await page.locator('[name=common-mode]').selectOption('exclude', {force: true})
  const download = page.waitForEvent('download')
  await page.locator('[data-action=export]').click()
  await download
  await expect(page.locator('#export-preview')).toHaveText('Current English A.')
  await page.locator('#freeze-submission').click()
  await page.locator('#dialog-save').click()
  await expect(page.locator('#form-dialog')).not.toBeVisible()
  expect(mock.exports()).toHaveLength(1)
  expect(mock.submissions()).toHaveLength(1)
  for (const {body} of [...mock.exports(), ...mock.submissions()]) {
    expect(body.target.document_ids).toEqual(['doc1'])
    expect(body.target.common_mode).toBe('include')
    expect(body.texts).toEqual(Object.fromEntries(round.documents.map(doc => [doc.id, doc.seed_text])))
    // Exercise the real backend assembler with the browser's captured payload.
    const output = JSON.parse(execFileSync('python3', ['-c', 'import json,sys\nfrom apps.paper_workspace.rebuttal.exports import assemble\nvalue=json.load(sys.stdin)\nprint(json.dumps(assemble(value["round"],value["payload"],None)))'], {
      cwd: resolve(import.meta.dirname, '../../../..'), input: JSON.stringify({round, payload: body}), encoding: 'utf8'
    }))
    expect(output.text).toBe('Current English A.')
    expect(output.checks[0].count).toBe(round.documents.map(doc => doc.seed_text).join('\n\n').length)
    expect(output.checks[0].passed).toBe(true)
  }
})

test('total rules block partial export and freeze when an unselected shared response is unavailable', async ({page, context}) => {
  const state = makeState(), round = state.rounds[0]
  round.rules = [{id: 'total-rule', limits: [{unit: 'characters', scope: 'total', max: 1000}]}]
  round.active_rules_id = 'total-rule'
  const mock = await setup(page, context, {state})
  await page.evaluate(() => {
    const session = window.PaperRebuttalSession
    session.ensureNamespacedTexts = async () => { throw new Error('Fixture holds unselected response initialization') }
    session.mapFor('rebuttalResponses').delete('doc2')
  })
  await expect(page.locator('#notice')).toContainText('Fixture holds unselected response initialization')
  await page.locator('[data-target=doc2]').uncheck()
  await page.locator('[data-target=common]').uncheck()
  await page.locator('[name=common-mode]').selectOption('exclude', {force: true})
  await expect(page.locator('#freeze-submission')).toBeDisabled()
  await page.locator('[data-action=export]').click()
  await expect(page.locator('#notice')).toContainText('Response text is still loading')
  expect(mock.exports()).toHaveLength(0)
  expect(mock.submissions()).toHaveLength(0)
})

test('restored Korean seed initializes shared text and metadata without overwriting a later draft', async ({page, context}) => {
  const state = makeState(), doc = state.rounds[0].documents[0]
  doc.korean_seed = {text: '복원된 수동 수정', meta: {source: doc.seed_text, translation: '이전 번역', glossary: state.rounds[0].glossary}}
  await setup(page, context, {state})
  expect(await page.evaluate(() => {
    const session = window.PaperRebuttalSession
    return {text: session.mapFor('rebuttalResponses').get('ko:doc1')?.toString(), meta: session.mapFor('rebuttalKoreanMeta').get('doc1')}
  })).toEqual({text: doc.korean_seed.text, meta: doc.korean_seed.meta})
  await page.evaluate(() => {
    const session = window.PaperRebuttalSession, text = session.mapFor('rebuttalResponses').get('ko:doc1')
    text.insert(text.length, ' 새 편집'); session.mapFor('rebuttalKoreanMeta').delete('doc1')
  })
  await page.reload()
  await expect(page.locator('#freeze-submission')).toBeEnabled()
  expect(await page.evaluate(() => {
    const session = window.PaperRebuttalSession
    return {text: session.mapFor('rebuttalResponses').get('ko:doc1')?.toString(), meta: session.mapFor('rebuttalKoreanMeta').get('doc1')}
  })).toEqual({text: '복원된 수동 수정 새 편집', meta: undefined})
})
