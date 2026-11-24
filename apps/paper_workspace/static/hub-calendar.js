window.PaperHubCalendar = function ({i18n, escapeHtml}) {
  const conferenceDeadlines = [
    {name:'ICAPS',rank:'A*',url:'https://icaps27.icaps-conference.org/calls/cfp/',dates:[['abstract','2026-12-07'],['full','2026-12-14']]},
    {name:'NAACL',rank:'A',url:'https://2027.naacl.org/',dates:[['commitment','2026-12-23']]},
    {name:'ACL',rank:'A*',url:'https://2027.aclweb.org/calls/main/',dates:[['full','2027-01-04']]},
    {name:'IJCAI',rank:'A*',url:'https://2027.ijcai.org/',dates:[['abstract','2027-01-04'],['full','2027-01-11']]},
    {name:'ICML',rank:'A*',url:'https://icml.cc/Conferences/2027/Dates',dates:[['abstract','2027-01-14'],['full','2027-01-22']]},
    {name:'SIGIR',rank:'A*',url:'https://sigir2027.org/pages/submit-full.html',dates:[['abstract','2027-01-14'],['full','2027-01-21']]},
    {name:'COLT',rank:'A*',url:'https://learningtheory.org/colt2027/',dates:[['full','2027-01-29']]}
  ].flatMap(conference=>conference.dates.map(([stage,aoe])=>({
    ...conference,stage,id:`${conference.name.toLowerCase()}-${stage}`,
    at:new Date(`${aoe}T23:59:00-12:00`),year:2027
  }))).sort((a,b)=>a.at-b.at||a.name.localeCompare(b.name))
  const deadlineStage = {abstract:'Abstract',full:'Full paper',commitment:'Commitment'}
  const kstDateFormatter = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'})
  function calendarKstKey(date) {
    const parts = Object.fromEntries(kstDateFormatter.formatToParts(date).map(part=>[part.type,part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
  function calendarDateKey(date) {
    return [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-')
  }
  function calendarToday() { return new Date(`${calendarKstKey(new Date())}T12:00:00`) }
  const calendarNow = calendarToday()
  let calendarMonth = new Date(calendarNow.getFullYear(), calendarNow.getMonth(), 1, 12)
  const calendarKeyboardFocus = {mini:'',overview:''}
  let selectedDeadlineDate = ''
  let selectedDeadlineConference = ''
  let deadlineTrigger = null
  const deadlinePopover = document.getElementById('hub-deadline-popover')
  const calendarOverview = document.getElementById('hub-calendar-overview')
  let overviewConference = ''
  let overviewDate = ''
  function calendarEvents(key) { return conferenceDeadlines.filter(event=>calendarKstKey(event.at)===key) }
  function deadlineMarker(stage) { return `<i class="deadline-dot ${stage}" aria-hidden="true"></i>` }
  function selectDeadlineDate() {
    document.querySelectorAll('[data-calendar-date]').forEach(button=>{
      const selected = button.dataset.calendarDate===selectedDeadlineDate
      button.classList.toggle('is-selected',selected)
      button.setAttribute('aria-expanded',String(selected && deadlinePopover.matches(':popover-open')))
    })
  }
  function conferenceDetailsMarkup(key,conferenceName='') {
    const language = i18n.getLanguage()
    return calendarEvents(key).filter(event=>!conferenceName || event.name===conferenceName).map(event=>{
      const conference = conferenceDetails[event.name]
      const milestones = conferenceDeadlines.filter(item=>item.name===event.name).map(item=>{
        const day = calendarKstKey(item.at)
        const time = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(item.at)
        return `<div class="hub-deadline-stage${day===key?' is-current':''}"><dt>${deadlineMarker(item.stage)}${deadlineStage[item.stage]}</dt><dd><time datetime="${item.at.toISOString()}" aria-label="${day} ${time} KST">${day.replaceAll('-','.')} <span>${time}</span></time></dd></div>`
      }).join('')
      const note = event.stage==='commitment' ? 'hub.commitmentNote' : event.name==='ACL' ? 'hub.arrNote' : ''
      return `<article class="hub-deadline-detail"><div class="hub-deadline-name"><strong>${event.name} ${event.year}</strong></div><p class="hub-conference-focus">${escapeHtml(conference[language==='ko'?'ko':'en'])}</p><dl class="hub-conference-facts"><div><dt>${escapeHtml(i18n.t('hub.conferenceLocation'))}</dt><dd>${escapeHtml(conference.location)}</dd></div><div><dt>${escapeHtml(i18n.t('hub.conferenceDates'))}</dt><dd>${conference.dates}</dd></div></dl><dl class="hub-conference-milestones" aria-label="${escapeHtml(i18n.t('hub.conferenceDeadlines'))} (KST)">${milestones}</dl>${note?`<p class="hub-deadline-note">${escapeHtml(i18n.t(note))}</p>`:''}<div class="hub-conference-links"><a href="${conference.home}" target="_blank" rel="noopener noreferrer">${escapeHtml(i18n.t('hub.conferenceWebsite'))}</a><a href="${event.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(i18n.t('hub.officialDeadline'))}</a></div></article>`
    }).join('') || `<p class="hub-deadline-empty">${escapeHtml(i18n.t('hub.noDayDeadlines'))}</p>`
  }
  function renderDeadlineDetails() {
    document.getElementById('hub-deadline-title').textContent = i18n.t('hub.conferenceDetails')
    const markup = conferenceDetailsMarkup(selectedDeadlineDate,selectedDeadlineConference)
    const details = document.getElementById('hub-deadline-details')
    if (details.dataset.markup!==markup) { details.innerHTML = markup; details.dataset.markup = markup }
  }
  function positionDeadlinePopover(trigger) {
    const anchor = trigger.getBoundingClientRect()
    const left = document.querySelector('.hub-topbar').getBoundingClientRect().right+12
    deadlinePopover.style.maxWidth = `${Math.max(0,innerWidth-left-12)}px`
    const bounds = deadlinePopover.getBoundingClientRect()
    deadlinePopover.style.left = `${left}px`
    deadlinePopover.style.top = `${Math.max(12,Math.min(anchor.top,innerHeight-bounds.height-12))}px`
  }
  function closeDeadlinePopover() {
    deadlinePopover.hidePopover()
    selectDeadlineDate()
  }
  function showDeadlineDate(key,trigger,conference='') {
    selectedDeadlineDate = key
    selectedDeadlineConference = conference
    deadlineTrigger = trigger
    if (!calendarEvents(key).length) {
      closeDeadlinePopover()
      return
    }
    const keyboard = trigger.matches(':focus-visible')
    renderDeadlineDetails()
    if (!deadlinePopover.matches(':popover-open')) deadlinePopover.showPopover()
    positionDeadlinePopover(trigger)
    selectDeadlineDate()
    if (keyboard) deadlinePopover.focus({preventScroll:true})
  }
  function calendarKeyboardRoot(kind) {
    return document.getElementById(kind==='mini'?'hub-calendar-days':'hub-overview-days')
  }
  function calendarKeyboardAttribute(kind) { return kind==='mini'?'data-calendar-date':'data-overview-date' }
  function syncCalendarTabStops(kind) {
    const root=calendarKeyboardRoot(kind),attribute=calendarKeyboardAttribute(kind)
    const buttons=[...root.querySelectorAll(`[${attribute}]`)]
    if (!buttons.length) return
    const active=root.contains(document.activeElement)?document.activeElement.getAttribute(attribute):''
    const month=calendarDateKey(calendarMonth).slice(0,7)
    const candidates=[active,calendarKeyboardFocus[kind]?.startsWith(month)?calendarKeyboardFocus[kind]:'',selectedDeadlineDate.startsWith(month)?selectedDeadlineDate:'',calendarKstKey(new Date()),`${month}-01`]
    const key=candidates.find(candidate=>candidate&&buttons.some(button=>button.getAttribute(attribute)===candidate))||buttons[0].getAttribute(attribute)
    calendarKeyboardFocus[kind]=key
    for (const button of buttons) button.tabIndex=button.getAttribute(attribute)===key?0:-1
  }
  function handleCalendarKeyboard(event,kind) {
    if (event.isComposing||event.altKey||event.ctrlKey||event.metaKey) return
    const attribute=calendarKeyboardAttribute(kind)
    const dateButton=event.target.closest(`[${attribute}]`)
    const conferenceButton=kind==='overview'?event.target.closest('[data-overview-event]'):null
    const deadline=conferenceButton&&conferenceDeadlines.find(item=>item.id===conferenceButton.dataset.overviewEvent)
    const key=dateButton?.getAttribute(attribute)||(deadline&&calendarKstKey(deadline.at))
    if (!key) return
    if (kind==='overview'&&dateButton&&event.key==='Enter') {
      event.preventDefault()
      const first=calendarEvents(key)[0]
      if (first) {
        overviewDate=key;overviewConference=first.name;selectedDeadlineDate=key;calendarKeyboardFocus.overview=key
        renderCalendar()
      } else dateButton.click()
      return
    }
    const offset={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key]
    if (offset===undefined) return
    event.preventDefault()
    const target=new Date(`${key}T12:00:00`);target.setDate(target.getDate()+offset)
    const targetKey=calendarDateKey(target)
    calendarKeyboardFocus[kind]=targetKey
    if (kind==='mini') closeDeadlinePopover()
    if (target.getFullYear()!==calendarMonth.getFullYear()||target.getMonth()!==calendarMonth.getMonth()) {
      calendarMonth=new Date(target.getFullYear(),target.getMonth(),1,12)
      renderCalendar()
    }
    syncCalendarTabStops(kind)
    const button=calendarKeyboardRoot(kind).querySelector(`[${attribute}="${targetKey}"]`)
    if (button) {
      // An old focused date can still be present in the adjacent-month cells.
      for (const day of calendarKeyboardRoot(kind).querySelectorAll(`[${attribute}]`)) day.tabIndex=day===button?0:-1
      button.focus({preventScroll:true})
      button.scrollIntoView({block:'nearest',inline:'nearest'})
    }
  }
  for (const kind of ['mini','overview']) {
    const root=calendarKeyboardRoot(kind),attribute=calendarKeyboardAttribute(kind)
    root.addEventListener('keydown',event=>handleCalendarKeyboard(event,kind))
    root.addEventListener('focusin',event=>{
      const button=event.target.closest(`[${attribute}]`)
      if (button) { calendarKeyboardFocus[kind]=button.getAttribute(attribute);syncCalendarTabStops(kind) }
    })
  }

  function renderCalendar() {
    const locale = i18n.getLanguage()==='ko' ? 'ko-KR' : 'en-US'
    const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth()
    const title = locale==='ko-KR' ? `${year} ${month+1}월` : new Intl.DateTimeFormat(locale,{month:'short',year:'numeric'}).format(calendarMonth)
    const heading = document.getElementById('hub-calendar-month')
    heading.textContent = title
    heading.title = title
    const weekday = new Intl.DateTimeFormat(locale,{weekday:locale==='ko-KR'?'narrow':'short'})
    const fullWeekday = new Intl.DateTimeFormat(locale,{weekday:'long'})
    document.getElementById('hub-calendar-weekdays').innerHTML = '<tr>'+Array.from({length:7},(_,day)=>{
      const date = new Date(2023,0,day+1,12) // January 1, 2023 was a Sunday.
      return `<th scope="col"><abbr title="${escapeHtml(fullWeekday.format(date))}">${escapeHtml(weekday.format(date))}</abbr></th>`
    }).join('')+'</tr>'
    const today = calendarKstKey(new Date())
    const fullDate = new Intl.DateTimeFormat(locale,{year:'numeric',month:'long',day:'numeric',weekday:'long'})
    const firstDay = new Date(year,month,1,12).getDay()
    const weeks = Array.from({length:6},(_,week)=>'<tr>'+Array.from({length:7},(_,day)=>{
      const date = new Date(year,month,1-firstDay+week*7+day,12)
      const key = calendarDateKey(date), events = calendarEvents(key)
      const time = `<time datetime="${key}" aria-label="${escapeHtml(fullDate.format(date))}"${key===today?' aria-current="date"':''}>${date.getDate()}</time>`
      const label = `${fullDate.format(date)} · ${events.length ? events.map(event=>`${event.name} ${deadlineStage[event.stage]}`).join(', ') : i18n.t('hub.noDayDeadlines')}`
      const marker = events.slice(0,2).map(event=>deadlineMarker(event.stage)).join('')+(events.length>2?`<span>+${events.length-2}</span>`:'')
      return `<td${date.getMonth()!==month?' class="is-outside"':''}><button type="button" class="hub-calendar-day" data-calendar-date="${key}" aria-label="${escapeHtml(label)}" aria-haspopup="dialog" aria-controls="hub-deadline-popover" aria-expanded="false">${time}<span class="hub-calendar-markers" aria-hidden="true">${marker}</span></button></td>`
    }).join('')+'</tr>')
    const days = document.getElementById('hub-calendar-days')
    const focusedDate = document.activeElement?.dataset.calendarDate
    // Keep focused date buttons intact when a background refresh changes nothing.
    const markup = weeks.join('')
    if (days.dataset.markup!==markup) {
      days.innerHTML = markup; days.dataset.markup = markup
      if (focusedDate) days.querySelector(`[data-calendar-date="${focusedDate}"]`)?.focus({preventScroll:true})
    }
    syncCalendarTabStops('mini')
    const upcoming = conferenceDeadlines.filter(event=>event.at.getTime()+60000> Date.now()).slice(0,2)
    const upcomingMarkup = upcoming.length ? upcoming.map(event=>{
      const key = calendarKstKey(event.at)
      const distance = Math.round((Date.parse(`${key}T00:00:00Z`)-Date.parse(`${today}T00:00:00Z`))/86400000)
      const relative = distance===0 ? i18n.t('hub.deadlineToday') : distance===1 ? i18n.t('hub.deadlineTomorrow') : `D-${distance}`
      const date = `${key.slice(5,7)}.${key.slice(8)} ${new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(event.at)}`
      return `<button type="button" class="hub-upcoming-deadline" data-deadline-id="${event.id}" aria-haspopup="dialog" aria-controls="hub-deadline-popover" aria-label="${escapeHtml(`${event.name} ${event.year} ${deadlineStage[event.stage]}, ${key} ${date.slice(6)} KST, ${relative}`)}"><span class="hub-upcoming-title">${deadlineMarker(event.stage)}<strong>${event.name}</strong><span>${deadlineStage[event.stage]}</span></span><time class="hub-upcoming-date" datetime="${event.at.toISOString()}">${date}</time><span class="hub-upcoming-countdown${distance<=3?' is-near':''}${distance<=1?' is-urgent':''}">${escapeHtml(relative)}</span></button>`
    }).join('') : `<p class="hub-deadline-empty">${escapeHtml(i18n.t('hub.noDeadlines'))}</p>`
    const upcomingList = document.getElementById('hub-upcoming-deadlines')
    if (upcomingList.dataset.markup!==upcomingMarkup) { upcomingList.innerHTML = upcomingMarkup; upcomingList.dataset.markup = upcomingMarkup }
    if (deadlinePopover.matches(':popover-open')) {
      renderDeadlineDetails()
      if (deadlineTrigger?.isConnected) positionDeadlinePopover(deadlineTrigger)
    }
    selectDeadlineDate()
    if (calendarOverview.open) renderCalendarOverview()
  }
  function renderCalendarOverview() {
    document.getElementById('hub-overview-title').textContent = document.getElementById('hub-calendar-month').textContent
    document.getElementById('hub-overview-weekdays').innerHTML = document.getElementById('hub-calendar-weekdays').innerHTML
    const locale = i18n.getLanguage()==='ko' ? 'ko-KR' : 'en-US'
    const fullDate = new Intl.DateTimeFormat(locale,{year:'numeric',month:'long',day:'numeric',weekday:'long'})
    const year=calendarMonth.getFullYear(),month=calendarMonth.getMonth(),firstDay=calendarMonth.getDay()
    const today=calendarKstKey(new Date())
    const markup=Array.from({length:6},(_,week)=>'<tr>'+Array.from({length:7},(_,day)=>{
      const date=new Date(year,month,1-firstDay+week*7+day,12),key=calendarDateKey(date)
      const events=calendarEvents(key)
      return `<td${date.getMonth()!==month?' class="is-outside"':''}><div class="hub-overview-day${key===selectedDeadlineDate?' is-selected':''}"><button type="button" class="hub-overview-date" data-overview-date="${key}" aria-label="${escapeHtml(fullDate.format(date))}" aria-pressed="${key===selectedDeadlineDate}"><time datetime="${key}"${key===today?' aria-current="date"':''}>${date.getDate()}</time></button><div class="hub-overview-events">${events.map(event=>`<button type="button" class="hub-overview-event${overviewConference===event.name&&overviewDate===key?' is-active':''}" data-overview-event="${event.id}" aria-controls="hub-overview-detail-panel" aria-expanded="${overviewConference===event.name&&overviewDate===key}" aria-label="${escapeHtml(`${event.name} ${event.year} · ${deadlineStage[event.stage]} · ${key} 20:59 KST`)}">${deadlineMarker(event.stage)}<span><strong>${event.name}</strong><span>${deadlineStage[event.stage]}</span></span></button>`).join('')}</div></div></td>`
    }).join('')+'</tr>').join('')
    const days=document.getElementById('hub-overview-days')
    const focusedEvent=document.activeElement?.dataset.overviewEvent
    const focusedDate=document.activeElement?.dataset.overviewDate
    if (days.dataset.markup!==markup) {
      days.innerHTML=markup;days.dataset.markup=markup
      if (focusedEvent) days.querySelector(`[data-overview-event="${focusedEvent}"]`)?.focus({preventScroll:true})
      else if (focusedDate) days.querySelector(`[data-overview-date="${focusedDate}"]`)?.focus({preventScroll:true})
    }
    syncCalendarTabStops('overview')
    const panel=document.getElementById('hub-overview-detail-panel')
    if (overviewConference) {
      const details=document.getElementById('hub-overview-details'),content=conferenceDetailsMarkup(overviewDate,overviewConference)
      if (details.dataset.markup!==content) { details.innerHTML=content;details.dataset.markup=content }
    }
    syncOverviewPanel()
  }
  function syncOverviewPanel() {
    const panel=document.getElementById('hub-overview-detail-panel'),open=Boolean(overviewConference)
    panel.inert=!open
    panel.setAttribute('aria-hidden',String(!open))
    if (open) {
      if (panel.hidden) {
        panel.hidden=false
        // Establish the collapsed width before enabling the live-content slide.
        panel.getBoundingClientRect()
      }
      panel.classList.add('is-open')
    } else {
      panel.classList.remove('is-open')
      if (!calendarOverview.open) panel.hidden=true
    }
  }
  document.getElementById('hub-overview-detail-panel').addEventListener('transitionend',event=>{
    if (event.target===event.currentTarget && event.propertyName==='flex-basis' && !overviewConference) event.currentTarget.hidden=true
  })
  function resetOverviewDetails() { overviewConference='';overviewDate='' }
  function closeCalendarOverview() {
    resetOverviewDetails()
    calendarOverview.close()
    syncOverviewPanel()
  }
  document.getElementById('hub-calendar-expand').addEventListener('click',()=>{
    closeDeadlinePopover()
    resetOverviewDetails()
    calendarOverview.showModal()
    renderCalendarOverview()
    calendarOverview.focus({preventScroll:true})
  })
  document.getElementById('hub-overview-close').addEventListener('click',closeCalendarOverview)
  calendarOverview.addEventListener('cancel',event=>{event.preventDefault();closeCalendarOverview()})
  calendarOverview.addEventListener('click',event=>{
    if (event.target!==calendarOverview) return
    const bounds=calendarOverview.getBoundingClientRect()
    if (event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom) closeCalendarOverview()
  })
  for (const [id,delta] of [['hub-overview-previous',-1],['hub-overview-next',1]]) document.getElementById(id).addEventListener('click',()=>{
    moveCalendarMonth(delta)
  })
  // Consume one vertical wheel gesture per month; preserve native overflow scrolling.
  let overviewWheel = {last:0, distance:0, moved:false}
  document.querySelector('.hub-overview-month').addEventListener('wheel',event=>{
    if (!calendarOverview.open || event.ctrlKey || Math.abs(event.deltaX)>Math.abs(event.deltaY) || !event.deltaY) return
    const month=event.currentTarget,layout=month.parentElement
    if (month.scrollHeight>month.clientHeight+1 || layout.scrollHeight>layout.clientHeight+1) return
    event.preventDefault()
    const now=performance.now()
    if (now-overviewWheel.last>240) overviewWheel={last:now,distance:0,moved:false}
    overviewWheel.last=now
    if (overviewWheel.moved) return
    const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?month.clientHeight:1)
    if (Math.sign(pixels)!==Math.sign(overviewWheel.distance)) overviewWheel.distance=0
    overviewWheel.distance+=pixels
    if (Math.abs(overviewWheel.distance)<40) return
    overviewWheel.moved=true
    moveCalendarMonth(Math.sign(overviewWheel.distance))
  },{passive:false})
  document.getElementById('hub-overview-today').addEventListener('click',()=>{
    const today=calendarToday();calendarMonth=new Date(today.getFullYear(),today.getMonth(),1,12);renderCalendar()
  })
  document.getElementById('hub-overview-days').addEventListener('click',event=>{
    const conference=event.target.closest('[data-overview-event]')
    if (conference) {
      const deadline=conferenceDeadlines.find(item=>item.id===conference.dataset.overviewEvent)
      if (!deadline) return
      overviewDate=calendarKstKey(deadline.at);overviewConference=deadline.name;selectedDeadlineDate=overviewDate
      calendarKeyboardFocus.overview=overviewDate
      renderCalendar()
      return
    }
    const date=event.target.closest('[data-overview-date]')
    if (date) { selectedDeadlineDate=date.dataset.overviewDate;calendarKeyboardFocus.overview=selectedDeadlineDate;resetOverviewDetails();renderCalendar() }
  })
  document.getElementById('hub-overview-detail-close').addEventListener('click',()=>{
    const trigger=document.querySelector(`#hub-overview-days [data-overview-event="${conferenceDeadlines.find(item=>item.name===overviewConference&&calendarKstKey(item.at)===overviewDate)?.id}"]`)
    const id=trigger?.dataset.overviewEvent
    resetOverviewDetails();renderCalendarOverview()
    const focusTarget=id ? document.querySelector(`#hub-overview-days [data-overview-event="${id}"]`) : document.getElementById('hub-overview-today')
    focusTarget?.focus({preventScroll:true})
  })

  function moveCalendarMonth(delta) {
    closeDeadlinePopover()
    calendarMonth.setMonth(calendarMonth.getMonth()+delta)
    renderCalendar()
  }
  document.getElementById('hub-calendar-previous').addEventListener('click',()=>moveCalendarMonth(-1))
  document.getElementById('hub-calendar-next').addEventListener('click',()=>moveCalendarMonth(1))
  document.getElementById('hub-calendar-today').addEventListener('click',()=>{
    closeDeadlinePopover()
    const today = calendarToday()
    calendarMonth = new Date(today.getFullYear(),today.getMonth(),1,12)
    renderCalendar()
  })
  document.getElementById('hub-calendar-days').addEventListener('click',event=>{
    const trigger = event.target.closest('[data-calendar-date]')
    if (trigger) {
      calendarKeyboardFocus.mini=trigger.dataset.calendarDate
      syncCalendarTabStops('mini')
      showDeadlineDate(trigger.dataset.calendarDate,trigger)
    }
  })
  document.getElementById('hub-upcoming-deadlines').addEventListener('click',event=>{
    const trigger = event.target.closest('[data-deadline-id]')
    const deadline = conferenceDeadlines.find(item=>item.id===trigger?.dataset.deadlineId)
    if (!deadline) return
    const key = calendarKstKey(deadline.at), date = new Date(`${key}T12:00:00`)
    calendarMonth = new Date(date.getFullYear(),date.getMonth(),1,12)
    renderCalendar()
    showDeadlineDate(key,trigger,deadline.name)
  })
  document.getElementById('hub-deadline-close').addEventListener('click',()=>{
    closeDeadlinePopover()
    if (deadlineTrigger?.isConnected) deadlineTrigger.focus({preventScroll:true})
  })
  deadlinePopover.addEventListener('toggle',()=>{
    selectDeadlineDate()
    // Native light-dismiss and Escape close the card without trapping focus.
    if (!deadlinePopover.matches(':popover-open') && document.activeElement===document.body && deadlineTrigger?.isConnected) deadlineTrigger.focus({preventScroll:true})
  })
  window.addEventListener('resize',()=>{
    if (deadlinePopover.matches(':popover-open')) closeDeadlinePopover()
  })
  document.addEventListener('scroll',event=>{
    if (deadlinePopover.matches(':popover-open') && !deadlinePopover.contains(event.target)) closeDeadlinePopover()
  },true)
  window.addEventListener('focus',renderCalendar)
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)renderCalendar()})
  // Refresh after a KST day boundary or a deadline even when the tab stays open.
  setInterval(()=>{if(!document.hidden)renderCalendar()},60000)

  return {renderCalendar, calendarKstKey}
}
