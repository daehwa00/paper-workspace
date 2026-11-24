import { expect, test, namedContext } from './fixtures.js'

const response = 'Alpha beta gamma delta.\nSecond response line.'
const commonResponse = 'A common response for every reviewer.'
const metadata = () => ({
  schema_version:1,revision:0,enabled:true,jobs:[],rounds:[{
    id:'r1',title:'First review round',reviewers:[{id:'reviewer1',name:'Reviewer A'}],
    reviews:[{id:'review1',reviewer_id:'reviewer1',fields:{review:'Please clarify the comparison.'},translations:{}}],
    documents:[
      {id:'doc1',title:'Response to Reviewer A',kind:'reviewer',reviewer_id:'reviewer1',text_key:'response:doc1',seed_text:response},
      {id:'doc2',title:'Common response',kind:'common',reviewer_id:null,text_key:'response:doc2',seed_text:commonResponse}
    ],imports:[],concerns:[],mappings:[],findings:[],evidence:[],work_items:[],rules:[],active_rules_id:null,analyses:[],submissions:[],glossary:{}
  }]
})

// Only metadata/history use mocks. Shared text, user profiles and awareness
// use the real development collaboration server and Yjs WebSocket provider.
async function person(browser,name,state) {
  const context=await namedContext(browser)
  await context.addInitScript(name=>{
    localStorage.setItem('collab-name',name)
    localStorage.setItem('collab-name-user-set','1')
  },name)
  await context.route('**/api/rebuttal/projects/**',route=>{
    const path=new URL(route.request().url()).pathname
    return route.fulfill({json:path.endsWith('/versions')?{versions:[],saved:true}:structuredClone(state)})
  })
  return {context,page:await context.newPage()}
}

async function openReview(page,slug) {
  await page.goto(`/p/${slug}/rebuttal?standalone=1&round=r1&lang=en#reviews`)
  await page.waitForFunction(()=>Boolean(window.PaperRebuttalSession))
  await page.evaluate(()=>window.PaperRebuttalSession.whenReady)
  await expect(page.locator('#response-editor .cm-content')).toContainText('Alpha beta gamma delta.')
}

async function openPaper(page,slug) {
  await page.goto(`/p/${slug}?lang=en`)
  await page.waitForFunction(()=>typeof workspaceReadyForCompile!=='undefined' && workspaceReadyForCompile && collabReady)
  await page.waitForFunction(()=>document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttalSession)
  await expect(page.locator('#editor-view .cm-content')).toBeVisible()
  await expect(page.frameLocator('.paper-review-frame').locator('#response-editor .cm-content')).toBeAttached()
}

async function selectStart(page,content=page.locator('#response-editor .cm-content'),length=6) {
  await content.click()
  await page.keyboard.press('Control+Home')
  for(let index=0;index<length;index++)await page.keyboard.press('Shift+ArrowRight')
}

async function openRoster(page) {
  const menu=page.locator('#project-presence')
  if(!await menu.evaluate(node=>node.open))await page.locator('#project-presence-toggle').click()
  await expect(page.locator('#project-presence-list')).toBeVisible()
}

const projectAvatars = page => page.locator('#project-presence-avatars .project-presence-avatar')
const responseAvatars = page => page.locator('#response-presence-avatars .project-presence-avatar')
const rosterPerson = (page,name) => page.locator('#project-presence-list .project-presence-person').filter({hasText:name})
const remoteCaret = page => page.locator('#response-editor .cm-remoteCaret')

async function peerState(page,name) {
  return page.evaluate(name=>{
    const session=window.PaperRebuttalSession || window.PaperWorkspaceSharedSession
    return [...session.provider.awareness.getStates().values()].find(peer=>peer.user?.name===name) || null
  },name)
}

