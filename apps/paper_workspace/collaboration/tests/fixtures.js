import { test as base, expect } from '@playwright/test'

async function useNamedProfile(context) {
  await context.addInitScript(() => {
    if (localStorage.getItem('collab-name') === null) {
      localStorage.setItem('collab-name', 'Test Author')
      localStorage.setItem('collab-name-user-set', '1')
    }
  })
  return context
}

export async function namedContext(browser, options) {
  return useNamedProfile(await browser.newContext(options))
}

// Existing authoring workflows exercise returning users. First-visit identity
// tests import Playwright directly and exercise the required name dialog.
export const test = base.extend({
  context: async ({ context }, use) => {
    await useNamedProfile(context)
    await use(context)
  }
})
export { expect }
