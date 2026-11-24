/* Shared project collaborators for the Paper and Rebuttal headers. */
(() => {
  'use strict'

  const colorFor = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#2457d6'
  const identityFor = peer => peer.user?.id != null && String(peer.user.id) !== '' ? `user:${peer.user.id}` : `client:${peer.clientId}`
  const priority = peer => (peer.workspace?.visible !== false ? 4 : 0) + (peer.workspace?.focused ? 2 : 0) + (peer.workspace?.editing || peer.rebuttal?.editing ? 1 : 0)
  const comparePeople = (a, b) => a.user.name.localeCompare(b.user.name) || identityFor(a).localeCompare(identityFor(b))
  const avatarPaint = new WeakMap()
  function setText(node, value) {
    if (node.textContent === value) return false
    node.textContent = value
    return true
  }
  function setAttribute(node, name, value) {
    if (node.getAttribute(name) === value) return false
    node.setAttribute(name, value)
    return true
  }
  const initialsFor = name => {
    const words = name.trim().split(/\s+/).filter(Boolean)
    return (words.length > 1 ? words.slice(0, 2).map(word => Array.from(word)[0]).join('') : Array.from(words[0] || '?').slice(0, 2).join('')).toUpperCase()
  }
  function contrastFor(color) {
    if (window.PaperUI?.contrastTextFor) return window.PaperUI.contrastTextFor(color)
    const channels = color.slice(1).match(/../g).map(hex => {
      const value = parseInt(hex, 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return channels.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0) > 0.179 ? '#000000' : '#ffffff'
  }
  function readPeers(session) {
    const provider = session?.provider, awareness = provider?.awareness
    if (!provider?.wsconnected || !awareness) return []
    const peers = []
    awareness.getStates().forEach((state, clientId) => {
      if (state && typeof state === 'object') peers.push({ ...state, clientId, self: clientId === awareness.clientID })
    })
    return peers
  }
  function otherPeople(peers, selfId, rows) {
    const selfIds = new Set()
    if (selfId != null && String(selfId) !== '') selfIds.add(String(selfId))
    for (const peer of peers) if (peer.self && peer.user?.id != null) selfIds.add(String(peer.user.id))
    const groups = new Map()
    for (const peer of peers) {
      if (peer.self || (peer.user?.id != null && selfIds.has(String(peer.user.id))) || typeof peer.user?.name !== 'string') continue
      const name = peer.user.name.trim().slice(0, 120)
      if (!name) continue
      const person = { ...peer, user: { ...peer.user, name, color: colorFor(peer.user.color) } }
      const key = identityFor(person), previous = groups.get(key)
      const preferredId = rows.get(key)?.peer?.clientId
      const tied = previous && priority(person) === priority(previous)
      if (!previous || priority(person) > priority(previous) || (tied && (
        String(person.clientId) === String(preferredId) ||
        (String(previous.clientId) !== String(preferredId) && String(person.clientId).localeCompare(String(previous.clientId)) < 0)
      ))) groups.set(key, person)
    }
    return [...groups.values()].sort(comparePeople)
  }
  function paintAvatar(avatar, peer) {
    const previous = avatarPaint.get(avatar) || {}
    const next = { initials: initialsFor(peer.user.name), background: peer.user.color, foreground: contrastFor(peer.user.color) }
    let changed = setText(avatar, next.initials)
    if (previous.background !== next.background) { avatar.style.backgroundColor = next.background; changed = true }
    if (previous.foreground !== next.foreground) { avatar.style.color = next.foreground; changed = true }
    avatarPaint.set(avatar, next)
    return changed
  }
  function create({ host, describe, onFollow, onError, scope = 'project' }) {
    const prefix = scope === 'response' ? 'response-presence' : 'project-presence'
    if (!host) throw new Error('Project presence needs a host element')
    const control = document.createElement('details')
    control.id = prefix
    control.dataset.disclosureMenu = ''
    control.className = 'project-presence'
    control.innerHTML = `<summary id="${prefix}-toggle" aria-controls="${prefix}-list" aria-expanded="false"><span id="${prefix}-avatars" class="project-presence-avatars" aria-hidden="true"></span></summary><div class="project-presence-menu" popover="manual"><h2 id="${prefix}-title"></h2><p id="${prefix}-help"></p><div id="${prefix}-list"></div></div>`
    host.replaceChildren(control)
    host.hidden = true
    const toggle = control.querySelector('summary'), avatars = control.querySelector('.project-presence-avatars')
    const title = control.querySelector('h2'), help = control.querySelector('p'), list = control.querySelector(`#${prefix}-list`)
    const menu = control.querySelector('.project-presence-menu')
    const rows = new Map(), headerAvatars = new Map()
    const missingSince = new Map()
    let destroyed = false, expiryTimer, latestUpdate

    function close() {
      if (control.open) control.open = false
      setAttribute(toggle, 'aria-expanded', 'false')
      if(menu.matches(':popover-open'))menu.hidePopover()
    }
    function handleToggle() {
      setAttribute(toggle, 'aria-expanded', String(control.open))
      if(control.open){
        if(menu.showPopover && !menu.matches(':popover-open'))menu.showPopover()
        window.PaperUI.positionFloating(toggle,menu,{width:360,maxHeight:480,align:'end'})
      }else if(menu.matches(':popover-open'))menu.hidePopover()
    }
    function handleScroll(event) {
      if(!control.open || menu.contains(event.target))return
      const rect=toggle.getBoundingClientRect()
      if(rect.bottom<=0 || rect.top>=innerHeight)close()
      else handleToggle()
    }
    function handleResize() {
      if(control.open)handleToggle()
    }
    function makeRow() {
      const node = document.createElement('button')
      node.type = 'button'
      node.className = 'project-presence-person'
      node.innerHTML = '<span class="project-presence-avatar" aria-hidden="true"></span><span class="project-presence-copy"><strong></strong><span class="project-presence-location"></span><span class="project-presence-activity"></span></span>'
      const row = { node, peer: null, avatar: node.querySelector('.project-presence-avatar'), name: node.querySelector('strong'), location: node.querySelector('.project-presence-location'), activity: node.querySelector('.project-presence-activity') }
      node.addEventListener('click', async () => {
        close()
        try {
          if (await onFollow?.(row.peer) === false) {
            throw new Error(latestUpdate?.language === 'ko' ? '공동 작업자의 위치를 열 수 없습니다.' : 'Could not open the collaborator’s location.')
          }
        } catch (error) {
          if (onError) onError(error)
          else console.error(error)
        }
      })
      return row
    }
    function update({ peers = [], allPeers = peers, selfId, language = 'en', connected = true }) {
      if (destroyed) return
      clearTimeout(expiryTimer)
      latestUpdate = { peers, allPeers, selfId, language, connected }
      const t = (en, ko) => language === 'ko' ? ko : en
      const people = otherPeople(peers, selfId, rows)
      const present = new Set(people.map(identityFor)), elsewhere = new Set(allPeers.map(identityFor))
      const now = Date.now()
      let nextExpiry = Infinity
      for (const [key, row] of rows) {
        if (present.has(key)) { missingSince.delete(key); continue }
        // Known peers outside this scope moved away; only absent peers get reconnect grace.
        if (elsewhere.has(key) || (selfId != null && key === `user:${selfId}`)) { missingSince.delete(key); continue }
        if (!missingSince.has(key)) missingSince.set(key, now)
        const expires = missingSince.get(key) + 1200
        if (expires > now) { people.push(row.peer); nextExpiry = Math.min(nextExpiry, expires) }
        else missingSince.delete(key)
      }
      people.sort(comparePeople)
      if (nextExpiry !== Infinity) expiryTimer = setTimeout(() => update(latestUpdate), Math.max(1, nextExpiry - now))
      let changed = false
      if (host.hidden !== (people.length === 0)) { host.hidden = people.length === 0; changed = true }
      if (!people.length) close()
      changed = setAttribute(toggle, 'aria-label', scope === 'response' ? t('Collaborators in this response','이 답변의 공동 작업자') : t('Collaborators in this paper', '이 페이퍼의 공동 작업자')) || changed
      changed = setText(title, scope === 'response' ? t('People in this response','이 답변 접속자') : t('People in this paper', '이 페이퍼 접속자')) || changed
      changed = setText(help, scope === 'response' ? t('Choose a person to see their response location.','사용자를 선택하면 답변의 작업 위치로 이동합니다.') : t('Paper and Rebuttal · Choose a person to see their location.', 'Paper와 Rebuttal · 사용자를 선택하면 작업 위치로 이동합니다.')) || changed
      const active = document.activeElement
      const focused = [...rows.values()].find(row => row.node === active)
      const keys = new Set(), avatarKeys = new Set()
      for (const [index, peer] of people.entries()) {
        const key = identityFor(peer), location = describe?.(peer) || { label: '', available: false }
        keys.add(key)
        let row = rows.get(key)
        if (!row) { row = makeRow(); rows.set(key, row) }
        row.peer = peer
        changed = setAttribute(row.node, 'data-client-id', String(peer.clientId)) || changed
        changed = paintAvatar(row.avatar, peer) || changed
        changed = setText(row.name, peer.user.name) || changed
        changed = setText(row.location, String(location.label || '').slice(0, 1200)) || changed
        changed = setText(row.activity, peer.workspace?.visible === false ? t('Away', '자리 비움') : (peer.workspace?.editing || peer.rebuttal?.editing) ? t('Editing', '편집 중') : t('Viewing', '보는 중')) || changed
        if (row.node.disabled !== !location.available) { row.node.disabled = !location.available; changed = true }
        if (list.children[index] !== row.node) { list.insertBefore(row.node, list.children[index] || null); changed = true }
        if (index < 4) {
          avatarKeys.add(key)
          let avatar = headerAvatars.get(key)
          if (!avatar) { avatar = document.createElement('span'); avatar.className = 'project-presence-avatar'; headerAvatars.set(key, avatar) }
          changed = paintAvatar(avatar, peer) || changed
          changed = setAttribute(avatar, 'title', peer.user.name) || changed
          if (avatars.children[index] !== avatar) { avatars.insertBefore(avatar, avatars.children[index] || null); changed = true }
        }
      }
      for (const [key, row] of rows) if (!keys.has(key)) { row.node.remove(); rows.delete(key); changed = true }
      for (const [key, avatar] of headerAvatars) if (!avatarKeys.has(key)) { avatar.remove(); headerAvatars.delete(key); changed = true }
      if (focused && focused.node.isConnected && !focused.node.disabled && document.activeElement !== focused.node) focused.node.focus({ preventScroll: true })
      if(control.open && (changed || !menu.matches(':popover-open')))handleToggle()
    }
    function destroy() {
      destroyed = true
      clearTimeout(expiryTimer)
      latestUpdate = null
      missingSince.clear()
      control.removeEventListener('toggle', handleToggle)
      close()
      window.removeEventListener('resize',handleResize)
      document.removeEventListener('scroll',handleScroll,true)
      rows.clear()
      headerAvatars.clear()
      control.remove()
      host.hidden = true
    }
    control.addEventListener('toggle', handleToggle)
    window.PaperUI.enhanceDisclosure(control,{onOpen:handleToggle})
    window.addEventListener('resize',handleResize)
    document.addEventListener('scroll',handleScroll,true)
    return { update, close, destroy }
  }
  window.PaperProjectPresence = { create, readPeers }
})()