// Background-tab behavior is controlled explicitly: headless pages do not
// reliably acquire OS focus or become hidden when another page is selected.
// Editor focus/selection and every resulting awareness update remain real.
async function simulateVisibility(page,visible) {
  await page.evaluate(visible=>{
    Object.defineProperty(document,'visibilityState',{configurable:true,value:visible?'visible':'hidden'})
    Object.defineProperty(document,'hidden',{configurable:true,value:!visible})
    document.dispatchEvent(new Event('visibilitychange'))
  },visible)
}

test('hidden response collaborators stay in the project roster as Away and return immediately', async ({browser})=>{
  const state=metadata(),slug=`presence-visibility-${Date.now()}`
  const alice=await person(browser,'Alice',state),bob=await person(browser,'Bob',state)
  try {
    await Promise.all([openReview(alice.page,slug),openReview(bob.page,slug)])
    await selectStart(bob.page)
    await expect(remoteCaret(alice.page)).toHaveCount(1)
    await openRoster(alice.page)
    await expect(rosterPerson(alice.page,'Bob')).toHaveCount(1)
    await simulateVisibility(bob.page,false)
    await expect(remoteCaret(alice.page)).toHaveCount(0)
    await expect(alice.page.locator('#response-editor .cm-remoteSelection')).toHaveCount(0)
    await expect(projectAvatars(alice.page)).toHaveCount(1)
    await expect(projectAvatars(alice.page)).toHaveAttribute('title','Bob')
    await expect(rosterPerson(alice.page,'Bob').locator('.project-presence-activity')).toHaveText('Away')
    await simulateVisibility(bob.page,true)
    await expect(rosterPerson(alice.page,'Bob').locator('.project-presence-activity')).toHaveText(/Viewing|Editing/)
    await selectStart(bob.page)
    await expect(remoteCaret(alice.page)).toHaveCount(1)
    await expect(rosterPerson(alice.page,'Bob')).toHaveCount(1)
  } finally {await Promise.all([alice.context.close(),bob.context.close()])}
})

test('brief reconnects preserve collaborator nodes while a real departure expires after its grace period', async ({browser})=>{
  const state=metadata(),slug=`presence-reconnect-${Date.now()}`
  const alice=await person(browser,'Alice',state),bob=await person(browser,'Bob',state)
  try {
    await Promise.all([openReview(alice.page,slug),openReview(bob.page,slug)])
    await selectStart(bob.page)
    await openRoster(alice.page)
    await expect(projectAvatars(alice.page)).toHaveAttribute('title','Bob')
    await alice.page.evaluate(()=>{
      const avatar=document.querySelector('#project-presence-avatars .project-presence-avatar')
      const row=document.querySelector('#project-presence-list .project-presence-person'),name=row.querySelector('strong')
      window.presenceNodes={avatar,avatarText:avatar.firstChild,row,nameText:name.firstChild}
      window.PaperRebuttalSession.provider.disconnect()
    })
    await alice.page.waitForTimeout(250)
    await expect(projectAvatars(alice.page)).toHaveCount(1)
    expect(await peerState(bob.page,'Alice')).toBeNull()
    await alice.page.evaluate(()=>window.PaperRebuttalSession.provider.connect())
    await expect.poll(()=>alice.page.evaluate(()=>window.PaperRebuttalSession.provider.wsconnected)).toBe(true)
    await expect.poll(()=>peerState(alice.page,'Bob')).not.toBeNull()
    // Neither peer moves, edits or emits a test heartbeat to restore Alice.
    await expect.poll(()=>peerState(bob.page,'Alice')).not.toBeNull()
    await expect(projectAvatars(bob.page)).toHaveAttribute('title','Alice')
    await selectStart(bob.page,undefined,9)
    expect(await alice.page.evaluate(()=>{
      const saved=window.presenceNodes,avatar=document.querySelector('#project-presence-avatars .project-presence-avatar')
      const row=document.querySelector('#project-presence-list .project-presence-person')
      return saved.avatar===avatar && saved.avatarText===avatar.firstChild && saved.row===row && saved.nameText===row.querySelector('strong').firstChild
    })).toBe(true)
    await alice.page.evaluate(()=>{
      const awareness=window.PaperRebuttalSession.provider.awareness,saved=window.presenceNodes
      window.presenceDeparture={}
      awareness.on('change',()=>{
        if(![...awareness.getStates().values()].some(peer=>peer.user?.name==='Bob'))window.presenceDeparture.awarenessMissing ??= performance.now()
      })
      new MutationObserver(()=>{
        if(!saved.avatar.isConnected)window.presenceDeparture.avatarRemoved ??= performance.now()
      }).observe(document.querySelector('#project-presence-avatars'),{childList:true})
    })
    await bob.context.close()
    await expect.poll(()=>peerState(alice.page,'Bob')).toBeNull()
    await expect(projectAvatars(alice.page)).toHaveCount(1)
    await expect(projectAvatars(alice.page)).toHaveCount(0)
    expect(await alice.page.evaluate(()=>window.presenceDeparture.avatarRemoved-window.presenceDeparture.awarenessMissing)).toBeGreaterThanOrEqual(1000)
    await expect(alice.page.locator('#project-presence')).toBeHidden()
    await alice.page.evaluate(()=>{
      const provider=window.PaperRebuttalSession.provider
      provider.disconnect();provider.connect()
    })
    await expect.poll(()=>alice.page.evaluate(()=>{
      const provider=window.PaperRebuttalSession.provider
      return provider.wsconnected && provider.synced
    })).toBe(true)
    await alice.page.waitForTimeout(300)
    expect(await peerState(alice.page,'Bob')).toBeNull()
    await expect(projectAvatars(alice.page)).toHaveCount(0)
    await expect(alice.page.locator('#project-presence')).toBeHidden()
  } finally {await Promise.all([alice.context.close(),bob.context.close()])}
})

