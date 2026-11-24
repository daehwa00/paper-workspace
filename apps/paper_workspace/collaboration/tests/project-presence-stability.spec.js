import { expect, test } from '@playwright/test'

const peer = (id = 'bob', clientId = 20, extra = {}) => ({
  clientId, user: {id, name: 'Bob Brown', color: '#2457d6'},
  workspace: {visible: true, focused: true, editing: false, file: 'main.tex'}, ...extra
})

async function component(page, scope = 'project') {
  await page.route('**/presence-component', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/project-presence.css"></head><body><div id="host"></div><script src="/bootstrap.js"></script><script src="/project-presence.js"></script></body></html>'
  }))
  await page.goto('/presence-component')
  await page.evaluate(scope => {
    window.followed = []
    window.presence = window.PaperProjectPresence.create({
      host: document.querySelector('#host'), scope,
      describe: peer => ({label: peer.workspace?.file || '', available: peer.workspace?.available !== false}),
      onFollow: peer => window.followed.push(peer)
    })
  }, scope)
}

const update = (page, peers, extra = {}) => page.evaluate(options => window.presence.update(options), {peers, selfId: 'alice', ...extra})
const rows = page => page.locator('.project-presence-person')
const avatars = page => page.locator('.project-presence-avatars > .project-presence-avatar')
async function freezeTime(page) {
  await page.clock.install({time: new Date('2026-11-10T00:00:00Z')})
  await page.clock.pauseAt(new Date('2026-11-10T00:00:01Z'))
}

test('cursor-only updates make no DOM mutations and preserve keyboard focus and latest follow target', async ({page}) => {
  await component(page)
  await update(page, [peer()])
  await page.locator('summary').focus()
  await page.keyboard.press('ArrowDown')
  await expect(rows(page)).toBeFocused()
  await expect(page.locator('.project-presence-menu')).toBeVisible()
  // Flush the native details toggle before observing only presence updates.
  await expect(page.locator('summary')).toHaveAttribute('aria-expanded', 'true')
  const mutations = await page.evaluate(async source => {
    await new Promise(resolve => setTimeout(resolve, 0))
    window.originalRow = document.querySelector('.project-presence-person')
    window.originalAvatar = document.querySelector('.project-presence-avatars > span')
    const observer = new MutationObserver(() => {})
    observer.observe(document.querySelector('#host'), {subtree: true, childList: true, attributes: true, characterData: true})
    for (let index = 0; index < 200; index++) {
      window.presence.update({peers: [{...source, cursor: {anchor: index}, workspace: {...source.workspace, selection: index}}], selfId: 'alice'})
    }
    const records = observer.takeRecords().map(record => ({type: record.type, attribute: record.attributeName}))
    observer.disconnect()
    return records
  }, peer())
  expect(mutations).toEqual([])
  expect(await page.evaluate(() => window.originalRow === document.querySelector('.project-presence-person') && window.originalAvatar === document.querySelector('.project-presence-avatars > span'))).toBe(true)
  await expect(rows(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('summary')).toBeFocused()
  await expect(page.locator('details')).not.toHaveAttribute('open')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => window.followed.at(-1)?.cursor.anchor)).toBe(199)
  await expect(page.locator('details')).not.toHaveAttribute('open')
})

test('profile, location, activity and language changes render immediately on the existing nodes', async ({page}) => {
  await component(page)
  await update(page, [peer()])
  await page.evaluate(() => { window.originalRow = document.querySelector('.project-presence-person'); window.originalAvatar = document.querySelector('.project-presence-avatars > span') })
  await update(page, [peer('bob', 21, {
    user: {id: 'bob', name: 'Robert Jones', color: '#ffee00'},
    workspace: {visible: true, focused: true, editing: true, file: 'response:doc2', available: false}
  })], {language: 'ko'})
  expect(await page.evaluate(() => window.originalRow === document.querySelector('.project-presence-person') && window.originalAvatar === document.querySelector('.project-presence-avatars > span'))).toBe(true)
  await expect(avatars(page)).toHaveText('RJ')
  await expect(avatars(page)).toHaveAttribute('title', 'Robert Jones')
  await expect(avatars(page)).toHaveCSS('background-color', 'rgb(255, 238, 0)')
  await expect(rows(page).locator('strong')).toHaveText('Robert Jones')
  await expect(rows(page).locator('.project-presence-location')).toHaveText('response:doc2')
  await expect(rows(page).locator('.project-presence-activity')).toHaveText('편집 중')
  await expect(rows(page)).toBeDisabled()
  await expect(rows(page)).toHaveAttribute('data-client-id', '21')
  await update(page, [peer('bob', 21, {workspace: {visible: false, file: 'other.tex'}})])
  await expect(rows(page).locator('.project-presence-activity')).toHaveText('Away')
  await expect(rows(page)).toBeEnabled()
})

