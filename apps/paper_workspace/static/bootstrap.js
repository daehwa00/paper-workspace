(() => {
  'use strict'

  // Hide the manuscript shell before first paint when opening a review URL.
  if (document.currentScript?.dataset.paperPage === 'workspace') {
    document.documentElement.classList.add('paper-layout-starting')
    if (/^\/p\/[^/]+\/rebuttal(?:\/|$)/.test(location.pathname) || new URLSearchParams(location.search).get('view') === 'reviews') document.documentElement.classList.add('paper-initial-review')
  }

  // Keep profile colors intact; choose readable initials independently of the theme.
  const luminance = hex => {
    const channels = hex.match(/[a-f0-9]{2}/gi).map(channel => parseInt(channel, 16) / 255)
    return channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0)
  }
  window.PaperUI = Object.assign(window.PaperUI || {}, {
    contrastTextFor(hex) {
      if (!/^#[a-f0-9]{6}$/i.test(hex || '')) return '#ffffff'
      const background = luminance(hex)
      const dark = luminance('#18181b')
      return (background + 0.05) / (dark + 0.05) > 1.05 / (background + 0.05) ? '#18181b' : '#ffffff'
    }
  })

  // Shared app components keep their original controls and event handlers.
  // Popovers are presentation; selecting a property still changes its select.
  const localeText = (en, ko) => document.documentElement.lang === 'ko' ? ko : en
  // One lifecycle for settings, confirmations and domain forms. Menus return
  // focus to their visible summary when an action opens a modal from inside.
  function openDialog(dialog, {trigger = document.activeElement, focus, onReturnFocus} = {}) {
    if (!dialog || dialog.open) return
    const menu = trigger?.closest?.('details[data-disclosure-menu]')
    const compactMenu = menu && (menu.dataset.disclosureMenu !== 'mobile' || innerWidth < 768)
    const returnTarget = compactMenu ? menu.querySelector('summary') : trigger
    if (compactMenu) menu.open = false
    dialog.returnValue = ''
    dialog.addEventListener('close', () => {
      if (returnTarget?.isConnected && returnTarget.getClientRects().length) returnTarget.focus()
      else onReturnFocus?.(returnTarget)
    }, {once: true})
    dialog.showModal()
    focus?.focus()
  }

  const disclosureMenus = new WeakSet()
  function navigateMenu(event, menu) {
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) || event.target.closest('input,select,textarea')) return
    const items = [...menu.querySelectorAll('button:not(:disabled),a[href]')].filter(item => item.getClientRects().length && !item.closest('[hidden]'))
    if (!items.length) return
    const current = items.indexOf(document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : current < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    event.preventDefault();items[next].focus()
  }
  function enhanceDisclosure(menu, {onOpen} = {}) {
    if (disclosureMenus.has(menu)) return
    disclosureMenus.add(menu)
    const summary = menu.querySelector(':scope > summary')
    if (!summary) return
    const compact = () => menu.dataset.disclosureMenu !== 'mobile' || innerWidth < 768
    const sync = () => summary.setAttribute('aria-expanded', String(menu.open))
    const close = (restoreFocus = false) => {
      if (!compact() || !menu.open) return
      menu.open = false
      sync()
      if (restoreFocus) summary.focus()
    }
    menu.addEventListener('toggle', sync)
    menu.addEventListener('keydown', event => {
      if (event.defaultPrevented || !compact()) return
      // A select or nested picker owns its own Escape and navigation keys.
      const nestedPopover = event.target.closest('[popover]')
      if (event.target.closest('select') || (nestedPopover && nestedPopover.parentElement !== menu)) return
      if (event.key === 'Escape' && menu.open) {event.preventDefault();event.stopPropagation();close(true)}
      if (event.target === summary && event.key === 'ArrowDown') {
        event.preventDefault();menu.open = true;sync();onOpen?.()
        menu.querySelector('button:not(:disabled),select:not(:disabled),a[href]')?.focus()
      } else if (menu.open) navigateMenu(event,menu)
    })
    menu.addEventListener('click', event => {
      if (event.target.closest('button:not(:disabled),a[href]')) close()
    })
    menu.addEventListener('change', event => {
      if (event.target.matches('select')) close(true)
    })
    sync()
  }
  document.addEventListener('pointerdown', event => {
    document.querySelectorAll('details[data-disclosure-menu][open]').forEach(menu => {
      if (menu.dataset.disclosureMenu === 'mobile' && innerWidth >= 768) return
      if (!menu.contains(event.target)) menu.open = false
    })
  })
  Object.assign(window.PaperUI, {openDialog, enhanceDisclosure, navigateMenu})
  function positionFloating(trigger, popup, {width = 320, maxHeight = 420, align = 'start'} = {}) {
    const rect = trigger.getBoundingClientRect()
    const boundedWidth = Math.min(innerWidth - 16, Math.max(rect.width, width))
    popup.style.width = `${boundedWidth}px`
    popup.style.maxHeight = `${Math.min(maxHeight, innerHeight - 16)}px`
    const height = popup.getBoundingClientRect().height
    const left = align === 'end' ? rect.right - boundedWidth : rect.left
    popup.style.left = `${Math.max(8, Math.min(left, innerWidth - boundedWidth - 8))}px`
    popup.style.top = `${Math.max(8, rect.bottom + height + 4 > innerHeight ? rect.top - height - 4 : rect.bottom + 4)}px`
  }
  function updateSidebarToggle(button, collapsed) {
    if (!button.querySelector('svg')) button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6"/></svg>'
    button.classList.add('sidebar-toggle')
    button.classList.toggle('points-right', collapsed)
    button.title = collapsed ? localeText('Expand sidebar','사이드바 펼치기') : localeText('Collapse sidebar','사이드바 접기')
    button.setAttribute('aria-label',button.title)
    button.setAttribute('aria-expanded',String(!collapsed))
  }
  const sidebarReducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  let sidebarTransition = null, sidebarChanging = false
  const sidebarMotionOptions = {duration:220,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'}
  function cancelSidebarMotion() {
    if (!sidebarChanging) sidebarTransition?.finish()
  }
  function sidebarMotionElements() {
    const selectors = [
      '.project-frame-sidebar', '.sidebar-frame-surface',
      '.project-frame-header>.project-workspace-nav', '.project-frame-title', '.project-frame-brand',
      '#toggle-sidebar', '#toggle-review-sidebar', '.sidebar-resizer', '.sidebar-account',
      '#editor-panel', '.preview-panel', '#assistant-panel', '.workspace>.panel-resizer',
      '.app-content>.workspace-heading', '#main>:not(#mapping-workspace)',
      '.source-panel', '.response-panel', '#review-panel-resizer',
      '.reviewer-nav-row', '.screen-nav>button'
    ]
    return selectors.flatMap(selector=>[...document.querySelectorAll(selector)].map((element,index)=>({
      key:`${selector}:${index}`,element,rect:element.getBoundingClientRect()
    }))).filter(({rect})=>rect.width>0 && rect.height>0)
  }
  function animateSidebarChange(change) {
    const canAnimate=innerWidth>=768 && !sidebarReducedMotion.matches && typeof Element.prototype.animate==='function'
    sidebarTransition?.pause()
    const before=canAnimate ? new Map(sidebarMotionElements().map(item=>[item.key,item.rect])) : new Map()
    // Read the visible positions before cancelling so a repeated click can
    // reverse immediately without snapping back to the previous destination.
    cancelSidebarMotion()
    const header=document.querySelector('.project-frame-header')
    const surface=document.createElement('span')
    surface.className='sidebar-frame-surface'
    surface.setAttribute('aria-hidden','true')
    if(canAnimate && header){
      header.prepend(surface)
      if(!before.has('.sidebar-frame-surface:0'))before.set('.sidebar-frame-surface:0',surface.getBoundingClientRect())
    }
    let error
    sidebarChanging=true
    try {change()} catch(failure) {error=failure} finally {sidebarChanging=false}
    if(error || !canAnimate){surface.remove();return error ? Promise.reject(error) : Promise.resolve()}
    const animations=[]
    let resolve
    const result=new Promise(done=>{resolve=done})
    const current={pause(){for(const animation of animations)animation.pause()},finish(){
      if(sidebarTransition!==current)return
      sidebarTransition=null
      for(const animation of animations)animation.cancel()
      surface.remove()
      document.documentElement.classList.remove('sidebar-motion-running')
      resolve()
    }}
    sidebarTransition=current
    document.documentElement.classList.add('sidebar-motion-running')
    const play=(element,frames)=>{
      const animation=element.animate(frames,sidebarMotionOptions)
      animation.id='paper-sidebar-motion'
      animations.push(animation)
    }
    // Only the small fixed navigation column interpolates width. Content
    // panels already have their final width and move solely with transforms.
    const rail=document.querySelector('.project-frame-sidebar')
    const previousRail=before.get('.project-frame-sidebar:0')
    if(rail && previousRail){
      const width=rail.getBoundingClientRect().width
      if(Math.abs(previousRail.width-width)>.1)play(rail,[{width:`${previousRail.width}px`},{width:`${width}px`}])
    }
    const after=sidebarMotionElements()
    for(const {key,element,rect} of after){
      const old=before.get(key)
      if(!old || element===rail)continue
      const dx=old.left-rect.left,dy=old.top-rect.top
      const background=element===surface
      if(Math.abs(dx)<.1 && Math.abs(dy)<.1 && (!background || Math.abs(old.width-rect.width)<.1))continue
      const scale=background ? ` scale(${old.width/rect.width},${old.height/rect.height})` : ''
      play(element,[{transform:`translate(${dx}px,${dy}px)${scale}`,transformOrigin:'0 0'},{transform:'none',transformOrigin:'0 0'}])
    }
    // Counter the parent movement for right-aligned actions, preserving their
    // original position while their containing panels change width once.
    for(const selector of ['.project-workspace-nav .workspace-assistant-toggle','.review-context-bar>.actions','.response-header-right']){
      const element=document.querySelector(selector)
      if(!element)continue
      const parent=after.find(item=>item.element.contains(element) && item.element!==element)
      if(!parent)continue
      const oldParent=before.get(parent.key)
      if(!oldParent)continue
      const dx=oldParent.left-parent.rect.left
      if(Math.abs(dx)>.1)play(element,[{transform:`translateX(${-dx}px)`},{transform:'none'}])
    }
    Promise.allSettled(animations.map(animation=>animation.finished)).then(()=>current.finish())
    if(!animations.length)current.finish()
    return result
  }
  window.addEventListener('resize',cancelSidebarMotion)
  window.addEventListener('pagehide',cancelSidebarMotion)
  window.addEventListener('storage',event=>{if(event.key==='paper-workspace-layout')cancelSidebarMotion()})
  document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelSidebarMotion()})
  sidebarReducedMotion.addEventListener('change',cancelSidebarMotion)
  function bindResizer({element, getValue, getPointerValue = getValue, getLimits, fromPointer, onChange, onStart = () => {}, onCommit = () => {}, step = 1, direction = 1, enabled = () => true}) {
    let drag
    const apply = value => {
      const {min,max} = getLimits()
      onChange(Math.max(min,Math.min(max,value)))
    }
    const finish = () => {
      if (!drag) return
      const pointerId = drag.pointerId
      drag = null;element.classList.remove('dragging')
      document.body.classList.remove('panel-resizing')
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
      onCommit()
    }
    element.classList.add('workspace-resizer')
    element.addEventListener('pointerdown',event => {
      if (!enabled() || event.button !== 0) return
      event.preventDefault();cancelSidebarMotion();onStart()
      drag = {pointerId:event.pointerId,x:event.clientX,y:event.clientY,value:getPointerValue()}
      element.classList.add('dragging');document.body.classList.add('panel-resizing')
      element.setPointerCapture(event.pointerId)
    })
    element.addEventListener('pointermove',event => {
      if (drag && event.pointerId === drag.pointerId) apply(fromPointer(event,drag))
    })
    for (const type of ['pointerup','pointercancel','lostpointercapture']) element.addEventListener(type,finish)
    element.addEventListener('keydown',event => {
      if (!enabled() || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
      event.preventDefault();cancelSidebarMotion();onStart()
      const {min,max} = getLimits()
      apply(event.key === 'Home' ? min : event.key === 'End' ? max : getValue() + (event.key === 'ArrowLeft' ? -step : step) * direction)
      onCommit()
    })
  }
  Object.assign(window.PaperUI, {positionFloating, updateSidebarToggle, animateSidebarChange, cancelSidebarMotion, bindResizer})
  const supportsPopovers = typeof HTMLElement.prototype.showPopover === 'function' && typeof HTMLElement.prototype.hidePopover === 'function'
  let currentPopup
  function popupFor(trigger, className, label, options = {}) {
    const popup = options.element || document.createElement('div')
    popup.className = className
    popup.id ||= `paper-popup-${++popupFor.count}`
    popup.setAttribute('popover', 'auto')
    popup.setAttribute('role', 'dialog')
    popup.setAttribute('aria-label', label)
    popup.hidden = true
    // A modal makes everything outside its subtree inert, including a popover
    // in the top layer. Keep its menu inside the same modal boundary.
    const owner = trigger.closest('dialog')
    const host = owner || document.body
    host.append(popup)
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-controls', popup.id)
    trigger.setAttribute('aria-expanded', 'false')
    const hide = (restoreFocus = false) => {
      if (popup.matches(':popover-open')) popup.hidePopover()
      popup.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
      if (currentPopup?.element === popup) currentPopup = null
      options.onHide?.()
      const target = options.anchor?.() || trigger
      if (restoreFocus && target.isConnected) target.focus()
    }
    const show = () => {
      currentPopup?.hide()
      popup.hidden = false
      if (popup.showPopover) popup.showPopover()
      trigger.setAttribute('aria-expanded', 'true')
      currentPopup = {element:popup, trigger, hide}
      positionFloating(options.anchor?.() || trigger,popup,{width:options.width || (className === 'workspace-menu' ? 288 : 248)})
    }
    popup.addEventListener('keydown', event => {
      if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();hide(true)}
    })
    popup.addEventListener('toggle', event => {
      if (event.newState === 'closed') {
        trigger.setAttribute('aria-expanded', 'false')
        if (currentPopup?.element === popup) currentPopup = null
        options.onHide?.()
      }
    })
    const closeOwner = () => hide()
    owner?.addEventListener('close', closeOwner)
    return {element:popup,show,hide,dispose(){hide();owner?.removeEventListener('close',closeOwner);popup.remove()}}
  }
  popupFor.count = 0
  window.PaperUI.createPopover = popupFor
  document.addEventListener('pointerdown', event => {
    if (currentPopup && !currentPopup.element.contains(event.target) && !currentPopup.trigger.contains(event.target)) currentPopup.hide()
  })
  window.addEventListener('resize', () => currentPopup?.hide())

  const propertyPickers = new WeakMap()
  const activeProperties = new Set()
  function enhanceProperty(select) {
    if (!supportsPopovers || select.multiple || select.size > 1) return
    if (propertyPickers.has(select)) {propertyPickers.get(select).sync();return}
    const wrapper = document.createElement('span')
    wrapper.className = 'property-picker'
    select.before(wrapper)
    wrapper.append(select)
    select.classList.add('property-native')
    const originalTabIndex = select.getAttribute('tabindex')
    const originalAriaHidden = select.getAttribute('aria-hidden')
    const forcedColors = matchMedia('(forced-colors: active)')
    const restoreNativeAccess = () => {
      if(originalTabIndex === null)select.removeAttribute('tabindex')
      else select.setAttribute('tabindex',originalTabIndex)
      if(originalAriaHidden === null)select.removeAttribute('aria-hidden')
      else select.setAttribute('aria-hidden',originalAriaHidden)
    }
    const syncNativeAccess = () => {
      const hadFocus = wrapper.contains(document.activeElement) || popup.element.contains(document.activeElement)
      if(forcedColors.matches) {
        restoreNativeAccess()
        popup.hide()
        if(hadFocus)select.focus()
      } else {
        select.tabIndex=-1;select.setAttribute('aria-hidden','true')
        if(hadFocus)trigger.focus()
      }
    }
    forcedColors.addEventListener('change',syncNativeAccess)
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'property-trigger'
    const value = document.createElement('span')
    value.className = 'property-value'
    const chevron = document.createElement('span')
    chevron.className = 'select-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    trigger.append(value, chevron)
    wrapper.append(trigger)
    const label = () => {
      const labelNode = select.labels?.[0]
      const text = labelNode && [...labelNode.childNodes].filter(node => !(node instanceof Element) || !node.matches('.property-picker,select,button,input,textarea')).map(node => node.textContent).join('').trim()
      return select.dataset.propertyLabel || select.getAttribute('aria-label') || text || localeText('Select value','값 선택')
    }
    const popup = popupFor(trigger, 'property-menu', label())
    syncNativeAccess()
    const search = document.createElement('input')
    search.type = 'search'
    search.className = 'menu-search'
    const list = document.createElement('div')
    list.className = 'property-options'
    list.setAttribute('role','listbox')
    popup.element.append(search,list)
    const choose = option => {
      if (select.disabled || option.disabled || option.parentElement.disabled) return
      select.value = option.value
      select.dispatchEvent(new Event('input',{bubbles:true}))
      select.dispatchEvent(new Event('change',{bubbles:true}))
      sync()
      popup.hide()
      queueMicrotask(() => {
        const replacement = select.id && document.getElementById(select.id)?.closest('.property-picker')?.querySelector('.property-trigger')
        if (replacement) replacement.focus()
        else if (trigger.isConnected) trigger.focus()
      })
    }
    const render = () => {
      list.replaceChildren()
      let group = ''
      for (const option of select.options) {
        if (option.hidden || !option.label.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())) continue
        const groupLabel = option.parentElement.tagName === 'OPTGROUP' ? option.parentElement.label : ''
        if (groupLabel && groupLabel !== group) {
          group = groupLabel
          const heading = document.createElement('div');heading.className='menu-section-label';heading.textContent=group;list.append(heading)
        }
        const row = document.createElement('button')
        row.type = 'button';row.className = 'property-option';row.setAttribute('role','option')
        row.setAttribute('aria-selected',String(option.selected));row.disabled = option.disabled || option.parentElement.disabled
        const text = document.createElement('span');text.textContent = option.label
        const check = document.createElement('span');check.className='property-check';check.setAttribute('aria-hidden','true');check.textContent=option.selected?'✓':''
        row.append(text,check);row.onclick = () => choose(option);list.append(row)
      }
      if (!list.children.length) {const empty=document.createElement('p');empty.className='menu-empty';empty.textContent=localeText('No matching options','일치하는 항목이 없습니다');list.append(empty)}
    }
    let disposed = false
    function sync() {
      if (disposed) return
      value.textContent = select.selectedOptions[0]?.label || localeText('Select…','선택…')
      trigger.disabled = select.disabled
      trigger.setAttribute('aria-label',`${label()}: ${value.textContent}`)
      search.placeholder = localeText('Search options…','항목 검색…')
      search.setAttribute('aria-label',localeText('Search options','항목 검색'))
      list.setAttribute('aria-label',label())
      popup.element.setAttribute('aria-label',label())
      if (select.disabled) popup.hide()
      else if (trigger.getAttribute('aria-expanded') === 'true') render()
    }
    const open = () => {
      if (select.disabled || forcedColors.matches) return
      sync();search.value='';render();popup.show();search.focus()
    }
    trigger.onclick = () => {
      if (trigger.getAttribute('aria-expanded') === 'true') {popup.hide();return}
      open()
    }
    search.oninput = render
    popup.element.addEventListener('keydown', event => {
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return
      if (event.target === search && ['Home','End'].includes(event.key)) return
      const rows = [...list.querySelectorAll('button:not(:disabled)')]
      if (!rows.length) return
      event.preventDefault()
      const index = rows.indexOf(document.activeElement)
      let next
      if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = rows.length - 1
      else if (index < 0) {
        next = event.key === 'ArrowDown' ? 0 : rows.length - 1
      } else {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        next = (index + direction + rows.length) % rows.length
      }
      rows[next].focus()
    })
    for (const event of ['input','change']) select.addEventListener(event,sync)
    const form = select.form
    const syncAfterReset = () => queueMicrotask(sync)
    form?.addEventListener('reset',syncAfterReset)
    const observer = new MutationObserver(sync)
    observer.observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['selected','disabled','aria-label','data-property-label']})
    activeProperties.add({select,dispose(){
      disposed=true
      observer.disconnect()
      forcedColors.removeEventListener('change',syncNativeAccess)
      for(const event of ['input','change'])select.removeEventListener(event,sync)
      form?.removeEventListener('reset',syncAfterReset)
      popup.dispose()
      propertyPickers.delete(select)
      restoreNativeAccess()
      select.classList.remove('property-native')
      trigger.remove()
      if(wrapper.parentNode && select.parentNode===wrapper)wrapper.replaceWith(select)
      else {
        wrapper.classList.remove('property-picker')
        if(!wrapper.childNodes.length)wrapper.remove()
      }
    }})
    propertyPickers.set(select,{sync,open})
    sync()
  }

  const startComponents = () => {
    document.querySelectorAll('select[data-property-picker]').forEach(enhanceProperty)
    document.querySelectorAll('details[data-disclosure-menu]').forEach(enhanceDisclosure)
    document.addEventListener('click', event => {
      if (!(event.target instanceof Element) || event.target.closest('button,a,input,select,textarea')) return
      const label = event.target.closest('label')
      const property = label && propertyPickers.get(label.control)
      if (!property || matchMedia('(forced-colors: active)').matches) return
      event.preventDefault()
      property.open()
    })
    new MutationObserver(records => {
      for(const record of records)for(const node of record.addedNodes){if(!(node instanceof Element))continue;if(node.matches('select[data-property-picker]'))enhanceProperty(node);node.querySelectorAll('select[data-property-picker]').forEach(enhanceProperty);if(node.matches('details[data-disclosure-menu]'))enhanceDisclosure(node);node.querySelectorAll('details[data-disclosure-menu]').forEach(enhanceDisclosure)}
      if(records.some(record=>record.removedNodes.length))for(const entry of activeProperties)if(!entry.select.isConnected){entry.dispose();activeProperties.delete(entry)}
    }).observe(document.body,{childList:true,subtree:true})
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',startComponents,{once:true})
  else startComponents()

  // The browser owns selection, keyboard navigation and form submission. The
  // explicit selectedcontent only provides a box that can clip long labels.
  if (CSS.supports('appearance', 'base-select')) {
    const forcedColors = matchMedia('(forced-colors: active)')
    const enhanceSelect = select => {
      if(select.hasAttribute('data-property-picker')) {select.querySelector(':scope > button[data-paper-select-label]')?.remove();return}
      let button = select.querySelector(':scope > button[data-paper-select-label]')
      if (forcedColors.matches || select.multiple || select.size > 1) {
        button?.remove()
      } else if (!button) {
        const labelButton = document.createElement('button')
        labelButton.type = 'button'
        labelButton.inert = true
        labelButton.tabIndex = -1
        labelButton.dataset.paperSelectLabel = ''
        labelButton.append(document.createElement('selectedcontent'))
        select.prepend(labelButton)
        button = labelButton
      }
      // Chromium can retain the old selectedcontent after innerHTML replaces
      // options. Keep only the displayed label in sync; never change selection.
      if (button?.isConnected) {
        const label = button.querySelector('selectedcontent')
        const text = select.selectedOptions[0]?.label || ''
        if (label.textContent !== text) label.textContent = text
      }
    }
    const enhanceAllSelects = () => document.querySelectorAll('select').forEach(enhanceSelect)
    const startSelects = () => {
      enhanceAllSelects()
      new MutationObserver(records => {
        const selects = new Set()
        for (const record of records) {
          const parentSelect = record.target.closest?.('select')
          if (parentSelect) selects.add(parentSelect)
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue
            if (node.matches('select')) selects.add(node)
            node.querySelectorAll('select').forEach(select => selects.add(select))
          }
        }
        selects.forEach(select => { if (select.isConnected) enhanceSelect(select) })
      }).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['multiple', 'size']
      })
      forcedColors.addEventListener('change', enhanceAllSelects)
      for (const event of ['input', 'change']) document.addEventListener(event, event => {
        if (event.target instanceof HTMLSelectElement) enhanceSelect(event.target)
      })
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startSelects, { once: true })
    else startSelects()
  }

  const pendingPreferences = new Map()
  const preferenceStorage = Object.freeze({
    get: key => {
      if (pendingPreferences.has(key)) return pendingPreferences.get(key)
      try { return localStorage.getItem(key) } catch { return null }
    },
    set: (key, value) => {
      const text = String(value)
      try {
        localStorage.setItem(key, text)
        pendingPreferences.delete(key)
        return true
      } catch {
        pendingPreferences.set(key, text)
        return false
      }
    }
  })
  window.PaperPreferenceStorage = preferenceStorage

  const page = document.currentScript?.dataset.paperPage || 'hub'
  try {
    const queryLanguage = new URLSearchParams(location.search).get('lang')
    const savedLanguage = preferenceStorage.get('paper-workspace-language')
    const browserLanguage = (navigator.languages || [navigator.language])
      .map(value => String(value || '').toLowerCase().split('-')[0])
      .find(value => value === 'en' || value === 'ko')
    const language = ['en', 'ko'].includes(queryLanguage)
      ? queryLanguage
      : ['en', 'ko'].includes(savedLanguage) ? savedLanguage : browserLanguage || 'en'
    document.documentElement.lang = language
    document.documentElement.dataset.language = language
    const theme = preferenceStorage.get('paper-workspace-theme') || 'system'
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme:dark)').matches)
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.colorScheme = dark ? 'dark' : 'light'
  } catch {
    document.documentElement.lang = 'en'
  }

  const nativeFetch = window.fetch.bind(window)
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args)
    let redirectedToLogin = false
    try {
      redirectedToLogin = response.status === 401 || (response.redirected && new URL(response.url).pathname.startsWith('/_auth/login'))
    } catch {}
    if (redirectedToLogin && !location.pathname.startsWith('/_auth/')) {
      const returnTo = `${location.pathname}${location.search}${location.hash}`
      location.assign(`/_auth/login?rd=${encodeURIComponent(returnTo)}`)
      throw new DOMException('Authentication required', 'AbortError')
    }
    return response
  }

  if (page !== 'workspace') return

  const redactError = value => String(value || 'unknown error')
    .replace(/\b(?:Bearer\s+)?(?:sk-|github_pat_|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_+./=-]{8,}/gi, '[credential]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/https?:\/\/[^\s)]+/gi, '[url]')
    .replace(/(?:\/home|\/Users|[A-Z]:\\Users)[^\s:)]+/g, '[local-path]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240)

  const errorKind = message => {
    const value = String(message || '').toLowerCase()
    if (value.includes('startup watchdog')) return 'startup'
    if (value.includes('collaboration')) return 'collaboration'
    if (value.includes('promise')) return 'promise'
    return 'runtime'
  }
  const reportPath = () => {
    const match = location.pathname.match(/^\/p\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/|$)/)
    return match ? `/p/${match[1]}` : '/'
  }

  window.__paperReportError = message => {
    try {
      const redacted = redactError(message)
      fetch('/__client_error', {
        body: JSON.stringify({ kind: errorKind(redacted), message: redacted, path: reportPath() }),
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        method: 'POST'
      }).catch(() => {})
    } catch {}
  }
  window.addEventListener('error', event => window.__paperReportError(event.error?.stack || event.message))
  window.addEventListener('unhandledrejection', event => window.__paperReportError(event.reason?.stack || event.reason))
})()
