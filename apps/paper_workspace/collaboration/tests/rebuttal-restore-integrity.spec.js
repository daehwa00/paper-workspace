import { test, expect, namedContext } from './fixtures.js'

const round = (id, reviewerId, reviewId, documentId, english, koreanSeed) => ({
  id, title: `Review ${id}`, reviewers: [{id: reviewerId, name: 'Reviewer A'}],
  reviews: [{id: reviewId, reviewer_id: reviewerId, fields: {review: 'Please explain the experiment.'}, translations: {}}],
  documents: [{id: documentId, text_key: documentId, kind: 'reviewer', reviewer_id: reviewerId, title: 'Response A', seed_text: english, ...(koreanSeed ? {korean_seed: koreanSeed} : {})}],
  imports: [], concerns: [], mappings: [], findings: [], evidence: [], work_items: [], rules: [],
  active_rules_id: null, analyses: [], submissions: [], glossary: {}
})

test('another browser opening a restored round before the restore reply preserves its manual Korean draft', async ({browser}) => {
  const english = 'We added the requested experiment.'
  const manualKorean = '요청하신 실험을 추가했습니다. 저자가 직접 검토하고 수정한 초안입니다.'
  const meta = {source: english, translation: '요청하신 실험을 추가했습니다.', segments: [{source: english, text: '요청하신 실험을 추가했습니다.'}], glossary: {}}
  expect(meta.translation).not.toBe(manualKorean)
  const original = round('old-round', 'old-reviewer', 'old-review', 'old-doc', english)
  const restored = round('new-round', 'new-reviewer', 'new-review', 'new-doc', english, {text: manualKorean, meta})
  const saved = {schema_version: 1, rounds: [original], texts: {'old-doc': english}, koreanResponses: {'old-doc': {text: manualKorean, meta}}}
  const state = {schema_version: 1, revision: 1, enabled: true, jobs: [], rounds: [original]}
  const idMap = {'old-round': 'new-round', 'old-reviewer': 'new-reviewer', 'old-review': 'new-review', 'old-doc': 'new-doc'}
  const slug = `restore-integrity-${Date.now()}`
  const initiatorContext = await namedContext(browser), observerContext = await namedContext(browser)
  let releaseRestore, publishRestore
  const restoreGate = new Promise(resolve => { releaseRestore = resolve })
  const published = new Promise(resolve => { publishRestore = resolve })
  const initializationRequests = [], translationRequests = []
  let restoreReleased = false
  const installMetadata = async (context, actor) => {
    context.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('response-init=1')) initializationRequests.push({actor, entries: request.postDataJSON().entries, beforeRelease: !restoreReleased})
    })
    await context.route('**/api/rebuttal/projects/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      if (path.endsWith('/versions')) return route.fulfill({json: request.method() === 'GET' ? {versions: []} : {saved: true}})
      if (path.endsWith('/snapshot')) return route.fulfill({json: {schema_version: 1, revision: state.revision, rounds: state.rounds}})
      if (request.method() === 'POST' && path.endsWith('/restore')) {
        expect(actor).toBe('initiator')
        expect(request.postDataJSON().snapshot.koreanResponses['old-doc'].text).toBe(manualKorean)
        state.rounds.push(restored); state.revision++
        const response = structuredClone({...state, result: {texts: {'new-doc': english}, id_map: idMap, round_ids: ['new-round']}})
        publishRestore()
        // Publish metadata to other browsers before delivering the restore reply.
        await restoreGate
        return route.fulfill({json: response})
      }
      if (request.method() === 'POST' && path.endsWith('/analyses')) {
        translationRequests.push({actor, body: request.postDataJSON()})
        return route.fulfill({status: 500, json: {error: 'Unexpected automatic translation'}})
      }
      return route.fulfill({json: state})
    })
  }
  try {
    await Promise.all([installMetadata(initiatorContext, 'initiator'), installMetadata(observerContext, 'observer')])
    const initiator = await initiatorContext.newPage(), observer = await observerContext.newPage()
    const open = async page => {
      await page.goto(`/p/${slug}/rebuttal?standalone=1&round=old-round&lang=en#reviews`)
      await expect(page.locator('#response-editor .cm-content')).toContainText(english)
      await page.evaluate(() => window.PaperRebuttalSession.whenReady)
    }
    await Promise.all([open(initiator), open(observer)])
    await initiator.evaluate(saved => {
      const adapter = window.PaperRebuttalBackup.create({projectSlug: window.PaperRebuttal.slug, session: window.PaperRebuttalSession})
      window.restoreOutcome = 'pending'
      window.restoreOperation = adapter.restore(saved).then(() => { window.restoreOutcome = 'completed' }, error => { window.restoreOutcome = error.message })
    }, saved)
    await published
    expect(initializationRequests.some(request => request.entries.some(entry => entry.key === 'ko:new-doc'))).toBe(false)
    await observer.evaluate(() => window.PaperRebuttal.refresh())
    await expect(observer.locator('#round-select option[value="new-round"]')).toHaveCount(1)
    await observer.locator('#round-select').selectOption('new-round', {force: true})
    await observer.locator('[data-answer-language="ko"]').click()
    await expect(observer.locator('[data-ko-text]')).toHaveText(manualKorean)
    const readDraft = page => page.evaluate(() => {
      const session = window.PaperRebuttalSession
      return {text: session.mapFor('rebuttalResponses').get('ko:new-doc')?.toString(), meta: session.mapFor('rebuttalKoreanMeta').get('new-doc')}
    })
    await expect.poll(() => readDraft(observer)).toEqual({text: manualKorean, meta})
    const firstKoreanInitialization = initializationRequests.find(request => request.entries.some(entry => entry.key === 'ko:new-doc'))
    expect(firstKoreanInitialization?.actor).toBe('observer')
    expect(firstKoreanInitialization?.beforeRelease).toBe(true)
    expect(firstKoreanInitialization.entries.find(entry => entry.key === 'ko:new-doc').initial).toBe(manualKorean)
    expect(await initiator.evaluate(() => window.restoreOutcome)).toBe('pending')
    // The shared type arrives over the real WebSocket before restore continues.
    await initiator.waitForFunction(() => window.PaperRebuttalSession.mapFor('rebuttalResponses').has('ko:new-doc'))
    await initiator.evaluate(() => { window.preRestoreKoreanText = window.PaperRebuttalSession.mapFor('rebuttalResponses').get('ko:new-doc') })
    restoreReleased = true; releaseRestore()
    await initiator.evaluate(() => window.restoreOperation)
    expect(await initiator.evaluate(() => window.restoreOutcome)).toBe('completed')
    expect(await initiator.evaluate(() => window.preRestoreKoreanText === window.PaperRebuttalSession.mapFor('rebuttalResponses').get('ko:new-doc'))).toBe(true)
    await expect.poll(() => readDraft(initiator)).toEqual({text: manualKorean, meta})
    await observer.locator('[data-answer-language="en"]').click()
    await observer.locator('[data-answer-language="ko"]').click()
    await expect(observer.locator('[data-ko-text]')).toHaveText(manualKorean)
    await expect(observer.locator('#form-dialog')).not.toBeVisible()
    expect(translationRequests).toHaveLength(0)
    expect(initializationRequests.filter(request => request.actor === 'initiator' && request.entries.some(entry => entry.key === 'ko:new-doc'))).toHaveLength(0)
  } finally {
    releaseRestore()
    await Promise.all([initiatorContext.close(), observerContext.close()])
  }
})