test('reattaching an open presence host restores the popover and keyboard focus navigation', async ({page}) => {
  await component(page, 'response')
  await update(page, [peer()])
  await page.locator('summary').focus()
  await page.keyboard.press('ArrowDown')
  await expect(rows(page)).toBeFocused()
  await expect(page.locator('.project-presence-menu')).toBeVisible()
  expect(await page.evaluate(() => {
    window.originalRow = document.querySelector('.project-presence-person')
    const host = document.querySelector('#host')
    host.remove()
    document.body.append(host)
    return {open: host.querySelector('details').open, popoverOpen: host.querySelector('[popover]').matches(':popover-open')}
  })).toEqual({open: true, popoverOpen: false})
  await update(page, [peer()])
  await expect(page.locator('.project-presence-menu')).toBeVisible()
  expect(await page.evaluate(() => document.querySelector('[popover]').matches(':popover-open') && window.originalRow === document.querySelector('.project-presence-person'))).toBe(true)
  await page.locator('summary').focus()
  await page.keyboard.press('ArrowDown')
  await expect(rows(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('summary')).toBeFocused()
  await expect(page.locator('details')).not.toHaveAttribute('open')
})

test('duplicate tabs use a stable active representative and equal-name ordering uses user identity', async ({page}) => {
  await component(page)
  const bob10 = peer('bob', 10), bob20 = peer('bob', 20)
  const cara = peer('cara', 1), self = peer('alice', 3), selfTab = {...peer('alice', 2), self: true}
  await update(page, [bob20, cara, self, bob10, selfTab])
  await expect(rows(page)).toHaveCount(2)
  await expect(avatars(page)).toHaveCount(2)
  expect(await rows(page).evaluateAll(nodes => nodes.map(node => node.dataset.clientId))).toEqual(['10', '1'])
  await page.evaluate(() => {
    window.stableRows = [...document.querySelectorAll('.project-presence-person')]
    window.stableAvatars = [...document.querySelectorAll('.project-presence-avatars > span')]
  })
  await update(page, [selfTab, bob10, self, cara, bob20])
  expect(await page.evaluate(() => window.stableRows.every((node, index) => node === document.querySelectorAll('.project-presence-person')[index]) && window.stableAvatars.every((node, index) => node === document.querySelectorAll('.project-presence-avatars > span')[index]))).toBe(true)
  await expect(rows(page).first()).toHaveAttribute('data-client-id', '10')
  const editing = peer('bob', 20, {workspace: {...bob20.workspace, editing: true}})
  await update(page, [bob10, editing, cara])
  await expect(rows(page).first()).toHaveAttribute('data-client-id', '20')
  await update(page, [bob10, bob20, cara])
  await expect(rows(page).first()).toHaveAttribute('data-client-id', '20')
  await update(page, [peer('bob', 10, {workspace: {...bob10.workspace, focused: false, editing: true}}), bob20, cara])
  await expect(rows(page).first()).toHaveAttribute('data-client-id', '20')
})

test('a reconnect within 1200ms keeps nodes while newcomers appear immediately', async ({page}) => {
  await component(page)
  await freezeTime(page)
  await update(page, [peer()])
  await page.evaluate(() => { window.originalRow = document.querySelector('.project-presence-person'); window.originalAvatar = document.querySelector('.project-presence-avatars > span') })
  await update(page, [], {connected: false})
  await page.clock.runFor(1100)
  await expect(avatars(page)).toHaveCount(1)
  await expect(page.locator('#host')).toBeVisible()
  await update(page, [peer('bob', 99), peer('cara', 40, {user: {id: 'cara', name: 'Cara', color: '#2457d6'}})])
  await expect(rows(page)).toHaveCount(2)
  expect(await page.evaluate(() => window.originalRow === document.querySelector('.project-presence-person') && window.originalAvatar === document.querySelector('.project-presence-avatars > span'))).toBe(true)
  await expect(rows(page).first()).toHaveAttribute('data-client-id', '99')
  await page.clock.runFor(1300)
  await expect(rows(page)).toHaveCount(2)
})

test('real departure expires at 1200ms without repeated updates extending the grace', async ({page}) => {
  await component(page)
  await freezeTime(page)
  await update(page, [peer()])
  await page.locator('summary').click()
  await update(page, [])
  await page.clock.runFor(600)
  await update(page, [])
  await page.clock.runFor(599)
  await expect(avatars(page)).toHaveCount(1)
  await page.clock.runFor(1)
  await expect(rows(page)).toHaveCount(0)
  await expect(avatars(page)).toHaveCount(0)
  await expect(page.locator('#host')).toBeHidden()
  await expect(page.locator('details')).not.toHaveAttribute('open')
})

test('a known response location change removes immediately and destroy clears its grace timer', async ({page}) => {
  await component(page, 'response')
  await freezeTime(page)
  await update(page, [peer()])
  await update(page, [], {allPeers: [peer('bob', 20, {workspace: {file: 'response:doc2'}})]})
  await expect(rows(page)).toHaveCount(0)
  await expect(avatars(page)).toHaveCount(0)
  await expect(page.locator('#host')).toBeHidden()
  await update(page, [peer()])
  await page.evaluate(() => {
    window.presenceTimers = new Set()
    const schedule = window.setTimeout, cancel = window.clearTimeout
    window.setTimeout = (callback, delay, ...args) => {
      const id = schedule(() => { window.presenceTimers.delete(id); callback(...args) }, delay)
      window.presenceTimers.add(id)
      return id
    }
    window.clearTimeout = id => { window.presenceTimers.delete(id); cancel(id) }
  })
  await update(page, [])
  expect(await page.evaluate(() => window.presenceTimers.size)).toBe(1)
  await page.evaluate(() => window.presence.destroy())
  expect(await page.evaluate(() => window.presenceTimers.size)).toBe(0)
  await page.clock.runFor(1300)
  await update(page, [peer()])
  await expect(page.locator('#host')).toBeEmpty()
  await expect(page.locator('#host')).toBeHidden()
})