test('abrupt disconnect after reconnect removes the departed collaborator from awareness and the roster', async ({browser})=>{
  const state=metadata(),slug=`presence-abrupt-reconnect-${Date.now()}`
  const alice=await person(browser,'Alice',state),bob=await person(browser,'Bob',state)
  try {
    await Promise.all([openReview(alice.page,slug),openReview(bob.page,slug)])
    await expect.poll(()=>peerState(alice.page,'Bob')).not.toBeNull()
    await expect.poll(()=>peerState(bob.page,'Alice')).not.toBeNull()
    await alice.page.evaluate(()=>window.PaperRebuttalSession.provider.disconnect())
    await expect.poll(()=>peerState(bob.page,'Alice')).toBeNull()
    await alice.page.evaluate(()=>window.PaperRebuttalSession.provider.connect())
    await expect.poll(()=>peerState(alice.page,'Bob')).not.toBeNull()
    await expect.poll(()=>peerState(bob.page,'Alice')).not.toBeNull()
    await expect(projectAvatars(bob.page)).toHaveAttribute('title','Alice')
    // Close only the transport: do not send an awareness logout or disconnect
    // the provider's BroadcastChannel before the server detects the departure.
    await alice.page.evaluate(()=>{
      const provider=window.PaperRebuttalSession.provider
      provider.shouldConnect=false
      provider.ws.close()
    })
    await expect.poll(()=>peerState(bob.page,'Alice'),{timeout:5000}).toBeNull()
    await expect(projectAvatars(bob.page)).toHaveCount(1)
    await expect(projectAvatars(bob.page)).toHaveCount(0)
    await expect(bob.page.locator('#project-presence')).toBeHidden()
  } finally {await Promise.all([alice.context.close(),bob.context.close()])}
})

