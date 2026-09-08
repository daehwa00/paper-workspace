import { expect, test } from './fixtures.js'

test('large required manifests load all sources within six concurrent requests', async ({ page }) => {
  const slug = `bootstrap-load-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const main = '\\documentclass{article}\n\\begin{document}bounded bootstrap\\end{document}\n'
  const paths = ['main.tex', ...Array.from({ length: 42 }, (_, index) => `sections/part-${String(index + 1).padStart(2, '0')}.tex`)]
  const sources = Object.fromEntries(paths.map(path => [path, path === 'main.tex' ? main : `% source ${path}\n`]))
  const requested = new Set()
  let inFlight = 0
  let maxInFlight = 0
  let rejected = 0

  await page.route('**/api/compile', route => route.fulfill({ status: 503, json: { error: 'Compile is not part of the bootstrap load fixture.' } }))
  await page.route(`**/p/${slug}/project/**`, async route => {
    const path = new URL(route.request().url()).pathname.split(`/p/${slug}/project/`)[1]
    if (path === 'project.json') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ id: slug, version: '1', entrypoint: 'main.tex', files: paths.map(path => ({ path, managed: true })) })
      })
    }
    if (!(path in sources)) return route.fulfill({ status: 404, body: '' })

    requested.add(path)
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    if (inFlight > 6) {
      rejected += 1
      inFlight -= 1
      return route.fulfill({ status: 503, body: 'too many simultaneous source requests' })
    }
    try {
      await new Promise(resolve => setTimeout(resolve, 25))
      return route.fulfill({ contentType: 'text/plain', body: sources[path] })
    } finally {
      inFlight -= 1
    }
  })

  await page.goto(`/p/${slug}?lang=en`)
  await page.waitForFunction(requiredPaths => projectBootstrapComplete && workspaceReadyForCompile && requiredPaths.every(path => typeof state.files[`paper/${path}`] === 'string'), paths)

  await expect(page.locator('#editor')).toHaveValue(main)
  expect(rejected).toBe(0)
  expect(maxInFlight).toBe(6)
  expect([...requested].sort()).toEqual([...paths].sort())
  expect(await page.evaluate(requiredPaths => Object.fromEntries(requiredPaths.map(path => [path, state.files[`paper/${path}`]])), paths)).toEqual(sources)
})
