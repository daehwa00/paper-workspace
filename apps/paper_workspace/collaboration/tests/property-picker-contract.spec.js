import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './fixtures.js'

const output = resolve(import.meta.dirname, '../../../../.omx/artifacts/linear-refresh/property-picker-contract')
mkdirSync(output, {recursive:true})
const fields = `<label for="contract-property">Response type</label><select id="contract-property" name="type" data-property-picker tabindex="3"><option value="a">Alpha</option><option value="b">Beta</option><option value="blocked" disabled>Blocked</option><optgroup label="Read only" disabled><option value="grouped">Grouped disabled</option></optgroup><option value="c">Gamma</option></select><label id="implicit-label"><span>Evidence source</span><select name="source" data-property-picker><option value="review">Review</option><option value="paper">Paper</option></select></label><button type="button" id="contract-close">Close</button>`

async function openModal(page) {
  await page.evaluate(fields => {
    const dialog = document.createElement('dialog')
    dialog.id='contract-dialog'
    dialog.setAttribute('aria-label','Property contract')
    dialog.innerHTML=`<form>${fields}</form>`
    document.body.append(dialog)
    window.contractEvents=[]
    dialog.addEventListener('input',event=>window.contractEvents.push({event:'input',name:event.target.name,value:event.target.value}))
    dialog.addEventListener('change',event=>window.contractEvents.push({event:'change',name:event.target.name,value:event.target.value}))
    dialog.addEventListener('submit',event=>{event.preventDefault();window.contractEvents.push({event:'submit'})})
    dialog.showModal()
  },fields)
  await expect(page.locator('#contract-dialog .property-trigger')).toHaveCount(2)
  return page.locator('#contract-dialog')
}
async function menuFor(page, trigger) {
  return page.locator(`#${await trigger.getAttribute('aria-controls')}`)
}