test('profile and response location changes update immediately without replacing the user avatar', async ({browser})=>{
  const state=metadata(),slug=`presence-profile-${Date.now()}`
  const alice=await person(browser,'Alice',state),bob=await person(browser,'Bob',state)
  try {
    await Promise.all([openReview(alice.page,slug),openReview(bob.page,slug)])
    await selectStart(bob.page)
    await expect(responseAvatars(alice.page)).toHaveCount(1)
    await openRoster(alice.page)
    await alice.page.evaluate(()=>{window.originalPeerAvatar=document.querySelector('#project-presence-avatars .project-presence-avatar')})
    await bob.page.locator('#collab-name').click()
    await bob.page.locator('#name-input').fill('Bob Researcher')
    await bob.page.locator('input[name="profile-color"][value="#059669"]').check({force:true})
    await bob.page.locator('#save-name').click()
    await expect(projectAvatars(alice.page)).toHaveAttribute('title','Bob Researcher')
    await expect(projectAvatars(alice.page)).toHaveText('BR')
    await expect(projectAvatars(alice.page)).toHaveCSS('background-color','rgb(5, 150, 105)')
    await bob.page.locator('#reviewer-nav [data-action=open-document][data-id=doc2]').click()
    await expect(rosterPerson(alice.page,'Bob Researcher').locator('.project-presence-location')).toContainText('Common response')
    await expect(responseAvatars(alice.page)).toHaveCount(0,{timeout:900})
    expect(await alice.page.evaluate(()=>window.originalPeerAvatar===document.querySelector('#project-presence-avatars .project-presence-avatar'))).toBe(true)
    await expect(projectAvatars(alice.page)).toHaveCount(1)
  } finally {await Promise.all([alice.context.close(),bob.context.close()])}
})

test('Paper and Rebuttal switches publish atomic awareness snapshots and inactive iframes do not publish', async ({browser})=>{
  const state=metadata(),slug=`presence-surface-${Date.now()}`
  const alice=await person(browser,'Alice',state),bob=await person(browser,'Bob',state)
  try {
    await openReview(alice.page,slug)
    await openPaper(bob.page,slug)
    await selectStart(bob.page,bob.page.locator('#editor-view .cm-content'))
    await expect.poll(async()=> (await peerState(alice.page,'Bob'))?.workspace?.surface).toBe('paper')
    for(const page of [alice.page,bob.page])await page.evaluate(()=>{
      const session=window.PaperWorkspaceSharedSession || window.PaperRebuttalSession,awareness=session.provider.awareness
      window.presenceSnapshots=[]
      const record=()=>{
        const peer=[...awareness.getStates().values()].find(peer=>peer.user?.name==='Bob')
        if(peer?.workspace?.surface)window.presenceSnapshots.push(JSON.parse(JSON.stringify(peer)))
      }
      awareness.on('change',record);record()
    })
    const frame=bob.page.frameLocator('.paper-review-frame')
    for(let index=0;index<2;index++) {
      await bob.page.locator('#open-rebuttal').click()
      await expect(frame.locator('#response-editor .cm-content')).toBeVisible()
      await selectStart(bob.page,frame.locator('#response-editor .cm-content'))
      await expect(remoteCaret(alice.page)).toHaveCount(1)
      await frame.locator('#manuscript-link').click()
      await expect(bob.page.locator('#editor-view .cm-content')).toBeVisible()
      await expect.poll(async()=> (await peerState(alice.page,'Bob'))?.workspace?.surface).toBe('paper')
      await bob.page.evaluate(()=>document.querySelector('.paper-review-frame').contentWindow.document.dispatchEvent(new Event('visibilitychange')))
      await selectStart(bob.page,bob.page.locator('#editor-view .cm-content'),index+3)
      await expect(remoteCaret(alice.page)).toHaveCount(0)
    }
    for(const page of [alice.page,bob.page]) {
      const snapshots=await page.evaluate(()=>window.presenceSnapshots)
      expect(new Set(snapshots.map(peer=>peer.workspace.surface))).toEqual(new Set(['paper','rebuttal']))
      const mixed=snapshots.filter(peer=>{
        const workspace=peer.workspace
        if(workspace.surface==='paper')return Boolean(peer.rebuttal) || Boolean(peer.cursor && peer.cursor.active_file!==workspace.file)
        return Boolean(peer.cursor) || Boolean(workspace.visible && workspace.screen==='reviews' && (!peer.rebuttal || peer.rebuttal.roundId!==workspace.roundId || peer.rebuttal.documentId!==workspace.documentId))
      })
      expect(mixed).toEqual([])
    }
    await openPaper(alice.page,slug)
    await selectStart(bob.page,bob.page.locator('#editor-view .cm-content'))
    await expect(alice.page.locator('#remote-cursors .remote-caret')).toHaveCount(1)
    await alice.page.evaluate(()=>{
      const caret=document.querySelector('#remote-cursors .remote-caret'),label=caret.querySelector('.remote-cursor-label')
      window.paperCursorNodes={caret,label,text:label.firstChild}
    })
    // This extra awareness field sends a real peer update with identical
    // cursor, name, color and location, exercising the normal render path.
    await bob.page.evaluate(()=>{
      const awareness=window.PaperWorkspaceSharedSession.provider.awareness,local=awareness.getLocalState()
      awareness.setLocalState({...local,user:{...local.user,presenceTestHeartbeat:1}})
    })
    await expect.poll(async()=> (await peerState(alice.page,'Bob'))?.user?.presenceTestHeartbeat).toBe(1)
    expect(await alice.page.evaluate(()=>{
      const saved=window.paperCursorNodes,caret=document.querySelector('#remote-cursors .remote-caret')
      return saved.caret===caret && saved.label===caret.querySelector('.remote-cursor-label') && saved.text===saved.label.firstChild
    })).toBe(true)
  } finally {await Promise.all([alice.context.close(),bob.context.close()])}
})

test('same-user tabs appear once in the project and follow the active response after returning', async ({browser})=>{
  const state=metadata(),slug=`presence-tabs-${Date.now()}`
  const alice=await person(browser,'Alice',state),bob=await person(browser,'Bob',state)
  try {
    await Promise.all([openReview(alice.page,slug),openReview(bob.page,slug)])
    const other=await bob.context.newPage()
    await openReview(other,slug)
    expect(await other.evaluate(()=>localStorage.getItem('collab-id'))).toBe(await bob.page.evaluate(()=>localStorage.getItem('collab-id')))
    await simulateVisibility(bob.page,false)
    await other.locator('#reviewer-nav [data-action=open-document][data-id=doc2]').click()
    await selectStart(other)
    await expect(projectAvatars(alice.page)).toHaveCount(1)
    await openRoster(alice.page)
    await expect(rosterPerson(alice.page,'Bob').locator('.project-presence-location')).toContainText('Common response')
    // A hidden tab still belongs to its response even when another tab is the
    // user's representative in the project roster.
    await expect(responseAvatars(alice.page)).toHaveCount(1)
    await bob.page.locator('#reviewer-nav [data-action=open-document][data-id=doc2]').click()
    await expect(responseAvatars(alice.page)).toHaveCount(0)
    await simulateVisibility(other,false)
    await simulateVisibility(bob.page,true)
    await bob.page.locator('#reviewer-nav [data-action=open-review][data-id=reviewer1]').click()
    await selectStart(bob.page)
    await expect(projectAvatars(alice.page)).toHaveCount(1)
    await expect(rosterPerson(alice.page,'Bob')).toHaveCount(1)
    await expect(rosterPerson(alice.page,'Bob').locator('.project-presence-location')).toContainText('Response to Reviewer A')
    await expect(responseAvatars(alice.page)).toHaveCount(1)
    await expect(remoteCaret(alice.page)).toHaveCount(1)
    await expect(remoteCaret(alice.page).locator('.cm-remoteCaret-label')).toHaveText('Bob')
  } finally {await Promise.all([alice.context.close(),bob.context.close()])}
})