for(const theme of ['light','dark']) for(const width of [320,1600]) test(`modal property selection preserves native forms ${theme} ${width}`,async({page})=>{
  const errors=[],llm=[]
  page.on('pageerror',error=>errors.push(error.message))
  page.on('request',request=>{if(/\/api\/(codex|rebuttal\/.*analys)/.test(request.url()))llm.push(request.url())})
  await page.setViewportSize({width,height:900})
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.addInitScript(theme=>localStorage.setItem('paper-workspace-theme',theme),theme)
  await page.goto('/hub.html?lang=en')
  const dialog=await openModal(page)
  const select=dialog.locator('#contract-property'), trigger=select.locator('..').locator('.property-trigger')
  await trigger.click()
  const menu=await menuFor(page,trigger)
  await expect(menu).toBeVisible()
  expect(await menu.evaluate(e=>e.closest('dialog')?.id)).toBe('contract-dialog')
  await expect(menu.locator('input')).toBeFocused()
  await expect(menu.getByRole('option',{name:'Blocked',exact:true})).toBeDisabled()
  await expect(menu.getByRole('option',{name:'Grouped disabled',exact:true})).toBeDisabled()
  await menu.getByRole('option',{name:'Beta',exact:true}).click()
  await expect(select).toHaveValue('b')
  await expect(trigger).toBeFocused()
  await expect(menu).toBeHidden()
  await dialog.locator('label[for="contract-property"]').click()
  await expect(menu.locator('input')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(menu.getByRole('option',{name:'Gamma',exact:true})).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(select).toHaveValue('c')
  expect(await page.evaluate(()=>window.contractEvents)).toEqual([
    {event:'input',name:'type',value:'b'},{event:'change',name:'type',value:'b'},
    {event:'input',name:'type',value:'c'},{event:'change',name:'type',value:'c'}
  ])
  expect(await dialog.locator('form').evaluate(form=>Object.fromEntries(new FormData(form)))).toEqual({type:'c',source:'review'})
  await dialog.locator('#implicit-label > span:not(.property-picker)').click()
  const implicitTrigger=dialog.locator('#implicit-label .property-trigger'), implicitMenu=await menuFor(page,implicitTrigger)
  await expect(implicitMenu).toHaveAttribute('aria-label','Evidence source')
  await implicitMenu.getByRole('option',{name:'Paper',exact:true}).click()
  expect(await dialog.locator('form').evaluate(form=>new FormData(form).get('source'))).toBe('paper')
  await trigger.click()
  await select.evaluate(e=>{e.append(new Option('Delta','d'))})
  await expect(menu.getByRole('option',{name:'Delta',exact:true})).toBeVisible()
  await menu.getByRole('option',{name:'Delta',exact:true}).click()
  await expect(select).toHaveValue('d')
  await dialog.locator('form').evaluate(e=>e.reset())
  await expect(select).toHaveValue('a')
  await expect(trigger).toHaveText('Alpha')
  await trigger.click()
  await select.evaluate(e=>{e.disabled=true})
  await expect(trigger).toBeDisabled()
  await expect(menu).toBeHidden()
  await select.evaluate(e=>{e.disabled=false})
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await page.evaluate(()=>document.fonts.ready)
  await page.screenshot({path:resolve(output,`modal-${theme}-${width}.png`),animations:'disabled'})
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await dialog.evaluate(e=>e.close())
  await expect(menu).toBeHidden()
  await expect(trigger).toHaveAttribute('aria-expanded','false')
  expect(errors).toEqual([])
  expect(llm).toEqual([])
})

test('forced colors restores native access and moves focus both ways',async({page})=>{
  await page.goto('/hub.html?lang=en')
  const dialog=await openModal(page), select=dialog.locator('#contract-property'), trigger=select.locator('..').locator('.property-trigger')
  await expect(select).toHaveAttribute('aria-hidden','true')
  await expect(select).toHaveAttribute('tabindex','-1')
  await trigger.click()
  const menu=await menuFor(page,trigger)
  await page.emulateMedia({forcedColors:'active'})
  await expect(select).not.toHaveAttribute('aria-hidden')
  await expect(select).toHaveAttribute('tabindex','3')
  await expect(select).toHaveCSS('opacity','1')
  await expect(select).toHaveCSS('appearance','auto')
  await expect(trigger).toBeHidden()
  await expect(menu).toBeHidden()
  await expect(select).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(select).toHaveValue('b')
  await page.screenshot({path:resolve(output,'forced-colors-native.png')})
  await page.emulateMedia({forcedColors:'none'})
  await expect(select).toHaveAttribute('aria-hidden','true')
  await expect(select).toHaveAttribute('tabindex','-1')
  await expect(trigger).toBeVisible()
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveText('Beta')
  await trigger.click()
  await menu.getByRole('option',{name:'Gamma',exact:true}).click()
  await expect(select).toHaveValue('c')
})

test('initial forced colors keeps the original native control accessible',async({page})=>{
  await page.emulateMedia({forcedColors:'active'})
  await page.goto('/hub.html?lang=en')
  const dialog=await openModal(page), select=dialog.locator('#contract-property')
  await expect(select).not.toHaveAttribute('aria-hidden')
  await expect(select).toHaveAttribute('tabindex','3')
  await select.focus()
  await expect(select).toBeFocused()
  await select.selectOption('c')
  expect(await dialog.locator('form').evaluate(form=>new FormData(form).get('type'))).toBe('c')
})

test('five modal rerenders dispose old menus and preserve replacement and reused selects',async({page})=>{
  await page.goto('/hub.html?lang=en')
  const dialog=await openModal(page)
  const baseline=await page.locator('.property-menu').count()
  const cycles=[]
  for(let cycle=0;cycle<5;cycle++) {
    const trigger=dialog.locator('#contract-property').locator('..').locator('.property-trigger')
    await trigger.click()
    const oldPopup=await trigger.getAttribute('aria-controls')
    await dialog.locator('form').evaluate((form,fields)=>{
      window.removedProperty={select:form.querySelector('select'),trigger:form.querySelector('.property-trigger')}
      form.innerHTML=fields
    },fields)
    await expect(page.locator(`#${oldPopup}`)).toHaveCount(0)
    await expect(dialog.locator('.property-trigger')).toHaveCount(2)
    await expect(page.locator('.property-menu')).toHaveCount(baseline)
    const stale=await page.evaluate(async()=>{
      const {select,trigger}=window.removedProperty, before=trigger.textContent
      select.options[0].textContent='Removed select mutation'
      select.dispatchEvent(new Event('change',{bubbles:true}))
      await new Promise(resolve=>setTimeout(resolve,0))
      return {unchanged:trigger.textContent===before,nativeClass:select.classList.contains('property-native'),tabindex:select.getAttribute('tabindex')}
    })
    expect(stale).toEqual({unchanged:true,nativeClass:false,tabindex:'3'})
    cycles.push({cycle,menus:await page.locator('.property-menu').count(),stale})
  }
  // Removing just the original select must not resurrect it during disposal.
  await dialog.locator('#contract-property').evaluate(e=>{window.reusedProperty=e;e.remove()})
  await expect(dialog.locator('#contract-property')).toHaveCount(0)
  await expect(page.locator('.property-menu')).toHaveCount(baseline-1)
  await dialog.locator('form').evaluate(form=>form.prepend(window.reusedProperty))
  await expect(dialog.locator('#contract-property').locator('..').locator('.property-trigger')).toHaveCount(1)
  await expect(page.locator('.property-menu')).toHaveCount(baseline)
  const trigger=dialog.locator('#contract-property').locator('..').locator('.property-trigger')
  await trigger.click()
  const menu=await menuFor(page,trigger)
  await menu.getByRole('option',{name:'Alpha',exact:true}).click()
  await expect(dialog.locator('#contract-property')).toHaveValue('a')
  writeFileSync(resolve(output,'lifecycle.json'),JSON.stringify(cycles,null,2))
})

test('property menu ArrowUp from search focuses the last option',async({page})=>{
  await page.goto('/hub.html?lang=en')
  const trigger=page.locator('#project-sort').locator('..').locator('.property-trigger')
  await trigger.click()
  const menu=await menuFor(page,trigger)
  const options=menu.getByRole('option')
  await expect(options).toHaveCount(3)
  await expect(menu.locator('input[type=search]')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(options.last()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(options.first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
})
