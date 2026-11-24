const initial = '';
const {backupItems,backupProjectId:backupManifestId,baseName,buildCompilePayload,cleanSegment,compactSourceSnapshot,compareBackupFiles,compileAssetExtensions,compileTextExtensions,compilePayloadFingerprint,constrain,extensionOf,extractBackupSnapshot,isCompileAssetPath,isCompileInputPath,manifestItemIsAsset,normalizeManifest,normalizeState,parallelLimit,parentPath,parseLatexDiagnostics:parseCompileDiagnostics,projectFileUrl:buildProjectFileUrl,runtimeFileRevision,serverManagedManifestItems,sourceFingerprint,sourceSnapshotMatches,storedJson,validateBackupSnapshot}=window.PaperWorkspaceCore;
const {createWorkspacePersistence,workspaceAssetStore}=window.PaperWorkspaceStorage;
const preferences=window.PaperPreferenceStorage;
const projectRouteMatch=location.pathname.match(/^\/p\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/|$)/);
const projectSlug=projectRouteMatch?.[1]||'default';
document.getElementById('open-rebuttal').addEventListener('click',()=>{try{sessionStorage.setItem(`paper-project-title:${projectSlug}`,document.getElementById('project-title').value)}catch{}});
let retainedReviewURL=null;
function localizeWorkspaceNavigation(){const ko=window.PaperI18n?.getLanguage()==='ko',language=ko?'ko':'en',projectPath=`/p/${encodeURIComponent(projectSlug)}`;document.getElementById('manuscript-link').textContent='Paper';document.getElementById('manuscript-link').href=`${projectPath}?lang=${language}`;document.getElementById('open-rebuttal').textContent='Rebuttal';const reviewURL=new URL(retainedReviewURL||`${projectPath}/rebuttal`,location.origin);reviewURL.searchParams.set('lang',language);document.getElementById('open-rebuttal').href=reviewURL.href}
localizeWorkspaceNavigation();window.PaperI18n?.onChange(localizeWorkspaceNavigation);
let rebuttalBackupAdapter=null;
function rebuttalBackup(){return rebuttalBackupAdapter??=(window.PaperRebuttalBackup&&collabSession?window.PaperRebuttalBackup.create({projectSlug,session:collabSession}):null)}
const accountReadOnly=Boolean(window.PaperAccess)&&!['owner','editor'].includes(window.PaperAccess.projects?.[projectSlug]);
const projectBase=projectSlug==='default'?'':`/p/${encodeURIComponent(projectSlug)}`;
const projectStorageKey=`paper-workspace:${projectSlug}`;
const mainCompilePreferenceKey=`paper-workspace:pin-main:${projectSlug}`;
let mainCompilePinned=preferences.get(mainCompilePreferenceKey)==='true';
const compileStateStorageKey=`paper-workspace:compile-state:${projectSlug}`;
const compileClientStorageKey='paper-workspace:compile-client';
let compileClientId='';
try{compileClientId=sessionStorage.getItem(compileClientStorageKey)||'';if(!/^[A-Za-z0-9_-]{16,80}$/.test(compileClientId)){compileClientId=crypto.randomUUID();sessionStorage.setItem(compileClientStorageKey,compileClientId)}}catch{compileClientId=crypto.randomUUID()}
let compileStateId='';
try{const storedCompileState=sessionStorage.getItem(compileStateStorageKey)||'';if(/^[0-9a-f]{32}$/.test(storedCompileState))compileStateId=storedCompileState}catch{}
function setCompileStateId(value){compileStateId=/^[0-9a-f]{32}$/.test(String(value||''))?String(value):'';try{if(compileStateId)sessionStorage.setItem(compileStateStorageKey,compileStateId);else sessionStorage.removeItem(compileStateStorageKey)}catch{}}
const legacyState=storedJson('paper-workspace',storedJson('aaai-workspace',{}));
const parsedState=storedJson(projectStorageKey,projectSlug==='aaai27'?legacyState:{});
const localStateHadFiles=Boolean(parsedState?.files&&typeof parsedState.files==='object'&&Object.values(parsedState.files).some(value=>typeof value==='string'&&value.length));
const state=normalizeState(parsedState,initial);
let projectBootstrapComplete=false;
let paperReviewActive=/^\/p\/[^/]+\/rebuttal(?:\/|$)/.test(location.pathname)||new URLSearchParams(location.search).get('view')==='reviews';
let projectTitleStartupPending=true;
const bootstrapEdits=new Map();
function ensureFileTreePreferences(){if(state.fileTreePreferencesVersion!==1){if(!state.collapsedFolders.includes('paper/drafts'))state.collapsedFolders.push('paper/drafts');state.fileTreePreferencesVersion=1}}
ensureFileTreePreferences();
const workspaceStorageTimeoutMs=Number.isFinite(Number(window.__paperWorkspaceStorageTimeoutMs))&&Number(window.__paperWorkspaceStorageTimeoutMs)>=50?Number(window.__paperWorkspaceStorageTimeoutMs):2000;
const workspacePersistence=createWorkspacePersistence({project:projectSlug,storageKey:projectStorageKey,parsedState,state,initial,hadLegacyFiles:localStateHadFiles,legacyKeys:projectSlug==='aaai27'?['paper-workspace','aaai-workspace']:[],ensureState:ensureFileTreePreferences,snapshot:()=>persistedState(),compactSnapshot:()=>persistedState({compactDrafts:true}),setStatus:value=>{$('save-state').textContent=value},reportError:(error,scope)=>reportClientError(error,scope),timeoutMs:workspaceStorageTimeoutMs});
const localAssetStore=workspaceAssetStore(projectSlug,'paper-workspace-assets',{timeoutMs:workspaceStorageTimeoutMs});
async function storeLocalAsset(path,asset){await localAssetStore.put(path,asset)}
async function deleteLocalAsset(path){await localAssetStore.delete(path)}
async function loadLocalAssets(){for(const record of await localAssetStore.list())state.assets[record.path]=record.asset}
async function reconcileLocalAssets(obsoletePaths,nextPaths=[]){
  await Promise.all(nextPaths.filter(path=>state.assets[path]?.data).map(path=>storeLocalAsset(path,state.assets[path])));
  await Promise.all(obsoletePaths.filter(path=>!state.assets[path]).map(path=>deleteLocalAsset(path)));
}
const encodeProjectPath=path=>String(path).split('/').map(encodeURIComponent).join('/');
function serverAssetUrl(path=''){return `/api/backups/projects/${backupProjectId()}/assets${path?`/${encodeProjectPath(path)}`:''}`}
const mainPageCountPath='__paper_workspace/main-page-count.json';
const persistedPreviewPattern=/^__paper_workspace\/preview-([0-9a-f]{64})\.(pdf|synctex\.gz)$/;
let persistedPreviewAssets=[],workspaceReadyForCompile=false,workspaceContentRevision=0;
async function loadServerAssets(){const response=await fetch(serverAssetUrl(),{headers:{Accept:'application/json'},cache:'no-store'});if(!response.ok)throw new Error('공유 자산 목록을 불러오지 못했습니다.');const result=await response.json();persistedPreviewAssets=[];for(const item of Array.isArray(result.assets)?result.assets:[]){if(typeof item?.path!=='string'||item.path===mainPageCountPath||item.path.startsWith('rebuttal/sources/'))continue;if(persistedPreviewPattern.test(item.path)){persistedPreviewAssets.push(item);continue}const existing=state.assets[item.path]||{};state.assets[item.path]={...existing,type:existing.type||(extensionOf(item.path)==='pdf'?'application/pdf':'application/octet-stream'),size:Number(item.size_bytes)||existing.size||0,server:true};state.uploads=[...new Set([item.path,...state.uploads])]}}
async function uploadServerAsset(path,body,type='application/octet-stream'){const response=await fetch(serverAssetUrl(path),{method:'PUT',headers:{'Content-Type':type||'application/octet-stream'},body});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||`${baseName(path)} 서버 업로드 실패`);return result.asset}
async function deleteServerAsset(path){const response=await fetch(serverAssetUrl(path),{method:'DELETE'});if(!response.ok&&response.status!==404){const result=await response.json().catch(()=>({}));throw new Error(result.error||`${baseName(path)} 서버 삭제 실패`)}}
async function copyServerAsset(source,destination,asset){const loaded=asset.data?asset:await ensureAssetLoaded(source);await uploadServerAsset(destination,assetDataUrlBytes(loaded.data),loaded.type)}
async function moveServerAssetsSafely(moves){
  const copied=[];
  try{
    for(const {source,destination,asset} of moves){await copyServerAsset(source,destination,asset);copied.push(destination)}
  }catch(error){
    await Promise.all(copied.map(path=>deleteServerAsset(path).catch(()=>{})));
    throw error
  }
  const cleanup=await Promise.allSettled(moves.map(({source})=>deleteServerAsset(source)));
  if(cleanup.some(result=>result.status==='rejected'))notify('이름 변경은 완료했지만 이전 서버 사본 일부를 정리하지 못했습니다. 원본 데이터는 보존되었습니다.',{title:'공유 자료 정리 대기',tone:'warning'})
}
function base64Bytes(value){return Uint8Array.from(atob(value),character=>character.charCodeAt(0))}
function bytesBase64(value){let binary='';const bytes=value instanceof Uint8Array?value:new Uint8Array(value);for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));return btoa(binary)}
function previewCachePairs(){const pairs=new Map();for(const item of persistedPreviewAssets){const match=item.path.match(persistedPreviewPattern);if(!match)continue;const pair=pairs.get(match[1])||{fingerprint:match[1],modified_at:item.modified_at||''};pair[match[2]==='pdf'?'pdfPath':'synctexPath']=item.path;if(String(item.modified_at||'')>pair.modified_at)pair.modified_at=item.modified_at;pairs.set(match[1],pair)}return [...pairs.values()].filter(pair=>pair.pdfPath&&pair.synctexPath).sort((a,b)=>String(b.modified_at).localeCompare(String(a.modified_at)))}
async function fetchPersistedPdfPreview(fingerprint='',signal){const pair=fingerprint?previewCachePairs().find(item=>item.fingerprint===fingerprint):previewCachePairs()[0];if(!pair)return null;const [pdfResponse,synctexResponse]=await Promise.all([fetch(serverAssetUrl(pair.pdfPath),{cache:'no-store',signal}),fetch(serverAssetUrl(pair.synctexPath),{cache:'no-store',signal})]);if(!pdfResponse.ok||!synctexResponse.ok)return null;const binary=new Uint8Array(await pdfResponse.arrayBuffer()),synctex=new Uint8Array(await synctexResponse.arrayBuffer());if(new TextDecoder().decode(binary.subarray(0,5))!=='%PDF-'||synctex[0]!==0x1f||synctex[1]!==0x8b)return null;return {...pair,binary,synctex:bytesBase64(synctex)}}
async function persistMainPageCount(payload){
  const pageCount=activePdfDocument?.numPages;
  if(accountReadOnly||payload.entrypoint!==projectManifest.entrypoint||payload.preview_mode!=='document'||!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>1000)return;
  const response=await fetch(serverAssetUrl(mainPageCountPath),{method:'PUT',headers:{'Content-Type':'application/json'},keepalive:true,body:JSON.stringify({page_count:pageCount,entrypoint:payload.entrypoint})});
  if(!response.ok)throw new Error('논문 목록 페이지 수를 저장하지 못했습니다.');
}
async function persistPdfPreview(binary,synctex,fingerprint){
  if(accountReadOnly)return;
  if(!fingerprint||!synctex)return;
  const pdfPath=`__paper_workspace/preview-${fingerprint}.pdf`,synctexPath=`__paper_workspace/preview-${fingerprint}.synctex.gz`,uploaded=[];
  try{
    await uploadServerAsset(pdfPath,binary,'application/pdf');uploaded.push(pdfPath);
    await uploadServerAsset(synctexPath,base64Bytes(synctex),'application/gzip');uploaded.push(synctexPath)
  }catch(error){
    await Promise.all(uploaded.map(path=>deleteServerAsset(path).catch(()=>{})));
    throw error
  }
  persistedPreviewAssets=[...persistedPreviewAssets.filter(item=>!new Set([pdfPath,synctexPath]).has(item.path)),{path:pdfPath,modified_at:new Date().toISOString(),size_bytes:binary.length},{path:synctexPath,modified_at:new Date().toISOString(),size_bytes:synctex.length}];
  const obsolete=previewCachePairs().slice(4).flatMap(pair=>[pair.pdfPath,pair.synctexPath]);
  await Promise.all(obsolete.map(path=>deleteServerAsset(path).catch(()=>{})))
}
state.serverSourceSnapshots||={};
let projectManifest={id:'default',version:'unversioned',entrypoint:'main.tex',files:[{path:'main.tex',managed:true}]};
function isLockedProjectFile(path=state.current){if(accountReadOnly)return true;const relative=String(path||'').replace(/^paper\//,'');return projectManifest.files.some(item=>item.path===relative&&item.locked===true)}
const remoteAssetPaths=new Set();
const remoteAssetSources=new Map();
const $ = id => document.getElementById(id); const esc = value => String(value??'').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const statusCenter=window.PaperSidebarAccount.createStatusPanel({content:$('paper-status-content').content.cloneNode(true)});
let sourceConflictDismissed=false;
const sourceConflictBanner=$('source-conflict');
$('close-source-conflict').onclick=()=>{sourceConflictDismissed=true;sourceConflictBanner.hidden=true};
function configuredTimeout(name,fallback){const value=Number(window[name]);return Number.isFinite(value)&&value>=50?value:fallback}
const collaborationWatchdogMs=configuredTimeout('__paperCollaborationWatchdogMs',8000);
const compileRequestTimeoutMs=configuredTimeout('__paperCompileRequestTimeoutMs',40000);
const serverSourcePollMs=configuredTimeout('__paperServerSourcePollMs',10000);
let richEditor=null;
function initializeRichEditor(){
  const textarea=$('editor');
  try{
    if(!window.PaperEditor?.createEditor)throw new Error('CodeMirror 번들을 불러오지 못했습니다.');
    richEditor=window.PaperEditor.createEditor({parent:$('editor-view'),value:textarea.value,onChange:value=>{if(isLockedProjectFile())return;textarea.value=value;state.files[state.current]=value;textarea.dispatchEvent(new Event('input',{bubbles:true}))},onSelection:()=>{sendCursor();renderRemoteCursors();renderCommentAnchors()},onScroll:()=>textarea.dispatchEvent(new Event('scroll'))});
  }catch(error){
    console.error('Professional editor initialization failed; using textarea fallback.',error);
    $('editor-panel').classList.add('legacy-editor');textarea.hidden=false;
    richEditor={dom:textarea,contentDOM:textarea,scrollDOM:textarea,getValue:()=>textarea.value,setValue:value=>{textarea.value=String(value??'')},setDocument:(_path,value)=>{textarea.value=String(value??'')},getSelection:()=>({start:textarea.selectionStart,end:textarea.selectionEnd}),setSelection:(start,end=start)=>textarea.setSelectionRange(start,end),focus:()=>textarea.focus(),replaceRange:(replacement,start,end,select=true)=>{textarea.setRangeText(replacement,start,end,select?'select':'preserve');textarea.dispatchEvent(new Event('input',{bubbles:true}))},coordsAt:()=>null,lineAt:position=>({from:0,to:position}),scrollTo:()=>{},setFontSize:size=>textarea.style.fontSize=size,focusWithin:()=>document.activeElement===textarea,destroy:()=>{}};
    notify('전문 편집기를 시작하지 못해 기본 편집기로 복구했습니다. 원고는 정상적으로 불러옵니다.',{title:'편집기 호환 모드'});
  }
}
const editorValue=()=>richEditor?richEditor.getValue():$('editor').value;
function setEditorValue(value){$('editor').value=String(value??'');richEditor?.setValue(value)}
const editorSelection=()=>richEditor?richEditor.getSelection():{start:$('editor').selectionStart,end:$('editor').selectionEnd};
function setEditorSelection(start,end=start,{scroll=false}={}){richEditor?.setSelection(start,end,{scroll})}
function focusEditor(){richEditor?.focus()}
function notify(message,{title='',tone=''}={}){const container=$('app-toasts');if(!container)return;const toast=document.createElement('div');toast.className=`app-toast ${tone}`.trim();toast.innerHTML=`${title?`<strong>${esc(title)}</strong>`:''}<span>${esc(String(message))}</span>`;container.append(toast);requestAnimationFrame(()=>toast.classList.add('visible'));let timer=0;const dismiss=()=>{clearTimeout(timer);toast.classList.remove('visible');toast.classList.add('leaving');setTimeout(()=>toast.remove(),180)};const schedule=delay=>{clearTimeout(timer);timer=setTimeout(dismiss,delay)};schedule(5200);toast.addEventListener('pointerenter',()=>clearTimeout(timer));toast.addEventListener('pointerleave',()=>schedule(900))}
function actionDialog({title,message='',value=null,confirmLabel='확인',tone='default'}){const dialog=$('action-dialog'),input=$('action-dialog-input');$('action-dialog-title').textContent=title;$('action-dialog-message').textContent=message;$('action-dialog-confirm').textContent=confirmLabel;$('action-dialog-confirm').classList.toggle('danger',tone==='danger');input.hidden=value===null;input.value=value??'';return new Promise(resolve=>{dialog.addEventListener('close',()=>{resolve(dialog.returnValue==='confirm'?(value===null?true:input.value):value===null?false:null)},{once:true});window.PaperUI.openDialog(dialog);if(value!==null){input.focus();input.select()}})}
window.alert=message=>notify(message,{tone:/실패|오류|못했습니다|failed|error|could not/i.test(String(message))?'error':''});
function mathPreview(value){const symbols={alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',lambda:'λ',mu:'μ',nu:'ν',pi:'π',rho:'ρ',sigma:'σ',tau:'τ',phi:'φ',omega:'ω',Gamma:'Γ',Delta:'Δ',Lambda:'Λ',Sigma:'Σ',Phi:'Φ',Omega:'Ω',in:'∈',notin:'∉',times:'×',cdot:'·',le:'≤',leq:'≤',ge:'≥',geq:'≥',neq:'≠',approx:'≈',to:'→',rightarrow:'→',leftarrow:'←',top:'⊤',infty:'∞',pm:'±'};let math=value.replace(/\\mathbb\{R\}/g,'ℝ').replace(/\\mathbb\{C\}/g,'ℂ').replace(/\\mathbb\{N\}/g,'ℕ').replace(/\\mathbf\{([^{}]*)\}/g,'<strong>$1</strong>').replace(/\\mathrm\{([^{}]*)\}/g,'<span class="math-roman">$1</span>').replace(/\\operatorname\{([^{}]*)\}/g,'<span class="math-roman">$1</span>').replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g,'<span class="math-frac"><span>$1</span><span>$2</span></span>').replace(/\\([A-Za-z]+)/g,(match,name)=>symbols[name]||name);for(let index=0;index<3;index+=1)math=math.replace(/\^\{([^{}]*)\}/g,'<sup>$1</sup>').replace(/_\{([^{}]*)\}/g,'<sub>$1</sub>');return math.replace(/\^([A-Za-z0-9ℝℂℕα-ωΑ-Ω])/g,'<sup>$1</sup>').replace(/_([A-Za-z0-9ℝℂℕα-ωΑ-Ω]+)/g,'<sub>$1</sub>').replace(/[{}]/g,'')}
function latexPreview(value){const normalized=String(value??'').replace(/\r\n?/g,'\n').replace(/\n\s*\n+/g,'\u0000').replace(/\s*\n\s*/g,' ');let html=esc(normalized);const commands=[['emph','em'],['textit','em'],['textbf','strong'],['texttt','code'],['underline','u']];for(const [command,tag] of commands)html=html.replace(new RegExp(`\\\\${command}\\{([^{}]*)\\}`,'g'),`<${tag}>$1</${tag}>`);html=html.replace(/\\cite(?:t|p)?\{([^{}]+)\}/g,(_,keys)=>`<span class="latex-citation">${keys.split(',').map(key=>`[${key.trim()}]`).join(' ')}</span>`).replace(/\$([^$\n]+)\$/g,(_,math)=>`<span class="latex-math">${mathPreview(math)}</span>`).replace(/\\(?:pac|prl)\b/g,match=>match==='\\pac'?'PAC':'PRL').replace(/\\%/g,'%').replace(/\\_/g,'_').replace(/~/g,' ').replace(/\\\\/g,'<br>').replace(/\u0000/g,'<br><br>');return html}
const layoutKey='paper-workspace-layout';
const defaultLayout={editorWidth:null,assistantWidth:292,assistantCollapsed:false,sidebarWidth:244,sidebarCollapsed:false,editorZoom:1,pdfZoom:1};
const storedLayout=storedJson(layoutKey,{});
const layout={...defaultLayout,...storedLayout};
if(typeof storedLayout.assistantCollapsed!=='boolean'&&innerWidth<1600)layout.assistantCollapsed=true;
const minEditorWidth=390, minPreviewWidth=390, minAssistantWidth=240, maxAssistantWidth=500, minSidebarWidth=180, maxSidebarWidth=320, resizerWidth=20;
function persistLayout(){preferences.set(layoutKey,JSON.stringify(layout))}
function assistantOverlayNeeded(){return innerWidth>1180&&document.querySelector('.workspace').clientWidth<minEditorWidth+minPreviewWidth+minAssistantWidth+resizerWidth}
function layoutLimits(){const workspace=$('workspace')||document.querySelector('.workspace');const width=workspace.clientWidth,overlay=assistantOverlayNeeded(),freeAssistantSpace=layout.assistantCollapsed||overlay,assistantSpace=freeAssistantSpace?0:(layout.assistantWidth||defaultLayout.assistantWidth),dividers=freeAssistantSpace?resizerWidth/2:resizerWidth;const assistantMax=Math.min(maxAssistantWidth,overlay?width:width-minEditorWidth-minPreviewWidth-resizerWidth);return {editorMax:Math.max(minEditorWidth,width-assistantSpace-minPreviewWidth-dividers),assistantMax:Math.max(minAssistantWidth,assistantMax)};}
function updateResizerAria(){const limits=layoutLimits();document.querySelectorAll('.panel-resizer').forEach(resizer=>{const assistant=resizer.dataset.resize==='preview-assistant';const value=assistant?layout.assistantWidth:(layout.editorWidth||Math.round($('editor-panel').getBoundingClientRect().width));resizer.setAttribute('aria-valuenow',String(Math.round(value)));resizer.setAttribute('aria-valuemin',String(assistant?minAssistantWidth:minEditorWidth));resizer.setAttribute('aria-valuemax',String(Math.round(assistant?limits.assistantMax:limits.editorMax)));});const sidebar=$('sidebar-resizer');sidebar.setAttribute('aria-valuenow',String(Math.round(layout.sidebarWidth)));sidebar.setAttribute('aria-valuemin',String(minSidebarWidth));sidebar.setAttribute('aria-valuemax',String(maxSidebarWidth))}
function assistantVisible(){return !layout.assistantCollapsed&&(innerWidth>1180||document.querySelector('.shell').dataset.focus==='assistant')}
function updateAssistantToggle(){const collapsed=Boolean(layout.assistantCollapsed),visible=assistantVisible(),button=$('toggle-assistant'),workspace=document.querySelector('.workspace');workspace.classList.toggle('assistant-collapsed',collapsed);workspace.classList.toggle('assistant-overlay',!collapsed&&assistantOverlayNeeded());button.title=visible?'논문 도우미 접기':'논문 도우미 펼치기';button.setAttribute('aria-label',button.title);button.setAttribute('aria-expanded',String(visible));}
function updateSidebarToggle(){const collapsed=Boolean(layout.sidebarCollapsed);document.querySelector('.shell').classList.toggle('sidebar-collapsed',collapsed);window.PaperUI.updateSidebarToggle($('toggle-sidebar'),collapsed)}
window.addEventListener('paper-language-change',updateSidebarToggle);
function applyPdfViewerZoom(){const viewer=document.querySelector('.pdf-canvas-viewer');if(viewer)viewer.style.zoom=String(layout.pdfZoom)}
function applyZoomControls(){layout.editorZoom=constrain(Number(layout.editorZoom)||1,.7,1.7);layout.pdfZoom=constrain(Number(layout.pdfZoom)||1,.55,2);richEditor?.setFontSize(`${14*layout.editorZoom}px`);$('editor-zoom-value').textContent=`${Math.round(layout.editorZoom*100)}%`;$('pdf-zoom-value').textContent=`${Math.round(layout.pdfZoom*100)}%`;$('editor-zoom-out').disabled=layout.editorZoom<=.7;$('editor-zoom-in').disabled=layout.editorZoom>=1.7;$('pdf-zoom-out').disabled=layout.pdfZoom<=.55;$('pdf-zoom-in').disabled=layout.pdfZoom>=2;applyPdfViewerZoom()}
function applyLayoutNow({persist=false}={}){const workspace=document.querySelector('.workspace'),shell=document.querySelector('.shell');layout.sidebarWidth=constrain(Number(layout.sidebarWidth)||defaultLayout.sidebarWidth,minSidebarWidth,maxSidebarWidth);shell.style.setProperty('--sidebar-width',`${layout.sidebarWidth}px`);updateSidebarToggle();const limits=layoutLimits();layout.assistantWidth=constrain(Number(layout.assistantWidth)||defaultLayout.assistantWidth,minAssistantWidth,limits.assistantMax);if(layout.editorWidth!==null)layout.editorWidth=constrain(Number(layout.editorWidth),minEditorWidth,limits.editorMax);workspace.style.setProperty('--assistant-width',`${layout.assistantWidth}px`);if(layout.editorWidth!==null)workspace.style.setProperty('--editor-width',`${layout.editorWidth}px`);else workspace.style.removeProperty('--editor-width');updateAssistantToggle();applyZoomControls();updateResizerAria();renderRemoteCursors();renderCommentAnchors();if(persist)persistLayout();if(document.documentElement.classList.contains('paper-layout-starting'))requestAnimationFrame(()=>requestAnimationFrame(()=>document.documentElement.classList.remove('paper-layout-starting')))}
let layoutAnimationFrame=0;
function applyLayout(options={}){if(options.persist){if(layoutAnimationFrame)cancelAnimationFrame(layoutAnimationFrame);layoutAnimationFrame=0;applyLayoutNow(options);return}if(layoutAnimationFrame)return;layoutAnimationFrame=requestAnimationFrame(()=>{layoutAnimationFrame=0;applyLayoutNow()})}
let focusBeforeAssistant='source';
// The preloaded Rebuttal view shares only the sidebar portion of the layout.
window.addEventListener('storage',event=>{
  if(event.key!==layoutKey || !event.newValue)return;
  try{const next=JSON.parse(event.newValue);if(typeof next.sidebarCollapsed!=='boolean')return;const width=Number(next.sidebarWidth);layout.sidebarCollapsed=next.sidebarCollapsed;if(Number.isFinite(width)&&width>0)layout.sidebarWidth=constrain(width,minSidebarWidth,maxSidebarWidth);applyLayout()}catch{}
});
function setAssistantCollapsed(collapsed,{persist=true}={}){window.PaperUI.cancelSidebarMotion();const focusInside=$('assistant-panel').contains(document.activeElement);layout.assistantCollapsed=collapsed;if(collapsed&&innerWidth<=1180&&document.querySelector('.shell').dataset.focus==='assistant')activateFocusMode(focusBeforeAssistant);applyLayout({persist});if(collapsed&&focusInside){if(innerWidth<768)$('focus-modes').querySelector(`[data-focus="${focusBeforeAssistant}"]`)?.focus();else $('toggle-assistant').focus()}}
function toggleAssistant(){if(assistantVisible())setAssistantCollapsed(true);else if(innerWidth<=1180)activateFocusMode('assistant');else setAssistantCollapsed(false)}
function resetLayout(){window.PaperUI.cancelSidebarMotion();layout.editorWidth=null;layout.assistantWidth=defaultLayout.assistantWidth;layout.assistantCollapsed=false;layout.sidebarWidth=defaultLayout.sidebarWidth;layout.sidebarCollapsed=false;layout.editorZoom=1;layout.pdfZoom=1;applyLayout({persist:true});}
function installPanelResizers(){
  const editorPanel=$('editor-panel'),assistantPanel=$('assistant-panel');
  document.querySelectorAll('.panel-resizer,.sidebar-resizer').forEach(resizer=>{
    const type=resizer.dataset.resize,direction=type==='preview-assistant'?-1:1;
    window.PaperUI.bindResizer({
      element:resizer,step:24,direction,enabled:()=>innerWidth>=768,
      onStart:()=>{if(type==='preview-assistant'&&layout.assistantCollapsed)setAssistantCollapsed(false,{persist:false});if(type==='sidebar'&&layout.sidebarCollapsed){layout.sidebarCollapsed=false;applyLayout()}},
      getValue:()=>type==='sidebar'?layout.sidebarWidth:type==='editor-preview'?(layout.editorWidth ?? editorPanel.getBoundingClientRect().width):layout.assistantWidth,
      getPointerValue:()=>type==='sidebar'?layout.sidebarWidth:type==='editor-preview'?editorPanel.getBoundingClientRect().width:assistantPanel.getBoundingClientRect().width,
      getLimits:()=>{const limits=layoutLimits();return type==='sidebar'?{min:minSidebarWidth,max:maxSidebarWidth}:type==='editor-preview'?{min:minEditorWidth,max:limits.editorMax}:{min:minAssistantWidth,max:limits.assistantMax}},
      fromPointer:(event,start)=>start.value+(event.clientX-start.x)*direction,
      onChange:value=>{if(type==='sidebar')layout.sidebarWidth=value;else if(type==='editor-preview')layout.editorWidth=value;else layout.assistantWidth=value;applyLayout()},
      onCommit:()=>applyLayout({persist:true})
    });
  });
  $('reset-layout').onclick=resetLayout;$('toggle-assistant').onclick=toggleAssistant;$('close-assistant').onclick=()=>setAssistantCollapsed(true);
  $('toggle-sidebar').onclick=()=>window.PaperUI.animateSidebarChange(()=>{layout.sidebarCollapsed=!layout.sidebarCollapsed;applyLayout({persist:true})});
  new ResizeObserver(()=>applyLayout()).observe(document.querySelector('.workspace'));applyLayout()
}

const looksLikeHtml=value=>typeof value==='string'&&/^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(value);
const isLatexDocument=value=>typeof value==='string'&&!looksLikeHtml(value)&&value.includes('\\documentclass')&&value.includes('\\begin{document}')&&value.includes('\\end{document}');
const isProjectSource=(name,value)=>{if(typeof value!=='string'||looksLikeHtml(value))return false;if(name==='paper/main.tex')return isLatexDocument(value);return value.trim().length>0};
function bibliographyEntries(value){const entries=[];const pattern=/@[A-Za-z]+\s*\{\s*([^,\s]+)\s*,[\s\S]*?(?=\n\s*@[A-Za-z]+\s*\{|\s*$)/g;for(const match of String(value||'').matchAll(pattern))entries.push({key:match[1].toLowerCase(),text:match[0].trim()});return entries}
function mergeBibliography(local,canonical){const localEntries=bibliographyEntries(local);const keys=new Set(localEntries.map(entry=>entry.key));const missing=bibliographyEntries(canonical).filter(entry=>!keys.has(entry.key));if(!missing.length)return local;return [String(local||'').trim(),...missing.map(entry=>entry.text)].filter(Boolean).join('\n\n')+'\n'}
async function sourceCacheWithin(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('source cache timeout')),500)})])}finally{clearTimeout(timer)}}
async function fetchProjectSource(name,path,{required=false,revision=''}={}){
  try{
    const canCache = /^[0-9a-f]{64}$/.test(revision) && typeof caches !== 'undefined' && Boolean(globalThis.crypto?.subtle)
    let cache, cacheKey
    if(canCache)try{
      cache=await sourceCacheWithin(caches.open('paper-workspace-project-sources-v1'))
      cacheKey=new URL(path,location.href);cacheKey.search='';cacheKey.hash=''
      const cached=await sourceCacheWithin(cache.match(cacheKey.href))
      if(cached?.headers.get('x-paper-source-revision')===revision){
        const bytes=await cached.arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')
        if(hash===revision)return new TextDecoder().decode(bytes)
      }
    }catch{cache=null}
    const response=await fetch(path,{headers:{Accept:'text/plain'},cache:'no-store'});
    if(!response.ok){const error=new Error(`project source request failed (${response.status})`);error.status=response.status;throw error}
    const contentType=response.headers.get('content-type')||'';
    if(contentType.toLowerCase().includes('text/html'))throw new Error('project source returned HTML');
    const bytes=await response.arrayBuffer()
    if(cache && cacheKey)try{
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')
      if(hash===revision)await sourceCacheWithin(cache.put(cacheKey.href,new Response(bytes,{headers:{'content-type':'text/plain; charset=utf-8','x-paper-source-revision':revision}})))
    }catch{}
    return new TextDecoder().decode(bytes)
  }catch(error){
    if(!required){if(error?.status!==404)reportClientError(error,`fetchOptionalProjectSource:${name}`);return null}
    const failure=new Error(`${name} 필수 프로젝트 소스를 불러오지 못했습니다.`);
    reportClientError(error,`fetchRequiredProjectSource:${name}`);
    throw failure
  }
}
function bytesToBase64(bytes){let binary='';const chunk=0x8000;for(let offset=0;offset<bytes.length;offset+=chunk)binary+=String.fromCharCode(...bytes.subarray(offset,Math.min(offset+chunk,bytes.length)));return btoa(binary)}
function projectFileUrl(path,manifest=projectManifest){return buildProjectFileUrl(projectBase,path,manifest)}
async function fetchPreviewArtifact(signal){if(!projectManifest.preview_pdf)return null;try{const pdfResponse=await fetch(projectFileUrl(projectManifest.preview_pdf),{cache:'no-store',signal});if(!pdfResponse.ok)return null;const binary=new Uint8Array(await pdfResponse.arrayBuffer());let synctex='';if(projectManifest.preview_synctex){const synctexResponse=await fetch(projectFileUrl(projectManifest.preview_synctex),{cache:'no-store',signal});if(synctexResponse.ok)synctex=bytesToBase64(new Uint8Array(await synctexResponse.arrayBuffer()))}return {binary,synctex}}catch{return null}}
function ensureFolder(path){if(!state.folders.includes(path))state.folders.push(path)}
const {palette:collaboratorPalette,normalize:normalizeDisplayName,valid:hasDisplayName,initial:collaboratorInitial}=window.PaperSidebarProfile;
function collaboratorColor(id){let hash=0;for(const character of id)hash=(hash*31+character.charCodeAt(0))|0;return collaboratorPalette[Math.abs(hash)%collaboratorPalette.length]}
const defaultActorName=window.PaperI18n?.getLanguage()==='ko'?'나':'Me';const actorId=window.PaperSidebarProfile.identity();const storedColor=preferences.get('collab-color');let storedActorName=preferences.get('collab-name');if(!preferences.get('collab-name-user-set')&&(storedActorName==='secondary_host'||storedActorName==='나'||storedActorName==='Me'))storedActorName=defaultActorName;const actor={id:actorId,name:normalizeDisplayName(storedActorName)||defaultActorName,color:collaboratorPalette.includes(storedColor)?storedColor:collaboratorColor(actorId)};preferences.set('collab-name',actor.name);preferences.set('collab-color',actor.color);$('collab-name').textContent=hasDisplayName(actor.name)?collaboratorInitial(actor.name):'?';$('collab-name').style.background=actor.color;$('collab-name').style.color=window.PaperUI.contrastTextFor(actor.color);const collaborators=new Map();
$('name-toast').hidden=true;
let projectActivityTimer=0,pendingProjectActivityReason='edit',suppressProjectActivity=false;
async function recordProjectActivity(reason=pendingProjectActivityReason){if(accountReadOnly)return;clearTimeout(projectActivityTimer);projectActivityTimer=0;if(!hasDisplayName(actor.name))return;pendingProjectActivityReason=reason;try{await fetch(`/api/backups/projects/${backupProjectId()}/activity`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor:actor.name,reason}),keepalive:true})}catch{}}
function markProjectActivity(reason='edit'){if(!hasDisplayName(actor.name))return;pendingProjectActivityReason=reason;preferences.set(`paper-workspace:last-active:${projectSlug}`,Date.now());clearTimeout(projectActivityTimer);projectActivityTimer=setTimeout(()=>recordProjectActivity(reason),900)}
function setEditorValueWithoutActivity(value){suppressProjectActivity=true;try{setEditorValue(value)}finally{suppressProjectActivity=false}}
window.addEventListener('pagehide',()=>{if(projectActivityTimer)recordProjectActivity(pendingProjectActivityReason)});
function collaboratorPosition(person){return Array.isArray(person.selection)?Math.max(0,Number(person.selection[1]??person.selection[0])||0):0}
function paperCollaboratorLocation(person){return person.workspace?.surface!=='rebuttal'&&person.workspace?.visible!==false}
function validPaperPresenceFile(file){return typeof file==='string'&&file.length>0&&file.length<=1024&&!/^[a-z][a-z\d+.-]*:/i.test(file)&&!/[\\\u0000-\u001f]/.test(file)&&file.split('/').every(part=>part&&part!=='.'&&part!=='..')}
function restorePaperPresenceLocation(){
  let location;
  try{const key=`paper-presence-location:${projectSlug}`,raw=sessionStorage.getItem(key);if(!raw)return;sessionStorage.removeItem(key);location=JSON.parse(raw)}catch{return}
  const validPosition=value=>typeof value==='string'&&value.length>0&&value.length<=16384&&/^[A-Za-z0-9+/]+={0,2}$/.test(value);
  if(!validPaperPresenceFile(location?.file)||!validPosition(location.anchorRelative)||!validPosition(location.headRelative))return;
  window.PaperWorkspaceFocusLocation?.(location).catch(()=>{});
}

function remoteCaretCoordinates(position){const coordinates=richEditor?.coordsAt(position),panel=$('editor-panel').getBoundingClientRect();if(!coordinates)return {left:0,top:-100,lineHeight:23};return {left:coordinates.left-panel.left,top:coordinates.top-panel.top-48,lineHeight:coordinates.bottom-coordinates.top||23}}
function syncHighlightCoordinates(position){
  const panel=$('editor-panel').getBoundingClientRect();
  const activeLine=richEditor?.dom?.querySelector('.cm-activeLine');
  if(activeLine){
    const line=activeLine.getBoundingClientRect();
    if(line.height>0)return {top:line.top-panel.top,height:line.height};
  }
  const coordinates=remoteCaretCoordinates(position),editor=$('editor');
  return {top:editor.offsetTop+coordinates.top,height:coordinates.lineHeight};
}
function showSourceSyncHighlight(position){
  const marker=$('sync-highlight'),coordinates=syncHighlightCoordinates(position);
  marker.style.top=`${coordinates.top}px`;
  marker.style.setProperty('--sync-highlight-height',`${coordinates.height}px`);
  marker.hidden=false;
  clearTimeout(window.syncHighlightTimer);
  window.syncHighlightTimer=setTimeout(()=>{marker.hidden=true},650);
}
const remoteCursorNodes=new Map();
function renderRemoteCursors(){
  const container=$('remote-cursors'),height=$('editor-view').clientHeight,active=new Set();
  for(const person of collaborators.values()){
    if(person.id===actor.id||!paperCollaboratorLocation(person)||person.workspace?.editing===false||person.active_file!==state.current||!Array.isArray(person.selection))continue;
    const coordinates=remoteCaretCoordinates(Math.min(collaboratorPosition(person),$('editor').value.length));
    if(coordinates.top<-coordinates.lineHeight||coordinates.top>height)continue;
    const key=String(person.clientId??person.id);active.add(key);
    let entry=remoteCursorNodes.get(key);
    if(!entry){
      const caret=document.createElement('span'),label=document.createElement('span');
      caret.className='remote-caret';label.className='remote-cursor-label';caret.append(label);container.append(caret);
      entry={caret,label,style:null,color:null};remoteCursorNodes.set(key,entry);
    }
    const style=JSON.stringify([coordinates.left,coordinates.top,coordinates.lineHeight]);
    if(style!==entry.style){entry.caret.style.left=`${coordinates.left}px`;entry.caret.style.top=`${coordinates.top}px`;entry.caret.style.height=`${coordinates.lineHeight}px`;entry.style=style}
    const color=person.color||collaboratorColor(person.id);
    if(color!==entry.color){entry.caret.style.setProperty('--cursor-color',color);entry.label.style.color=window.PaperUI.contrastTextFor(color);entry.color=color}
    if(entry.label.textContent!==person.name)entry.label.textContent=person.name;
  }
  for(const [key,entry] of remoteCursorNodes)if(!active.has(key)){entry.caret.remove();remoteCursorNodes.delete(key)}
}
let projectPresence;
function rebuttalPresenceView(){return document.querySelector('.paper-review-frame')?.contentWindow?.PaperRebuttal}
function describePresencePeer(peer){
  if(peer.workspace?.surface==='rebuttal' || (!peer.workspace?.surface && peer.rebuttal))return rebuttalPresenceView()?.describePeer?.(peer) || {label:'Rebuttal',available:false};
  const file=peer.workspace?.file || peer.cursor?.active_file;
  return {label:file?`Paper · ${file}`:(window.PaperI18n?.getLanguage()==='ko'?'접속 중':'Connected'),available:validPaperPresenceFile(file)&&Object.hasOwn(state.files,file)};
}
async function followPresencePeer(peer){
  if(peer.workspace?.surface==='rebuttal' || (!peer.workspace?.surface && peer.rebuttal)){
    const review=rebuttalPresenceView();if(!review?.followPeer)return false;
    $('open-rebuttal').click();return review.followPeer(peer);
  }
  if(!window.PaperWorkspaceFocusLocation)return false;
  return window.PaperWorkspaceFocusLocation({file:peer.workspace?.file || peer.cursor?.active_file,anchorRelative:peer.cursor?.anchor,headRelative:peer.cursor?.head});
}
function updatePresence(){
  if(window.PaperProjectPresence){
    projectPresence ||= window.PaperProjectPresence.create({host:$('project-presence-root'),describe:describePresencePeer,onFollow:followPresencePeer,onError:error=>notify(error.message,{title:'Collaboration'})});
    projectPresence.update({peers:window.PaperProjectPresence.readPeers(collabSession),selfId:actor.id,language:window.PaperI18n?.getLanguage(),connected:Boolean(collabSession?.provider?.wsconnected)});
  }
  renderRemoteCursors()
}
window.addEventListener('paper-language-change',updatePresence);

const collaborationRoom=`paper-workspace:${location.host}:${projectSlug}`;
let pendingCollabChanges=0,pendingCollabTimer=0;
function refreshOverallStatus(){const label=$('collab-label'),dot=$('collab-status'),toggle=$('status-center-toggle');if(!label||!dot)return;const english=window.PaperI18n?.getLanguage()!=='ko',rows=[...document.querySelectorAll('.status-center-list>div')],errorRow=rows.find(row=>row.dataset.health==='error'),warningRow=rows.find(row=>row.dataset.health==='warning'),hasPending=rows.some(row=>row.dataset.health==='pending'),problemRow=errorRow||warningRow,problemName=problemRow?.querySelector('strong')?.textContent||(english?'Status':'상태');const text=errorRow?(english?`${problemName} error`:`${problemName} 오류`):warningRow?(english?`${problemName} check`:`${problemName} 확인`):hasPending?(english?'In progress':'처리 중'):(english?'Healthy':'정상');const tone=errorRow?'error':warningRow?'warning':hasPending?'connecting':'';label.textContent=text;dot.className=`status-dot ${tone}`.trim();if(toggle)toggle.dataset.health=errorRow?'error':warningRow?'warning':hasPending?'pending':'healthy';const description=english?`Workspace status: ${text}. View details`:`작업공간 상태: ${text}. 세부정보 보기`;toggle?.setAttribute('aria-label',description);toggle?.setAttribute('title',description)}
function setCollaborationStatus(status,label){const health=$('health-collab'),icon=$('health-collab-icon');if(health){health.textContent=pendingCollabChanges?`${label.replace('공동 편집 ','')} · 변경 ${pendingCollabChanges}개`:label.replace('공동 편집 ','');health.closest('div').dataset.health=status==='offline'?'error':status==='connecting'?'pending':'ok'}if(icon)icon.className=`status-icon ${status}`.trim();if($('health-collab-action'))$('health-collab-action').hidden=status!=='offline';refreshOverallStatus()}
function markCollaborationChange(){pendingCollabChanges+=1;setCollaborationStatus(collabReady?'connecting':'offline',collabReady?'공동 편집 변경 전송 중':'공동 편집 오프라인 변경 보관 중');clearTimeout(pendingCollabTimer);pendingCollabTimer=setTimeout(()=>{if(collabReady){pendingCollabChanges=0;setCollaborationStatus('','공동 편집 동기화됨')}},650)}
let sharedText=null,sharedTextObserver=null,collabReady=false;
function createOfflineMap(){const map=new Map();map.observe=()=>{};map.unobserve=()=>{};map.observeDeep=()=>{};map.unobserveDeep=()=>{};return map}
function createOfflineCollaborationSession({onStatus}){
  const maps=new Map(),document={transact:callback=>callback(),getMap:name=>{if(!maps.has(name))maps.set(name,createOfflineMap());return maps.get(name)}};
  const files=document.getMap('files');
  const textFor=(path,initial='')=>{if(files.has(path))return files.get(path);let value=String(initial||'');const text={doc:document,get length(){return value.length},toString:()=>value,insert:(index,addition)=>{value=value.slice(0,index)+addition+value.slice(index)},delete:(index,length)=>{value=value.slice(0,index)+value.slice(index+length)},observe:()=>{},unobserve:()=>{}};files.set(path,text);return text};
  queueMicrotask(()=>onStatus?.('disconnected'));
  return {document,files,mapFor:name=>document.getMap(name),textFor,setCursor:()=>{},encodeRange:()=>({}),resolveRange:()=>null,resolveCursor:()=>null,isBootstrapLeader:()=>true,updateActor:()=>{},whenReady:Promise.resolve(),destroy:()=>{},offline:true};
}
function createCollaborationSession(options){
  try{if(!window.PaperCollab?.createSession)throw new Error('공동 편집 번들을 사용할 수 없습니다.');return window.PaperCollab.createSession(options)}
  catch(error){console.error('Collaboration unavailable; continuing in local editing mode.',error);window.__paperReportError?.(`collaboration fallback: ${error?.stack||error}`);queueMicrotask(()=>notify('공동 편집 연결 없이 원고를 열었습니다. 편집과 PDF 기능은 계속 사용할 수 있습니다.',{title:'로컬 편집 모드'}));return createOfflineCollaborationSession(options)}
}
let collabSession,collaborationWatchdogTimer=0,collaborationReconnectAttempted=false,collaborationWatchdogFailed=false;
function clearCollaborationWatchdog(){clearTimeout(collaborationWatchdogTimer);collaborationWatchdogTimer=0}
function armCollaborationWatchdog(){
  if(collaborationWatchdogTimer||collabReady||collaborationWatchdogFailed)return;
  collaborationWatchdogTimer=setTimeout(()=>{
    collaborationWatchdogTimer=0;
    if(collabReady)return;
    if(collabSession?.provider?.synced){handleCollaborationStatus('synced');return}
    if(!collaborationReconnectAttempted&&collabSession?.provider){
      collaborationReconnectAttempted=true;
      setCollaborationStatus('connecting','공동 편집 다시 연결 중');
      collabSession.provider.disconnect?.();
      collabSession.provider.connect?.();
      armCollaborationWatchdog();
      return;
    }
    collaborationWatchdogFailed=true;
    setCollaborationStatus('offline','공동 편집 동기화 지연');
  },collaborationWatchdogMs)
}
function handleCollaborationStatus(status){
  if(status==='synced'){
    collabReady=true;collaborationReconnectAttempted=false;collaborationWatchdogFailed=false;clearCollaborationWatchdog();
    $('collab-name').classList.remove('offline');setCollaborationStatus('','공동 편집 동기화됨');return
  }
  collabReady=false;
  if(collaborationWatchdogFailed){$('collab-name').classList.add('offline');setCollaborationStatus('offline','공동 편집 동기화 지연');return}
  const retrying=collaborationReconnectAttempted;
  const localOnly=Boolean(collabSession?.offline);
  $('collab-name').classList.toggle('offline',localOnly||(status==='disconnected'&&navigator.onLine===false));
  if(status==='disconnected'&&localOnly){clearCollaborationWatchdog();setCollaborationStatus('offline','공동 편집 없이 로컬 편집 중');return}
  if(status==='disconnected'&&navigator.onLine===false){clearCollaborationWatchdog();setCollaborationStatus('offline','공동 편집 오프라인 변경 보관 중');return}
  setCollaborationStatus('connecting',retrying||status==='disconnected'?'공동 편집 다시 연결 중':status==='connected'?'공동 편집 문서 동기화 중':'공동 편집 서버 연결 중');
  armCollaborationWatchdog()
}
collabSession=createCollaborationSession({url:`${location.protocol==='https:'?'wss':'ws'}://${location.host}/collab`,room:collaborationRoom,actor:hasDisplayName(actor.name)?actor:null,onStatus:handleCollaborationStatus,onPeers:peers=>{collaborators.clear();for(const peer of peers){const selection=peer.workspace?.surface==='rebuttal'?null:collabSession?.resolveCursor(peer);collaborators.set(String(peer.clientId),{...peer,id:peer.id||String(peer.clientId),selection})}updatePresence()}});
// Keep both project views alive and use the same CRDT session for both editors.
window.PaperWorkspaceSharedSession=collabSession;
updatePresence();
let reviewProjectTitle='';
function syncReviewProjectTitle(){
  const field=$('project-title'),frame=document.querySelector('.paper-review-frame');
  let title=field.value.trim()||reviewProjectTitle;
  try{if(title)sessionStorage.setItem(`paper-project-title:${projectSlug}`,title);else title=sessionStorage.getItem(`paper-project-title:${projectSlug}`)||''}catch{}
  try{const heading=frame?.contentDocument?.getElementById('workspace-project-title');if(heading)heading.textContent=title||projectSlug}catch{}
  if(title&&paperReviewActive)document.title=`${title} · Paper Workspace`;
}
async function loadReviewProjectTitle(){
  // Review-only startup does not need the manuscript recovery watchdog.
  window.__paperMarkStartupReady?.();
  const files=collaborationMap('files');
  let sharedReady=false;
  const manuscriptTitle=source=>typeof source==='string'&&/\\title\{/.test(source)?titleOf(source).trim().slice(0,160):'';
  const fromShared=()=>{
    if(!sharedReady)return false;
    const text=files.get('paper/main.tex'),title=manuscriptTitle(text?.toString());
    if(title){reviewProjectTitle=title;syncReviewProjectTitle()}
    return Boolean(title)
  };
  const fallback=()=>{
    if(reviewProjectTitle)return;
    try{reviewProjectTitle=sessionStorage.getItem(`paper-project-title:${projectSlug}`)||''}catch{}
    if(!reviewProjectTitle&&typeof manifest?.display_name==='string')reviewProjectTitle=manifest.display_name.trim().slice(0,160);
  };
  collabBootstrapReady.then(()=>{sharedReady=true;files.observeDeep(fromShared);fromShared()}).catch(error=>reportClientError(error,'reviewTitleSync'));
  let manifest;
  try{
    const signal=AbortSignal.timeout(10000);
    const response=await fetch(`${projectBase}/project/project.json`,{cache:'no-store',signal});
    if(!response.ok)throw new Error(`Review title manifest ${response.status}`);
    manifest=normalizeManifest(await response.json());
    const main=manifest.files.find(item=>item.path==='main.tex'&&!manifestItemIsAsset(item))||manifest.files.find(item=>item.path===manifest.entrypoint&&!manifestItemIsAsset(item));
    if(main){
      const source=await fetch(buildProjectFileUrl(projectBase,main.source||main.path,manifest),{cache:'no-store',signal});
      if(!source.ok)throw new Error(`Review title source ${source.status}`);
      const title=manuscriptTitle(await source.text());
      if(title&&!fromShared()){reviewProjectTitle=title;syncReviewProjectTitle();return}
    }
    fallback();
  }catch(error){
    // A title lookup must not prevent reviewing or replace the cached title.
    fallback();
    reportClientError(error,'reviewTitle');
  }
  syncReviewProjectTitle();
}
// The startup watchdog can set the title without passing through setProjectTitle.
window.addEventListener('paper:startup-recovered',syncReviewProjectTitle);
function mountReviewView(){
  const params=new URLSearchParams(location.search),initialReview=params.get('view')==='reviews' || /^\/p\/[^/]+\/rebuttal(?:\/|$)/.test(location.pathname);
  let initialTarget;
  try{const candidate=new URL(params.get('reviewTarget')||location.href,location.origin),base=`/p/${encodeURIComponent(projectSlug)}/rebuttal`;if(candidate.origin===location.origin && (candidate.pathname===base || candidate.pathname.startsWith(`${base}/`)))initialTarget=candidate}catch{}
  const fallback=()=>{const url=new URL(initialTarget?.href || $('open-rebuttal').href,location.href);url.searchParams.set('standalone','1');location.replace(url.href)};
  if(!collabSession?.namespacedTextFor || collabSession.offline){if(initialReview)fallback();return}
  const nav=$('open-rebuttal'),shell=document.querySelector('.shell');
  const frame=document.createElement('iframe');frame.className='paper-review-frame';frame.title='Reviews & responses';frame.tabIndex=-1;frame.setAttribute('aria-hidden','true');frame.inert=true;
  const reviewUrl=new URL(initialTarget?.href || nav.href,location.href);reviewUrl.searchParams.set('embedded','1');frame.src=reviewUrl.href;document.body.append(frame);
  let ready=false,pending=initialReview,pendingRecord=!initialReview,waitingTimer,navigationGeneration=0;
  window.PaperWorkspaceReviewLocation=(source,href,record=false)=>{
    if(source!==frame.contentWindow)return;
    let url;try{url=new URL(href,location.href)}catch{return}
    const base=`/p/${encodeURIComponent(projectSlug)}/rebuttal`;
    if(url.origin!==location.origin || (url.pathname!==base && !url.pathname.startsWith(`${base}/`)))return;
    for(const key of ['embedded','standalone','view','reviewTarget'])url.searchParams.delete(key);
    retainedReviewURL=url.href;nav.href=url.href;
    if(paperReviewActive && location.href!==url.href)history[record?'pushState':'replaceState']({paperView:'review'},'',url);
  };
  if(initialReview){document.documentElement.classList.add('paper-initial-review');if(initialTarget)history.replaceState({paperView:'review'},'',initialTarget.href);waitingTimer=setTimeout(()=>{if(pending)fallback()},10000)}
  const show=(review,record=true)=>{
    ++navigationGeneration;
    if(review&&!ready){pending=true;pendingRecord=record;clearTimeout(waitingTimer);waitingTimer=setTimeout(()=>{if(pending)fallback()},10000);return}
    // Each retained view follows the language selected in the visible view.
    if(review){const select=frame.contentDocument?.getElementById('workspace-language'),language=window.PaperI18n?.getLanguage();if(select&&language&&select.value!==language){select.value=language;select.dispatchEvent(new Event('change',{bubbles:true}))}}
    else window.PaperI18n?.setLanguage(frame.contentDocument?.documentElement.lang,{persist:false,updateUrl:true});
    pending=false;clearTimeout(waitingTimer);document.documentElement.classList.remove('paper-initial-review');frame.classList.toggle('is-active',review);frame.inert=!review;frame.setAttribute('aria-hidden',String(!review));shell.inert=review;paperReviewActive=review;clearTimeout(cursorTimer);lastCursorPayload='';frame.contentWindow?.PaperRebuttalSetVisible?.(review);if(!review)sendCursor();
    if(record){const url=new URL(review?nav.href:$('manuscript-link').href,location.href);if(location.href!==url.href)history.pushState({paperView:review?'review':'manuscript'},'',url)}
    if(review){const reviewDocument=frame.contentWindow?.document;syncReviewProjectTitle();frame.contentWindow?.dispatchEvent(new Event('resize'));reviewDocument?.querySelector('#main')?.focus({preventScroll:true})}
    else {ensureProjectLoaded();window.dispatchEvent(new Event('resize'));nav.focus({preventScroll:true})}
  };
  window.PaperWorkspaceReviewReady=source=>{if(source!==frame.contentWindow)return;ready=true;window.PaperWorkspaceReviewLocation(source,source.location.href);syncReviewProjectTitle();updatePresence();if(pending)show(true,pendingRecord)};
  window.PaperWorkspaceShowManuscript=source=>{if(source===frame.contentWindow)show(false)};
  window.PaperWorkspaceFocusLocation=async location=>{
    const file=location?.file;if(!validPaperPresenceFile(file))return false;
    show(false);await ensureProjectLoaded();
    if(!Object.hasOwn(state.files,file))return false;
    if(!isLockedProjectFile())state.files[state.current]=editorValue();
    state.current=file;setEditor();listFiles();
    const range=location.anchorRelative&&location.headRelative?collabSession.resolveRange(location,sharedText):null;
    const selection=range||(Array.isArray(location.selection)?location.selection:[0,0]);
    focusEditor();setEditorSelection(selection[0],selection[1],{scroll:true});sendCursor();renderRemoteCursors();return true;
  };
  nav.addEventListener('click',event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();show(true)});
  window.addEventListener('pageshow',event=>{if(event.persisted)frame.contentWindow?.PaperRebuttalSetVisible?.(paperReviewActive)});
  window.addEventListener('popstate',async()=>{
    const generation=++navigationGeneration,url=location.href;
    if(/^\/p\/[^/]+\/rebuttal(?:\/|$)/.test(location.pathname)){
      try{await frame.contentWindow?.PaperRebuttalNavigateURL?.(url)}catch(error){if(generation===navigationGeneration){reportClientError(error,'reviewNavigation');location.reload()}return}
      // Response initialization can outlive a newer history or mode change.
      if(generation!==navigationGeneration || location.href!==url)return;
      show(true,false);
    }else show(false,false)
  });
  frame.addEventListener('error',()=>{if(pending)fallback()});
}
mountReviewView();

function retryCollaboration(){
  if(!collabSession?.provider)return;
  collaborationWatchdogFailed=false;collaborationReconnectAttempted=true;clearCollaborationWatchdog();
  setCollaborationStatus('connecting','공동 편집 다시 연결 중');
  collabSession.provider.disconnect?.();collabSession.provider.connect?.();armCollaborationWatchdog()
}
window.addEventListener('online',retryCollaboration);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&collaborationWatchdogFailed)retryCollaboration()});
armCollaborationWatchdog();
// Never publish the local tree before both IndexedDB and the collaboration
// server have supplied their authoritative state. The manuscript is painted
// above this await, so a slow or offline server cannot hide local work; it also
// cannot turn a timeout into an accidental empty-room bootstrap.
const collabBootstrapReady=collabSession.whenReady;
// Older Safari sessions may retain the pre-mapFor collaboration bundle because
// vendor assets are immutable. The Y.Doc contract is stable, so use it as a
// compatibility path while the new cache-keyed bundle replaces the old copy.
const collaborationMap=name=>typeof collabSession.mapFor==='function'?collabSession.mapFor(name):collabSession.document.getMap(name);
const sharedComments=collaborationMap('comments'),sharedTasks=collaborationMap('tasks'),sharedFolders=collaborationMap('folders'),sharedAssets=collaborationMap('assets'),sharedProject=collaborationMap('project');let sharedMetadataReady=false,sharedFileRevision=0;
function sharedMapValues(map){return [...map.values()].filter(value=>value&&typeof value==='object')}
function replaceSharedMap(map,entries,keyOf){collabSession.document.transact(()=>{map.clear();for(const entry of entries)map.set(String(keyOf(entry)),structuredClone(entry))},actor.id)}
function syncSharedMetadataState({persist=true}={}){if(!sharedMetadataReady)return;state.comments=sharedMapValues(sharedComments).sort((a,b)=>(b.revision||0)-(a.revision||0));state.tasks=sharedMapValues(sharedTasks).sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));state.folders=[...new Set(['paper',...sharedFolders.keys()])];const sharedPaths=new Set();for(const metadata of sharedMapValues(sharedAssets)){if(typeof metadata.path!=='string')continue;sharedPaths.add(metadata.path);const existing=state.assets[metadata.path]||{};state.assets[metadata.path]={...existing,type:metadata.type||existing.type||'application/octet-stream',size:Number(metadata.size)||existing.size||0,server:true};state.uploads=[...new Set([metadata.path,...state.uploads])]}for(const path of [...state.uploads]){const asset=state.assets[path];if(asset?.server&&!sharedPaths.has(path)){delete state.assets[path];state.uploads=state.uploads.filter(item=>item!==path);deleteLocalAsset(path).catch(()=>{})}}listFiles();renderComments();renderTaskBoard();if(persist)save()}
function initializeSharedMetadata(){
  if(sharedMetadataReady)return;
  const metadataLeader=collabSession.offline||collabSession.isBootstrapLeader?.()===true;
  if(metadataLeader&&!sharedProject.get('metadataInitialized'))collabSession.document.transact(()=>{
    // Empty maps in an established room represent deletions, not missing seeds.
    if(!sharedProject.get('serverRuntimeRevision')){
      if(sharedComments.size===0)for(const comment of state.comments)sharedComments.set(String(comment.id||comment.revision),structuredClone(comment));
      if(sharedTasks.size===0)for(const task of state.tasks)sharedTasks.set(String(task.id),structuredClone(task));
      if(sharedFolders.size===0)for(const folder of state.folders)sharedFolders.set(folder,true);
      if(sharedAssets.size===0)for(const path of state.uploads){const asset=state.assets[path];if(asset?.server)sharedAssets.set(path,{path,type:asset.type,size:asset.size})}
    }
    sharedProject.set('metadataInitialized',true);
  },actor.id);
  sharedMetadataReady=true;
  // Startup may race with an update that another browser has just sent after
  // its own initial sync. Seed only still-empty entries as the settled
  // awareness leader; never replace or delete shared content during startup.
  if(collabSession.offline||collabSession.isBootstrapLeader?.()===true){
    for(const folder of state.folders)if(!sharedFolders.has(folder))sharedFolders.set(folder,true);
    for(const path of state.uploads){const asset=state.assets[path];if(asset?.server&&!sharedAssets.has(path))sharedAssets.set(path,{path,type:asset.type,size:asset.size})}
    for(const [path,value] of Object.entries(state.files))collabSession.textFor(path,value);
  }
  const onMetadataChange=()=>syncSharedMetadataState();
  sharedComments.observe(onMetadataChange);
  sharedTasks.observe(onMetadataChange);
  sharedFolders.observe(onMetadataChange);
  sharedAssets.observe(onMetadataChange);
  sharedProject.observe(()=>{
    const version=sharedProject.get('manifestVersion');if(typeof version==='string'&&version&&state.projectVersion!==version){state.projectVersion=version;save()}
    const writeback=sharedProject.get('sourceWritebackStatus');
    if(!writeback||typeof writeback!=='object'||Array.isArray(writeback))return;
    const status=String(writeback.state||''),saveState=$('save-state');
    if(status==='synced')saveState.textContent='원본 파일 반영됨 · 공동 편집 동기화됨';
    else if(status==='conflict')saveState.textContent='동시 변경 보존됨 · 병합 확인 필요';
    else if(status==='error')saveState.textContent='원본 파일 반영 지연 · 재시도 중';
  });
  collabSession.files.observeDeep((events,transaction)=>{
    ++sharedFileRevision;
    let changed=false,compileInputsChanged=false;
    for(const [path,text] of collabSession.files){
      const value=text?.toString?.();
      if(typeof value==='string'&&state.files[path]!==value){
        state.files[path]=value;changed=true;
        compileInputsChanged||=isCompileInputPath(path);
      }
    }
    for(const event of events){
      if(event.target!==collabSession.files)continue;
      for(const [path,{action}] of event.changes.keys){
        if(action==='delete'&&path!=='paper/main.tex'&&Object.hasOwn(state.files,path)){
          delete state.files[path];changed=true;
          compileInputsChanged||=isCompileInputPath(path);
        }
      }
    }
    richEditor?.retainDocuments?.(Object.keys(state.files));
    // Concurrent creation may select a different shared object with identical
    // text. Rebind even then, or later edits stay on the discarded object.
    const bindingChanged=collabSession.files.has(state.current)&&sharedText!==collabSession.files.get(state.current);
    if(changed||bindingChanged){if(state.files[state.current]===undefined)state.current=state.files['paper/main.tex']!==undefined?'paper/main.tex':Object.keys(state.files)[0];if(sharedText?._paperPath!==state.current||sharedText!==collabSession.files.get(state.current))setEditor();listFiles();save();if(compileInputsChanged&&transaction.origin!==actor.id)markCompileInputsChanged()}
  });
  syncSharedMetadataState({persist:false});
}
function publishSharedTree(){if(!sharedMetadataReady)return;collabSession.document.transact(()=>{const desiredFolders=new Set(state.folders);for(const folder of desiredFolders)sharedFolders.set(folder,true);for(const folder of [...sharedFolders.keys()])if(!desiredFolders.has(folder))sharedFolders.delete(folder);const desiredAssets=new Set(state.uploads.filter(path=>state.assets[path]?.server));for(const path of desiredAssets){const asset=state.assets[path];sharedAssets.set(path,{path,type:asset.type,size:asset.size})}for(const path of [...sharedAssets.keys()])if(!desiredAssets.has(path))sharedAssets.delete(path);for(const [path,value] of Object.entries(state.files))replaceSharedText(collabSession.files.get(path)||collabSession.textFor(path,value),value);for(const path of [...collabSession.files.keys()])if(state.files[path]===undefined)collabSession.files.delete(path)},actor.id)}
function replaceSharedText(text,value){const current=text.toString();if(current===value)return;let prefix=0;while(prefix<current.length&&prefix<value.length&&current[prefix]===value[prefix])prefix+=1;let suffix=0;while(suffix<current.length-prefix&&suffix<value.length-prefix&&current[current.length-1-suffix]===value[value.length-1-suffix])suffix+=1;text.doc.transact(()=>{const removed=current.length-prefix-suffix;if(removed)text.delete(prefix,removed);const inserted=value.slice(prefix,value.length-suffix);if(inserted)text.insert(prefix,inserted)},actor.id)}
function changedManifestPaths(previous,next){
  const describe=manifest=>new Map((manifest.files||[]).map(item=>{const source=item.source||item.path;return [`paper/${item.path}`,`${item.type||'text'}:${source}:${runtimeFileRevision(manifest,source)}`]}));
  const before=describe(previous),after=describe(next),paths=new Set([...before.keys(),...after.keys()]);
  return [...paths].filter(path=>before.get(path)!==after.get(path))
}
function adoptServerManifest(manifest,sources={}, {changedPaths=[],conflictPaths=[],preservedPaths=[],scheduleCompile=false}={}){
  const currentPath=state.current,selection=editorSelection();
  projectManifest=manifest;updateMainCompileControl();syncRemoteManifestAssets(manifest);
  for(const [path,value] of Object.entries(sources)){if(path==='paper/main.tex')state.serverMainSnapshot=sourceFingerprint(value);else state.serverSourceSnapshots[path]=sourceFingerprint(value)}
  const sharedFingerprints=sharedProject.get('serverSourceFingerprints');
  if(sharedFingerprints&&typeof sharedFingerprints==='object'&&!Array.isArray(sharedFingerprints))for(const item of serverManagedManifestItems(manifest)){const path=`paper/${item.path}`,fingerprint=sharedFingerprints[path];if(typeof fingerprint!=='string')continue;if(path==='paper/main.tex')state.serverMainSnapshot=fingerprint;else state.serverSourceSnapshots[path]=fingerprint}
  for(const retired of manifest.retired_paths||[])delete state.serverSourceSnapshots[`paper/${retired}`];
  for(const [path,text] of collabSession.files){const value=text?.toString?.();if(typeof value==='string')state.files[path]=value}
  for(const path of Object.keys(state.files))ensureFolderChain(parentPath(path));
  if(state.files[state.current]===undefined)state.current=state.files['paper/main.tex']!==undefined?'paper/main.tex':Object.keys(state.files)[0];
  if(state.current&&(!activeAsset||!state.assets[activeAsset])){setEditor();if(state.current===currentPath)setEditorSelection(Math.min(selection.start,editorValue().length),Math.min(selection.end,editorValue().length))}
  listFiles();syncProjectTitleFromTex(true);renderReferenceInventory();save();
  if(preservedPaths.length){sourceConflictDismissed=false;sourceConflictBanner.hidden=false;$('source-conflict-copy').textContent=conflictPaths.length?`겹쳐서 수정된 웹 원고 ${conflictPaths.length}개를 drafts에 보존하고 최신 서버 원본을 반영했습니다.`:`웹에서 편집한 ${preservedPaths.length}개 파일을 drafts에 보존하고 최신 서버 원본을 반영했습니다.`;$('open-preserved-draft').onclick=()=>{state.current=preservedPaths[0];setEditor();listFiles();sourceConflictBanner.hidden=true}}
  if(scheduleCompile&&changedPaths.some(isCompileInputPath))markCompileInputsChanged()
}
function waitForServerRuntimeRevision(revision,timeoutMs=5000){
  if(sharedProject.get('serverRuntimeRevision')===revision)return Promise.resolve(true);
  return new Promise(resolve=>{let settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);sharedProject.unobserve(observer);resolve(value)},observer=()=>{if(sharedProject.get('serverRuntimeRevision')===revision)finish(true)},timer=setTimeout(()=>finish(false),timeoutMs);sharedProject.observe(observer)})
}
async function submitServerRuntimeUpdate(manifest,previousRevision){
  if(accountReadOnly)return {applied:false,conflictPaths:[],mergedPaths:[],preservedPaths:[]};
  const response=await fetch(`/collab-runtime/${encodeURIComponent(collaborationRoom)}`,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({previous_runtime_revision:previousRevision,runtime_revision:manifest.runtime_revision})});
  const result=await response.json().catch(()=>({}));
  if(response.status===409)return {conflict:true,currentRevision:String(result.current_revision||'')};
  if(!response.ok)throw new Error(result.error||'서버 원고를 공동 작업공간에 반영하지 못했습니다.');
  const synchronized=await waitForServerRuntimeRevision(manifest.runtime_revision);
  if(!synchronized)throw new Error('서버 원고는 저장되었지만 공동 편집 화면 반영을 기다리고 있습니다.');
  return {applied:!result.deduplicated,conflictPaths:Array.isArray(result.conflict_paths)?result.conflict_paths:[],mergedPaths:Array.isArray(result.merged_paths)?result.merged_paths:[],preservedPaths:Array.isArray(result.preserved_paths)?result.preserved_paths:[]}
}
let serverSourceRefreshTimer=0,serverSourceRefreshBusy=false,lastServerSourceRefreshError='';
async function refreshServerSources(){
  if(serverSourceRefreshBusy||!sharedMetadataReady||!projectManifest.runtime_revision)return false;
  serverSourceRefreshBusy=true;
  try{
    const manifest=await loadProjectManifest();if(!manifest.runtime_revision)return false;
    const appliedRevision=sharedProject.get('serverRuntimeRevision');
    if(manifest.runtime_revision===projectManifest.runtime_revision&&appliedRevision===manifest.runtime_revision)return false;
    if(appliedRevision===manifest.runtime_revision){adoptServerManifest(manifest,{}, {changedPaths:changedManifestPaths(projectManifest,manifest),scheduleCompile:true});lastServerSourceRefreshError='';return true}
    if(!collabReady||!/^[0-9a-f]{64}$/.test(String(appliedRevision||'')))return false;
    const changedPaths=changedManifestPaths(projectManifest,manifest),result=await submitServerRuntimeUpdate(manifest,appliedRevision);
    if(result.conflict)return false;
    adoptServerManifest(manifest,{}, {changedPaths,conflictPaths:result.conflictPaths,preservedPaths:result.preservedPaths,scheduleCompile:changedPaths.some(isCompileAssetPath)});pruneDraftQueue({sync:true});markProjectActivity('server-sync');lastServerSourceRefreshError='';
    if(result.applied)notify(result.conflictPaths.length?`겹쳐서 수정된 웹 원고 ${result.conflictPaths.length}개를 초안으로 보존하고 최신 서버 원고를 반영했습니다.`:result.mergedPaths.length?`웹과 서버의 서로 다른 변경 ${result.mergedPaths.length}개를 자동으로 병합했습니다.`:result.preservedPaths.length?`웹 편집본 ${result.preservedPaths.length}개를 초안으로 보존하고 서버 원고를 반영했습니다.`:'서버에서 변경한 원고를 공동 작업공간에 반영했습니다.',{title:'서버 원고 자동 반영',tone:result.conflictPaths.length?'warning':undefined});
    return true
  }catch(error){const message=String(error?.message||error);if(lastServerSourceRefreshError!==message){lastServerSourceRefreshError=message;notify(message,{title:'서버 원고 확인 지연',tone:'warning'})}return false}
  finally{serverSourceRefreshBusy=false}
}
function scheduleServerSourceRefresh(delay=serverSourcePollMs){clearTimeout(serverSourceRefreshTimer);if(!projectManifest.runtime_revision)return;serverSourceRefreshTimer=setTimeout(async()=>{await refreshServerSources();scheduleServerSourceRefresh()},delay)}
function initializeServerSourceRefresh(){if(!projectManifest.runtime_revision)return;scheduleServerSourceRefresh();window.addEventListener('focus',refreshServerSources);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshServerSources()})}
function syncCurrentFileToShared(){if(!sharedText||activeAsset||isLockedProjectFile()||state.current!==sharedText._paperPath)return;replaceSharedText(sharedText,editorValue())}
function transformSharedIndex(index,delta){let oldPosition=0,newPosition=0;for(const part of delta){if(part.retain){if(index<=oldPosition+part.retain)return newPosition+(index-oldPosition);oldPosition+=part.retain;newPosition+=part.retain}else if(part.insert)newPosition+=typeof part.insert==='string'?part.insert.length:1;else if(part.delete){if(index<=oldPosition+part.delete)return newPosition;oldPosition+=part.delete}}return newPosition+(index-oldPosition)}
function bindSharedFile(path){if(sharedText&&sharedTextObserver)sharedText.unobserve(sharedTextObserver);sharedText=(sharedMetadataReady&&collabSession.files.get(path))||collabSession.textFor(path,state.files[path]||'');sharedText._paperPath=path;const sharedValue=sharedText.toString();if(sharedValue&&sharedValue!==state.files[path])state.files[path]=sharedValue;sharedTextObserver=event=>{if(event.transaction.origin===actor.id||sharedText._paperPath!==state.current)return;const selection=editorSelection(),start=transformSharedIndex(selection.start,event.delta),end=transformSharedIndex(selection.end,event.delta),value=sharedText.toString();state.files[state.current]=value;setEditorValueWithoutActivity(value);setEditorSelection(Math.min(start,value.length),Math.min(end,value.length));$('save-state').textContent=collabReady?'공동 편집 반영됨':'오프라인 변경 병합 중';updateEditorMetadata();renderRemoteCursors();renderCommentAnchors()};sharedText.observe(sharedTextObserver)}
let renderedPdfStale=false;
function setPdfFreshness(stale){renderedPdfStale=Boolean(stale);const banner=$('pdf-freshness');if(banner)banner.hidden=!renderedPdfStale}
function canUseRenderedSynctex(){if(!renderedPdfStale)return true;notify('원고와 PDF가 달라 위치 이동을 잠시 멈췄습니다. 최신 PDF가 준비되면 다시 시도해 주세요.',{title:'PDF 갱신 대기 중',tone:'warning'});return false}
function refreshEditorLayout(){richEditor?.view?.requestMeasure?.();if(innerWidth<768&&richEditor?.scrollDOM)richEditor.scrollDOM.scrollLeft=0}
function activateFocusMode(focus){const shell=document.querySelector('.shell');if(focus==='assistant'&&shell.dataset.focus!=='assistant')focusBeforeAssistant=shell.dataset.focus==='preview'?'preview':'source';shell.dataset.focus=focus;for(const item of $('focus-modes').querySelectorAll('button')){const active=item.dataset.focus===focus;item.setAttribute('aria-pressed',String(active));item.classList.toggle('is-active',active)}if(focus==='assistant')setAssistantCollapsed(false);else updateAssistantToggle();requestAnimationFrame(()=>{refreshEditorLayout();schedulePdfPageIndicatorUpdate();renderRemoteCursors();renderCommentAnchors()})}
function installFocusModes(){document.querySelector('.shell').dataset.focus='source';$('focus-modes')?.querySelectorAll('button').forEach(button=>button.onclick=()=>activateFocusMode(button.dataset.focus))}
let profileSettings;
function openNameSettings(){profileSettings.open()}
function installStatusCenter(){
  const collabAction=$('health-collab-action'),pdfAction=$('health-pdf-action'),backupAction=$('health-backup-action');
  const syncHealth=()=>{
    const healthSave=$('health-save'),healthPdf=$('health-pdf'),healthBackup=$('health-backup');
    healthSave.textContent=$('save-state').textContent;
    healthPdf.textContent=$('render-state').textContent;
    healthBackup.textContent=$('backup-status').textContent;
    healthBackup.closest('div').dataset.health=$('backup-status').dataset.health||'pending';
    const saveHealth=/오류|실패|오프라인|부족|error|failed|offline/i.test(healthSave.textContent)?'error':/저장 중|전송 중|불러오는 중|병합 중|saving|sending|loading|merging/i.test(healthSave.textContent)?'pending':'ok';
    healthSave.closest('div').dataset.health=saveHealth;
    $('save-state').dataset.health=saveHealth;
    healthPdf.closest('div').dataset.health=/오류|실패|시간 초과|error|failed|timeout|timed out/i.test(healthPdf.textContent)?'error':/렌더링 대기|PDF 대기|컴파일 중|준비 중|불러오는 중|렌더링 중|waiting|preparing|compiling|loading|rendering/i.test(healthPdf.textContent)?'pending':'ok';
    collabAction.hidden=healthSave.closest('.status-center-list')?.querySelector('#health-collab')?.closest('div')?.dataset.health!=='error';
    pdfAction.hidden=healthPdf.closest('div').dataset.health!=='error';
    backupAction.hidden=!['warning','error'].includes(healthBackup.closest('div').dataset.health);
    refreshOverallStatus();
  };
  for(const id of ['save-state','render-state','backup-status'])new MutationObserver(syncHealth).observe($(id),{childList:true,subtree:true,characterData:true});
  syncHealth();
  const {close}=statusCenter;
  collabAction.onclick=()=>{retryCollaboration();close({returnFocus:false})};
  pdfAction.onclick=()=>{close({returnFocus:false});activateAssistantTab('checks',{handoff:true})};
  backupAction.onclick=()=>{close({returnFocus:false});activateAssistantTab('sources',{handoff:true});createServerBackup('manual')};

}
profileSettings=window.PaperSidebarProfile.create({
  actor,required:true,
  onChange:(_profile,configured)=>collabSession.updateActor(configured?actor:null),
  onSave:()=>{$('name-toast').hidden=true;if(backupInitialized)createServerBackup('auto',{quiet:true})}
});
$('open-name-settings').onclick=()=>{$('name-toast').hidden=true;openNameSettings()};
function persistedFiles({compactDrafts=false}={}){if(!compactDrafts)return {...state.files};const entries=Object.entries(state.files),drafts=entries.filter(([path])=>path.startsWith('paper/drafts/'));const retainedDrafts=new Set(drafts.slice(-3).map(([path])=>path));if(state.current?.startsWith('paper/drafts/'))retainedDrafts.add(state.current);return Object.fromEntries(entries.filter(([path])=>!path.startsWith('paper/drafts/')||retainedDrafts.has(path)))}
function persistedState(options={}){const {recovery,browserStateVersion,indexedSavedAt,...durableState}=state;return {...durableState,files:persistedFiles(options),assets:{},serverMainSnapshot:compactSourceSnapshot(state.serverMainSnapshot),serverSourceSnapshots:Object.fromEntries(Object.entries(state.serverSourceSnapshots||{}).map(([path,snapshot])=>[path,compactSourceSnapshot(snapshot)]))};}
const save=(options={})=>{syncCurrentFileToShared();return workspacePersistence.save({synced:collabReady,...options})};
$('create-backup').onclick=()=>createServerBackup('manual');
$('create-checkpoint').onclick=createNamedCheckpoint;
function titleOf(tex){return (tex.match(/\\title\{([^}]*)\}/)||['','Untitled Paper'])[1]}
function setProjectTitle(value,{updateTex=false}={}){const title=value.trim().slice(0,160)||'Untitled Paper';state.projectTitle=title;if(!projectTitleStartupPending||updateTex){if(updateTex)projectTitleStartupPending=false;$('project-title').value=title;$('project-title').title=title;document.title=`${title} · Paper Workspace`;syncReviewProjectTitle();}if(updateTex&&!isLockedProjectFile('paper/main.tex')){const source=state.files['paper/main.tex']||'';if(/\\title\{[^}]*\}/.test(source)){const latexTitle=title.replace(/[{}]/g,'');state.files['paper/main.tex']=source.replace(/\\title\{[^}]*\}/,()=>`\\title{${latexTitle}}`);if(state.current==='paper/main.tex')setEditorValueWithoutActivity(state.files['paper/main.tex']);if(!projectBootstrapComplete)bootstrapEdits.set('paper/main.tex',state.files['paper/main.tex']);save();markCompileInputsChanged();markProjectActivity('title')}}}
function syncProjectTitleFromTex(force=false){if(state.current!=='paper/main.tex'&&!force)return;const title=titleOf(state.files['paper/main.tex']||$('editor').value);if(title&&(force||title!==state.projectTitle))setProjectTitle(title)}
$('project-title').addEventListener('change',event=>setProjectTitle(event.target.value,{updateTex:true}));$('project-title').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur()}if(event.key==='Escape'){event.currentTarget.value=state.projectTitle||titleOf(state.files['paper/main.tex']||'');event.currentTarget.blur()}});const initialProjectTitle=state.projectTitle||(state.files['paper/main.tex']?titleOf(state.files['paper/main.tex']):'');if(initialProjectTitle)setProjectTitle(initialProjectTitle);
function section(tex,name){const match=tex.match(new RegExp('\\\\section\\{' + name + '\\}([\\s\\S]*?)(?=\\\\section|\\\\bibliography|$)'));return match?match[1].replace(/\\\\[a-zA-Z]+(?:\{([^}]*)\})?/g,'$1').replace(/[{}]/g,'').trim():''}
let renderedPdfUrl='';
let renderedSynctex='';
let renderedSynctexFallback='';
let lastPdfAudit=null;
let activePdfDocument=null,activePdfObserver=null,activePdfResizeObserver=null,pdfRenderGeneration=0,pdfRenderRequest=0;
let activePdfRenderTasks=new Set();
const pdfPreRenderZoom=2,pdfMaxDevicePixelRatio=2,pdfMaxCanvasPixels=16_000_000;
let pdfPageIndicatorFrame=0;
function disposePdfPreview(){activePdfObserver?.disconnect();activePdfObserver=null;activePdfResizeObserver?.disconnect();activePdfResizeObserver=null;for(const task of activePdfRenderTasks)task.cancel?.();activePdfRenderTasks.clear();activePdfDocument?.destroy?.();activePdfDocument=null}
function resetPdfPageIndicator(){const indicator=$('pdf-page-indicator');indicator.hidden=true;indicator.textContent=''}
function updatePdfPageIndicator(){pdfPageIndicatorFrame=0;const indicator=$('pdf-page-indicator');const panel=document.querySelector('.preview-panel');const pages=Array.from(document.querySelectorAll('.pdf-page'));if(!panel||!pages.length){resetPdfPageIndicator();return}const current=window.PaperPdfViewport.currentPage(panel,pages);const pageNumber=Number(current?.dataset.page)||1;indicator.textContent=`${pageNumber} / ${pages.length}`;indicator.setAttribute('aria-label',`현재 PDF ${pageNumber}페이지, 전체 ${pages.length}페이지`);indicator.hidden=false}
function schedulePdfPageIndicatorUpdate(){if(pdfPageIndicatorFrame)return;pdfPageIndicatorFrame=requestAnimationFrame(updatePdfPageIndicator)}
function installPdfPageIndicator(){const panel=document.querySelector('.preview-panel');panel.addEventListener('scroll',schedulePdfPageIndicatorUpdate,{passive:true});new ResizeObserver(schedulePdfPageIndicatorUpdate).observe(panel);window.addEventListener('resize',schedulePdfPageIndicatorUpdate)}
function setRenderedPdf(binary){const nextUrl=URL.createObjectURL(new Blob([binary],{type:'application/pdf'}));if(renderedPdfUrl)URL.revokeObjectURL(renderedPdfUrl);renderedPdfUrl=nextUrl;$('download-pdf').disabled=false;return renderedPdfUrl}
function installZoomControls(){
  const setEditorZoom=zoom=>{
    layout.editorZoom=constrain(Math.round(zoom*10)/10,.7,1.7);
    applyLayout({persist:true});
  };
  const setPdfZoom=zoom=>{
    const panel=document.querySelector('.preview-panel');
    const pages=Array.from(document.querySelectorAll('.pdf-page'));
    const snapshot=window.PaperPdfViewport.capture(panel,pages);
    layout.pdfZoom=constrain(Math.round(zoom*10)/10,.55,2);
    applyLayout({persist:true});
    window.PaperPdfViewport.restore(panel,pages,snapshot);
    schedulePdfPageIndicatorUpdate();
  };
  const changeEditorZoom=delta=>setEditorZoom(layout.editorZoom+delta);
  const changePdfZoom=delta=>setPdfZoom(layout.pdfZoom+delta);
  $('editor-zoom-out').onclick=()=>changeEditorZoom(-.1);
  $('editor-zoom-value').onclick=()=>setEditorZoom(1);
  $('editor-zoom-in').onclick=()=>changeEditorZoom(.1);
  $('pdf-zoom-out').onclick=()=>changePdfZoom(-.1);
  $('pdf-zoom-value').onclick=()=>setPdfZoom(1);
  $('pdf-zoom-in').onclick=()=>changePdfZoom(.1);

  let editorWheelAt=0;
  let pdfWheelAt=0;
  const installModifiedWheelZoom=(element,changeZoom,getLastWheelAt,setLastWheelAt)=>{
    element.addEventListener('wheel',event=>{
      if(!(event.metaKey||event.ctrlKey)||event.deltaY===0)return;
      event.preventDefault();
      const now=performance.now();
      if(now-getLastWheelAt()<60)return;
      setLastWheelAt(now);
      changeZoom(event.deltaY<0?.1:-.1);
    },{passive:false});
  };
  installModifiedWheelZoom($('editor-panel'),changeEditorZoom,()=>editorWheelAt,value=>{editorWheelAt=value});
  installModifiedWheelZoom(document.querySelector('.preview-panel'),changePdfZoom,()=>pdfWheelAt,value=>{pdfWheelAt=value});
}
function installAssetViewer(){$('asset-zoom-out').onclick=()=>{assetZoom=constrain(assetZoom-.1,.5,3);applyAssetZoom()};$('asset-zoom-in').onclick=()=>{assetZoom=constrain(assetZoom+.1,.5,3);applyAssetZoom()}}
async function syncPdfToSource(page,x,y){
  if(!renderedSynctex||!canUseRenderedSynctex())return;
  const generation=pdfRenderGeneration;
  try{
    const attempt=await requestSynctex('/api/synctex',{page,x,y},generation);
    if(!attempt||generation!==pdfRenderGeneration||!canUseRenderedSynctex())return;
    const {response,result}=attempt;
    if(!response.ok)throw new Error(result.error||'SyncTeX 위치 검색 실패');
    const candidates=[`paper/${result.file}`,result.file,...Object.keys(state.files).filter(path=>path.endsWith(`/${result.file}`))];
    const file=candidates.find(path=>state.files[path]!==undefined);
    if(!file)throw new Error(`${result.file} 파일을 프로젝트에서 찾지 못했습니다.`);
    state.files[state.current]=editorValue();state.current=file;setEditor();listFiles();
    const editor=$('editor'),lines=editorValue().split('\n');
    const line=Math.max(1,Math.min(result.line,lines.length));
    const start=lines.slice(0,line-1).reduce((total,value)=>total+value.length+1,0);
    const end=start+lines[line-1].length;
    focusEditor();setEditorSelection(start,end,{scroll:true});
    const initialCoordinates=remoteCaretCoordinates(start);
    const targetTop=Math.max(70,editor.clientHeight*.32);
    editor.scrollTop=constrain(editor.scrollTop+initialCoordinates.top-targetTop,0,Math.max(0,editor.scrollHeight-editor.clientHeight));
    requestAnimationFrame(()=>{if(generation===pdfRenderGeneration&&state.current===file)showSourceSyncHighlight(start)});
    sendCursor();
  }catch(error){if(generation===pdfRenderGeneration)notify(error.message,{title:'PDF 위치 연결 오류',tone:'error'})}
}
function pdfFileName(){const title=titleOf(state.files['paper/main.tex']||'').replace(/\\[a-zA-Z]+|[{}]/g,' ').replace(/[^\p{L}\p{N}._ -]+/gu,'').trim().replace(/\s+/g,'-').slice(0,80);return `${title||'paper'}.pdf`}
function pdfWaitMarkup(title='PDF 준비 중',detail='원고를 렌더링하고 있습니다'){return `<div class="pdf-wait" role="status" aria-live="polite"><span class="pdf-spinner" aria-hidden="true"></span><strong>${title}</strong><span class="pdf-wait-detail">${detail}</span></div>`}
let latestCompileDiagnostics=[],latestCompileErrorDetail='';
function openPrimaryCompileDiagnostic(){const item=latestCompileDiagnostics[0];if(!item){activateAssistantTab('checks');return}if(innerWidth<=1180)activateFocusMode('source');goToSourceLocation(item.file,item.line)}
function pdfErrorMarkup(diagnostic={message:'검사 탭에서 오류 위치를 확인하세요'}){return `<div class="pdf-error-state" role="alert"><span class="pdf-error-icon" aria-hidden="true">!</span><strong>PDF를 만들지 못했습니다</strong><span>${esc(diagnostic.message)}</span><button id="pdf-error-action" type="button">${diagnostic.file?`${esc(diagnostic.file)}:${diagnostic.line}로 이동`:'컴파일 오류 확인'}</button></div>`}
function render(){resetPdfPageIndicator();$('paper-preview').innerHTML=pdfWaitMarkup('PDF 준비 중','PDF 렌더링을 실행하면 여기에 표시됩니다');$('render-state').textContent='PDF 대기';$('download-pdf').disabled=!renderedPdfUrl;}
const textExtensions=new Set(['tex','bib','sty','bst','cls','md','txt','csv','tsv','json','yaml','yml','js','mjs','py','sh','log','dat']);
const imageExtensions=new Set(['png','jpg','jpeg','gif','webp','svg','bmp','avif']);
let activeAsset='',assetZoom=1;
function isImageAsset(asset,path){return Boolean(asset?.type?.startsWith('image/'))||imageExtensions.has(extensionOf(path))}
function applyAssetZoom(){const image=$('asset-image');if(!image||image.hidden)return;image.classList.toggle('zoomed',assetZoom>1);image.style.transform=`scale(${assetZoom})`;$('asset-zoom-value').textContent=`${Math.round(assetZoom*100)}%`;$('asset-zoom-out').disabled=assetZoom<=.5;$('asset-zoom-in').disabled=assetZoom>=3}
function assetDataUrlBytes(data){const encoded=data.slice(data.indexOf(',')+1);const binary=atob(encoded);return Uint8Array.from(binary,char=>char.charCodeAt(0))}
async function ensureAssetLoaded(path){
  const asset=state.assets[path];
  if(!asset)throw new Error(`자산을 찾을 수 없습니다: ${path}`);
  if(asset.data)return asset;
  if(asset.loading)return asset.loading;
  const remoteSource=remoteAssetSources.get(path);
  const source=remoteSource||(asset.server?serverAssetUrl(path):'');
  if(!source)throw new Error(`자산 원본을 찾을 수 없습니다: ${path}`);
  asset.loading=(async()=>{
    const response=await fetch(source,{cache:remoteSource&&asset.runtimeSource===source?'force-cache':'no-store'});
    if(!response.ok)throw new Error(`${baseName(path)} 다운로드 실패`);
    const blob=await response.blob();
    asset.type=blob.type||asset.type||'application/octet-stream';
    asset.size=blob.size;
    asset.data=await fileToDataUrl(blob);
    if(remoteSource)asset.server=false;
    else if(state.assets[path]===asset)await storeLocalAsset(path,asset).catch(error=>reportClientError(error,'storeLocalAsset'));
    return asset;
  })().finally(()=>delete asset.loading);
  return asset.loading;
}
async function showAssetPreview(path){let asset=state.assets[path];if(!asset)return;disposeAssetPdf();const generation=assetPreviewGeneration;activeAsset=path;assetZoom=1;$('editor-panel').classList.add('asset-mode');$('asset-viewer').hidden=false;$('active-file').textContent=path;$('asset-name').textContent=baseName(path);$('asset-meta').textContent='불러오는 중…';const image=$('asset-image'),pdfViewer=$('asset-pdf-viewer'),empty=$('asset-empty');image.hidden=true;pdfViewer.hidden=true;empty.hidden=true;try{asset=await ensureAssetLoaded(path)}catch(error){if(activeAsset!==path||generation!==assetPreviewGeneration)return;empty.hidden=false;empty.querySelector('strong').textContent='파일을 불러오지 못했습니다';empty.querySelector('span').textContent=error.message;return}if(activeAsset!==path||generation!==assetPreviewGeneration)return;$('asset-meta').textContent=`${asset.type||'프로젝트 자산'} · ${(asset.size/1024).toFixed(1)} KB`;pdfViewer.replaceChildren();if(isImageAsset(asset,path)){image.src=asset.data;image.alt=`${baseName(path)} 미리보기`;image.hidden=false;pdfViewer.hidden=true;empty.hidden=true;applyAssetZoom()}else if(extensionOf(path)==='pdf'||asset.type==='application/pdf'){image.hidden=true;image.removeAttribute('src');pdfViewer.hidden=false;empty.hidden=true;$('asset-zoom-value').textContent='—';$('asset-zoom-out').disabled=true;$('asset-zoom-in').disabled=true;renderAssetPdf(path,asset,pdfViewer,generation)}else{image.hidden=true;image.removeAttribute('src');pdfViewer.hidden=true;empty.hidden=false;$('asset-zoom-value').textContent='—';$('asset-zoom-out').disabled=true;$('asset-zoom-in').disabled=true}$('asset-download').onclick=()=>{const link=document.createElement('a');link.href=asset.data;link.download=baseName(path);document.body.append(link);link.click();link.remove()};listFiles()}
const hasLocalFiles=event=>Array.from(event.dataTransfer?.types||[]).includes('Files');
const assetDataLimit=8*1024*1024;
function ensureFolderChain(path){let current='';for(const segment of path.split('/').filter(Boolean)){current=current?`${current}/${segment}`:segment;ensureFolder(current)}}
function projectPathExists(path){return Object.hasOwn(state.files,path)||Object.hasOwn(state.assets,path)||state.folders.includes(path)}
function uniqueProjectPath(path){if(!projectPathExists(path))return path;const folder=parentPath(path);const name=baseName(path);const dot=name.lastIndexOf('.');const stem=dot>0?name.slice(0,dot):name;const extension=dot>0?name.slice(dot):'';let index=2,candidate;do{candidate=`${folder?`${folder}/`:''}${stem} (${index})${extension}`;index+=1;}while(projectPathExists(candidate));return candidate}
function fileToDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);})}
async function readDropEntry(entry,prefix=''){if(entry.isFile)return new Promise(resolve=>entry.file(file=>resolve([{file,relativePath:`${prefix}${file.name}`}]),()=>resolve([])));if(!entry.isDirectory)return[];const reader=entry.createReader();const children=[];for(;;){const batch=await new Promise(resolve=>reader.readEntries(resolve,()=>resolve([])));if(!batch.length)break;children.push(...batch)}const nested=await Promise.all(children.map(child=>readDropEntry(child,`${prefix}${entry.name}/`)));return nested.flat()}
async function droppedLocalFiles(dataTransfer){const items=Array.from(dataTransfer.items||[]);const entries=items.map(item=>item.webkitGetAsEntry?.()).filter(Boolean);if(entries.length)return (await Promise.all(entries.map(entry=>readDropEntry(entry)))).flat();return Array.from(dataTransfer.files||[]).map(file=>({file,relativePath:file.webkitRelativePath||file.name}))}
function cleanRelativePath(value){return value.split('/').map(cleanSegment).filter(Boolean).join('/')}
async function importLocalFiles(entries,targetFolder='paper'){let imported=0;const skipped=[],localOnly=[];for(const {file,relativePath} of entries){const relative=cleanRelativePath(relativePath||file.name);if(!relative)continue;if(file.size>assetDataLimit){skipped.push(`${file.name} (8 MB 초과)`);continue;}const destination=uniqueProjectPath(targetFolder?`${targetFolder}/${relative}`:relative);ensureFolderChain(parentPath(destination));const extension=extensionOf(destination);try{if(file.type.startsWith('text/')||textExtensions.has(extension)){state.files[destination]=await file.text();}else{state.assets[destination]={type:file.type||'application/octet-stream',size:file.size,data:await fileToDataUrl(file)};await storeLocalAsset(destination,state.assets[destination]).catch(()=>{});try{await uploadServerAsset(destination,file,state.assets[destination].type);state.assets[destination].server=true}catch{localOnly.push(file.name)}}state.uploads=[...new Set([destination,...state.uploads])];imported+=1;}catch{skipped.push(file.name)}}for(let folder=targetFolder;folder;folder=parentPath(folder))state.collapsedFolders=state.collapsedFolders.filter(item=>item!==folder);listFiles();if(imported){publishSharedTree();save();markCompileInputsChanged();markProjectActivity('import')}if(localOnly.length)notify(`${localOnly.join(', ')}은 브라우저에만 저장됐습니다. 연결 후 다시 업로드해 주세요.`,{title:'일부 자료 공유 대기',tone:'warning'});if(skipped.length)alert(`가져오지 못한 자료:\n${skipped.join('\n')}`);return imported}
function updateMainCompileControl(){
  const button=$('pin-main-compile'),root=projectManifest.entrypoint||'main.tex';
  button.disabled=!workspaceReadyForCompile;
  button.setAttribute('aria-pressed',String(mainCompilePinned));
  button.querySelector('span').textContent=mainCompilePinned?'본문 고정됨':'본문으로 고정';
  button.title=`${mainCompilePinned?'본문 고정 해제':'본문으로 고정'}: ${root}`;
  button.setAttribute('aria-label',button.title);
}
function toggleMainCompile(){
  mainCompilePinned=!mainCompilePinned;
  preferences.set(mainCompilePreferenceKey,String(mainCompilePinned));
  updateMainCompileControl();
  workspaceContentRevision+=1;
  compileRequestGeneration+=1;
  compileController?.abort();
  setCompileStateId('');
  setPdfFreshness(Boolean(renderedPdfUrl));
  if(workspaceReadyForCompile)compileAfterSave();
}
function installMainCompileControl(){$('pin-main-compile').onclick=toggleMainCompile;updateMainCompileControl()}
function selectedEntrypoint(){const fallback=projectManifest.entrypoint||'main.tex';if(mainCompilePinned)return fallback;const current=state.current?.startsWith('paper/')?state.current.slice('paper/'.length):'';return current&&extensionOf(current)==='tex'&&state.files[`paper/${current}`]!==undefined?current:fallback}
function selectedPreviewMode(entrypoint=selectedEntrypoint()){const root=projectManifest.entrypoint||'main.tex';const source=state.files[`paper/${entrypoint}`]||'';return entrypoint!==root&&!isLatexDocument(source)?'fragment':'document'}
async function compilePayload(){const entrypoint=selectedEntrypoint();return buildCompilePayload({files:state.files,assets:state.assets,entrypoint,rootEntrypoint:projectManifest.entrypoint||'main.tex',previewMode:selectedPreviewMode(entrypoint),workspaceId:projectSlug,ensureAssetLoaded})}
let contextTarget={type:'root',path:''};let treeMenuTrigger=null;let pendingUploadFolder='';
function showTreeMenu(event,type,path){event.preventDefault();event.stopPropagation();treeMenuTrigger=event.currentTarget;contextTarget={type,path};const menu=$('tree-menu');const protectedPaper=!canMutateTreeTarget(type,path);menu.querySelector('[data-action="new-folder"]').hidden=type==='file';menu.querySelector('[data-action="upload"]').hidden=type==='file';menu.querySelector('[data-action="rename"]').hidden=type==='root'||protectedPaper;menu.querySelector('[data-action="delete"]').hidden=type==='root'||protectedPaper;menu.querySelector('.menu-separator').hidden=![...menu.querySelectorAll('[data-action="rename"],[data-action="delete"]')].some(item=>!item.hidden);menu.hidden=false;const {width,height}=menu.getBoundingClientRect(),anchor=event.currentTarget?.getBoundingClientRect?.();const x=event.clientX||anchor?.left||8,y=event.clientY||anchor?.bottom||8;menu.style.left=`${Math.max(8,Math.min(x,innerWidth-width-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,innerHeight-height-8))}px`;menu.querySelector('button:not([hidden])')?.focus();}
function openTextFile(path){if(state.files[path]===undefined)return false;disposeAssetPdf();if(!isLockedProjectFile())state.files[state.current]=editorValue();state.current=path;setEditor();listFiles();save();sendCursor();if(innerWidth<768)activateFocusMode('source');if(extensionOf(path)==='tex')compileAfterSave();return true}
const fileIconPaths={code:['M8 8 4 12l4 4','m16 8 4 4-4 4','m14 5-4 14'],library:['M5 5.5h5a2.5 2.5 0 0 1 2.5 2.5v11H7a2 2 0 0 0-2 2z','M19 5.5h-5A2.5 2.5 0 0 0 11.5 8v11H17a2 2 0 0 1 2 2z'],text:['M6 3h8l4 4v14H6z','M14 3v5h5','M9 12h6','M9 16h6'],image:['M4 5h16v14H4z','m6.5 16 3.5-3.5 3 3 2-2 2.5 2.5','M8.5 9h.01'],pdf:['M6 3h8l4 4v14H6z','M14 3v5h5','M9 12h6','M9 16h4'],other:['M6 3h8l4 4v14H6z','M14 3v5h5','M12 12h.01','M12 16h.01'],folder:['M3 6h6l2 2h10v10H3z']};
function fileIconVariant(path,{kind='',mime=''}={}){if(kind==='folder')return'folder';const extension=extensionOf(path);if(imageExtensions.has(extension)||mime.startsWith('image/'))return'image';if(extension==='pdf'||mime==='application/pdf')return'pdf';if(extension==='bib')return'library';if(['tex','sty','cls','bst','js','mjs','py','sh'].includes(extension))return'code';if(['md','txt','csv','tsv','json','yaml','yml','log','dat'].includes(extension))return'text';return'other'}
function createFileIcon(path,options={}){const variant=fileIconVariant(path,options),icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.classList.add('file-icon-svg',`file-icon-${variant}`);icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('width','16');icon.setAttribute('height','16');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.75');icon.setAttribute('stroke-linecap','round');icon.setAttribute('stroke-linejoin','round');icon.setAttribute('aria-hidden','true');for(const d of fileIconPaths[variant]){const pathElement=document.createElementNS('http://www.w3.org/2000/svg','path');pathElement.setAttribute('d',d);icon.append(pathElement)}return icon}
function fileButton(path){const item=$('file-template').content.firstElementChild.cloneNode(true),locked=isLockedProjectFile(path);item.dataset.filePath=path;item.classList.toggle('active',!activeAsset&&path===state.current);item.classList.toggle('locked',locked);item.querySelector('.file-icon').replaceChildren(createFileIcon(path));item.querySelector('.file-label').textContent=`${baseName(path)}${locked?'  🔒':''}`;item.title=locked?`${path} · 수정 잠김`:path;item.draggable=!locked;item.onclick=()=>openTextFile(path);item.oncontextmenu=event=>showTreeMenu(event,'file',path);return item}
function assetButton(path){const item=$('file-template').content.firstElementChild.cloneNode(true);item.dataset.filePath=path;const asset=state.assets[path];item.classList.add('asset');item.classList.toggle('active',path===activeAsset);item.querySelector('.file-icon').replaceChildren(createFileIcon(path,{mime:asset.type||''}));item.querySelector('.file-label').textContent=baseName(path);item.title=asset.size?`${path} · ${(asset.size/1024).toFixed(1)} KB`:`${path} · 필요할 때 불러옴`;item.onclick=()=>{disposeAssetPdf();state.files[state.current]=editorValue();showAssetPreview(path);save()};item.oncontextmenu=event=>showTreeMenu(event,'asset',path);return item}
function clearDropState(){document.querySelector('.sidebar').classList.remove('file-dragging');document.querySelectorAll('.folder-row.drop-target').forEach(row=>row.classList.remove('drop-target'))}
function folderElement(path,allFolders){const wrapper=document.createElement('div');wrapper.className='folder-node';wrapper.dataset.folderPath=path;const collapsed=state.collapsedFolders.includes(path);const row=document.createElement('button');row.className=`folder-row ${collapsed?'':'open'} ${state.activeFolder===path?'selected':''}`;row.dataset.folder=path;row.title=`${path} 폴더 · 업로드 대상으로 선택`;row.setAttribute('aria-expanded',String(!collapsed));row.innerHTML=`<span class="folder-chevron">▶</span><svg class="folder-icon" viewBox="0 0 24 20" aria-hidden="true"><path d="M2.5 4.5h7l2 2h10v11h-19z"/></svg><span class="folder-name">${esc(baseName(path))}</span>`;const children=document.createElement('div'),inner=document.createElement('div');children.className=`folder-children ${collapsed?'collapsed':''}`;inner.className='folder-children-inner';row.onclick=()=>{state.activeFolder=path;const willCollapse=!children.classList.contains('collapsed');children.classList.toggle('collapsed',willCollapse);row.classList.toggle('open',!willCollapse);row.setAttribute('aria-expanded',String(!willCollapse));const index=state.collapsedFolders.indexOf(path);if(willCollapse&&index<0)state.collapsedFolders.push(path);if(!willCollapse&&index>=0)state.collapsedFolders.splice(index,1);document.querySelectorAll('.folder-row.selected').forEach(item=>item.classList.remove('selected'));row.classList.add('selected');save();};row.oncontextmenu=event=>{state.activeFolder=path;showTreeMenu(event,'folder',path)};row.ondragover=event=>{if(!hasLocalFiles(event))return;event.preventDefault();event.stopPropagation();row.classList.add('drop-target');event.dataTransfer.dropEffect='copy'};row.ondragleave=()=>row.classList.remove('drop-target');row.ondrop=async event=>{if(!hasLocalFiles(event))return;event.preventDefault();event.stopPropagation();clearDropState();state.activeFolder=path;await importLocalFiles(await droppedLocalFiles(event.dataTransfer),path)};[...allFolders].filter(folder=>parentPath(folder)===path).sort().forEach(folder=>inner.append(folderElement(folder,allFolders)));Object.keys(state.files).filter(file=>parentPath(file)===path).sort().forEach(file=>inner.append(fileButton(file)));Object.keys(state.assets).filter(file=>parentPath(file)===path).sort().forEach(file=>inner.append(assetButton(file)));children.append(inner);wrapper.append(row,children);return wrapper}
function applyFileFilter(){const query=$('file-search').value.trim().toLocaleLowerCase();$('clear-file-search').hidden=!query;const files=$('files');files.querySelectorAll('[data-file-path]').forEach(item=>{item.hidden=Boolean(query&&!item.dataset.filePath.toLocaleLowerCase().includes(query))});const folders=[...files.querySelectorAll('.folder-node')].reverse();for(const folder of folders){const ownMatch=!query||folder.dataset.folderPath.toLocaleLowerCase().includes(query);const childMatch=[...folder.querySelectorAll(':scope > .folder-children > .folder-children-inner > [data-file-path],:scope > .folder-children > .folder-children-inner > .folder-node')].some(item=>!item.hidden);folder.hidden=Boolean(query&&!ownMatch&&!childMatch);const children=folder.querySelector(':scope > .folder-children'),row=folder.querySelector(':scope > .folder-row');if(query&&!folder.hidden){children.classList.remove('collapsed');row.classList.add('open');row.setAttribute('aria-expanded','true')}else if(!query){const collapsed=state.collapsedFolders.includes(folder.dataset.folderPath);children.classList.toggle('collapsed',collapsed);row.classList.toggle('open',!collapsed);row.setAttribute('aria-expanded',String(!collapsed))}}let empty=files.querySelector('.file-search-empty');if(query&&![...files.children].some(item=>!item.hidden)){if(!empty){empty=document.createElement('p');empty.className='file-search-empty';files.append(empty)}empty.textContent='일치하는 파일이 없습니다.'}else empty?.remove()}
function quickNavigationTargets(){const entrypoint=`paper/${projectManifest.entrypoint||'main.tex'}`,paths=[...Object.keys(state.files),...Object.keys(state.assets)],targets=[];if(state.files[entrypoint]!==undefined)targets.push({label:'메인 원고',path:entrypoint,type:'file'});const bodyFolder='paper/sections';if(state.folders.includes(bodyFolder)||paths.some(path=>path.startsWith(`${bodyFolder}/`)))targets.push({label:'본문',path:bodyFolder,type:'folder'});const bibliography=Object.keys(state.files).filter(path=>extensionOf(path)==='bib').sort((left,right)=>Number(right==='paper/references.bib')-Number(left==='paper/references.bib')||left.localeCompare(right))[0];if(bibliography)targets.push({label:'참고문헌',path:bibliography,type:'file'});return targets}
function treeAncestors(path){const ancestors=[];for(let parent=parentPath(path);parent;parent=parentPath(parent))ancestors.push(parent);return ancestors}
function locateTreePath(path){const targetPath=String(path||''),search=$('file-search');if(!targetPath)return false;const ancestors=treeAncestors(targetPath),wasCollapsed=state.collapsedFolders.length;search.value='';state.collapsedFolders=state.collapsedFolders.filter(folder=>!ancestors.includes(folder));listFiles();if(wasCollapsed!==state.collapsedFolders.length)save();const target=[...$('files').querySelectorAll('[data-file-path],.folder-row[data-folder]')].find(item=>(item.dataset.filePath||item.dataset.folder)===targetPath);if(!target)return false;target.scrollIntoView({block:'nearest'});target.focus({preventScroll:true});return true}
function renderQuickNavigation(){
  const section=$('quick-nav-section'),navigation=$('quick-nav'),locator=$('locate-current-file'),targets=quickNavigationTargets(),currentPath=activeAsset||state.current,locatorLabel='현재 파일 찾기';
  navigation.replaceChildren();
  section.hidden=!targets.length;
  locator.hidden=!currentPath;
  locator.title=currentPath?`${locatorLabel}: ${currentPath}`:locatorLabel;
  locator.setAttribute('aria-label',locator.title);
  locator.onclick=()=>locateTreePath(activeAsset||state.current);
  if(section.hidden)return;
  for(const target of targets){
    const item=document.createElement('button'),icon=document.createElement('span'),label=document.createElement('span');
    item.type='button';item.className='quick-nav-link quick-nav-entry';
    item.dataset.shortcutPath=target.path;item.title=target.path;
    item.setAttribute('aria-label',`${target.label}: ${target.path}`);
    icon.className='quick-nav-icon';icon.append(createFileIcon(target.path,{kind:target.type}));label.className='quick-nav-label';label.textContent=target.label;item.append(icon,label);
    if(target.type==='file'&&target.path===currentPath)item.setAttribute('aria-current','page');
    item.onclick=()=>{
      if(target.type!=='file')return locateTreePath(target.path);
      const restoreFocus=document.activeElement===item;
      if(!openTextFile(target.path)||!restoreFocus)return;
      if(innerWidth<768)focusEditor();
      else [...navigation.querySelectorAll('.quick-nav-entry')].find(button=>button.dataset.shortcutPath===target.path)?.focus({preventScroll:true});
    };
    navigation.append(item);
  }
}
function listFiles(){if($('composer-file'))$('composer-file').textContent=baseName(state.current||'main.tex');const files=$('files');files.innerHTML='';const allFolders=new Set(state.folders);for(const file of [...Object.keys(state.files),...Object.keys(state.assets)]){let folder=parentPath(file);while(folder){allFolders.add(folder);folder=parentPath(folder)}}for(const folder of [...state.folders]){let parent=parentPath(folder);while(parent){allFolders.add(parent);parent=parentPath(parent)}}[...allFolders].filter(folder=>!parentPath(folder)).sort((a,b)=>a==='paper'?-1:b==='paper'?1:a.localeCompare(b)).forEach(folder=>files.append(folderElement(folder,allFolders)));Object.keys(state.files).filter(file=>!parentPath(file)).sort().forEach(file=>files.append(fileButton(file)));Object.keys(state.assets).filter(file=>!parentPath(file)).sort().forEach(file=>files.append(assetButton(file)));applyFileFilter();renderQuickNavigation();$('uploaded-files').innerHTML=state.uploads.map(name=>`<div class="source-file">${esc(name)}</div>`).join('')||'<p class="hint">아직 업로드한 자료가 없습니다.</p>'}
function commentLocation(comment){const source=state.files[comment.file]||'',relative=comment.anchorRelative&&comment.headRelative?collabSession.resolveRange(comment):null;if(relative)return [Math.min(relative[0],source.length),Math.min(relative[1],source.length)];if(source.slice(comment.start,comment.end)===comment.anchor||source.slice(comment.start,comment.start+comment.anchor.length)===comment.anchor)return [comment.start,Math.min(comment.end,source.length)];const found=source.indexOf(comment.anchor);return found>=0?[found,found+comment.anchor.length]:[Math.min(comment.start,source.length),Math.min(comment.end,source.length)]}
function renderCommentAnchors(){const container=$('comment-anchors');container.replaceChildren();if(activeAsset)return;const groups=new Map(),height=richEditor?.dom.clientHeight||0;for(const comment of state.comments.filter(item=>item.file===state.current)){const [start]=commentLocation(comment),coordinates=remoteCaretCoordinates(start);if(coordinates.top<-coordinates.lineHeight||coordinates.top>height)continue;const key=Math.round(coordinates.top/coordinates.lineHeight);if(!groups.has(key))groups.set(key,{coordinates,comments:[]});groups.get(key).comments.push(comment)}for(const {coordinates,comments} of groups.values()){const indicator=document.createElement('span');indicator.className='comment-line-indicator';indicator.style.top=`${coordinates.top}px`;indicator.style.height=`${coordinates.lineHeight}px`;const marker=document.createElement('button');marker.type='button';marker.className='comment-anchor-marker';marker.style.top=`${coordinates.top}px`;marker.textContent=String(comments.length);const first=comments[0],more=comments.length>1?` · 외 ${comments.length-1}개`:'';marker.dataset.tooltip=`${first.actor||'공동저자'}: ${first.body}${more}`;marker.setAttribute('aria-label',`${first.actor||'공동저자'}의 댓글${more}. 클릭하여 댓글로 이동`);marker.onclick=()=>{goToComment(first);activateAssistantTab('comments')};container.append(indicator,marker)}}
function goToComment(comment){if(!state.files[comment.file])return alert('댓글이 연결된 파일을 찾을 수 없습니다.');state.files[state.current]=editorValue();state.current=comment.file;setEditor();listFiles();const [start,end]=commentLocation(comment);focusEditor();setEditorSelection(start,end,{scroll:true});activeSelection={file:comment.file,start,end,text:editorValue().slice(start,end)};sendCursor()}
function renderComments(){renderCommentAnchors();const container=$('comment-list');if(!state.comments.length){container.innerHTML='<p class="hint">아직 댓글이 없습니다.</p>';return}container.replaceChildren(...state.comments.map(comment=>{const card=document.createElement('article');card.className='comment-card';card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',`${comment.file}의 댓글 위치로 이동`);card.innerHTML=`<span class="comment-avatar" aria-hidden="true">${esc((comment.actor||"?").slice(0,2).toUpperCase())}</span><div class="comment-message"><div class="comment-meta"><strong>${esc(comment.actor||"작성자")}</strong><span>${esc(comment.file)}</span><button type="button" class="resolve-comment">해결</button></div><div class="comment-body">${esc(comment.body)}</div><blockquote class="comment-anchor latex-preview">${latexPreview(comment.anchor)}</blockquote></div>`;card.onclick=event=>{if(!event.target.closest('.resolve-comment'))goToComment(comment)};card.onkeydown=event=>{if(event.target!==card)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();goToComment(comment)}};card.querySelector('.resolve-comment').onclick=event=>{event.stopPropagation();const key=String(comment.id||comment.revision);if(sharedMetadataReady)sharedComments.delete(key);else{state.comments=state.comments.filter(item=>String(item.id||item.revision)!==key);save();renderComments()}};return card}))}
let editorEventsBound=false;
const autoSaveDelayMs=1000;
function scheduleCompileAfterSave(){if(!workspaceReadyForCompile)return;workspaceContentRevision+=1;clearTimeout(window.saveTimer);window.saveTimer=setTimeout(()=>{if(save())compileAfterSave()},autoSaveDelayMs)}
function markCompileInputsChanged(){setPdfFreshness(Boolean(renderedPdfUrl));scheduleCompileAfterSave()}
function updateWordCount(value=editorValue()){const count=value.trim().split(/\s+/).filter(Boolean).length;window.PaperI18n.setText($('word-count'),count===1?'workspace.editor.oneWord':'workspace.editor.words',{count})}
function updateEditorMetadata(){if(isLockedProjectFile())return;const value=editorValue();state.files[state.current]=value;updateWordCount(value);$('save-state').textContent='저장 중…';setPdfFreshness(Boolean(renderedPdfUrl));sendCursor();scheduleCompileAfterSave()}
function installEditorShortcuts(){document.addEventListener('keydown',event=>{const modifier=event.metaKey||event.ctrlKey;if(!modifier)return;const key=event.key.toLowerCase();if(key==='s'){event.preventDefault();if(isLockedProjectFile()){$('save-state').textContent='수정 잠김';return}state.files[state.current]=editorValue();clearTimeout(window.saveTimer);if(save()){$('save-state').textContent='저장됨';compileAfterSave()}return}if(!richEditor?.focusWithin())return;if(key==='z')return;if(key==='y')return;if(event.altKey&&key==='c'){event.preventDefault();captureEditorSelection();prepareInlineComment();return}if(event.altKey&&key==='a'){event.preventDefault();captureEditorSelection();prepareCodexRequest();return}})}
let cursorTimer=0,lastCursorPayload='';
function sendCursor(){
  clearTimeout(cursorTimer);
  // The retained Rebuttal iframe owns this shared awareness state while active.
  if(paperReviewActive)return;
  cursorTimer=setTimeout(()=>{
    if(paperReviewActive)return;
    const selection=editorSelection(),position=selection.start;
    const visible=!document.hidden,focused=visible&&document.hasFocus();
    const workspace={surface:'paper',visible,focused,editing:focused&&!activeAsset&&!isLockedProjectFile()&&Boolean(richEditor?.focusWithin()),file:state.current};
    const hasSharedText=sharedText?.doc===collabSession.document;
    const payload=JSON.stringify({workspace,selection:[position,selection.end],hasSharedText});
    if(payload===lastCursorPayload)return;
    lastCursorPayload=payload;
    const awareness=collabSession.provider?.awareness;
    if(awareness){
      const local=awareness.getLocalState();if(!local)return;
      const range=workspace.editing&&hasSharedText?collabSession.encodeRange(state.current,position,selection.end):null;
      const cursor=range?{active_file:state.current,anchor:range.anchorRelative,head:range.headRelative}:null;
      const next={...local,workspace,rebuttal:null,cursor};
      if(JSON.stringify([local.workspace,local.rebuttal,local.cursor])!==JSON.stringify([workspace,null,cursor]))awareness.setLocalState(next);
    }
  },50)
}
function setEditor(){if(activeAsset)disposeAssetPdf();activeAsset='';$('editor-panel').classList.remove('asset-mode');$('asset-viewer').hidden=true;const editor=$('editor');bindSharedFile(state.current);suppressProjectActivity=true;try{richEditor.setDocument(state.current,state.files[state.current]);editor.value=richEditor.getValue()}finally{suppressProjectActivity=false}const locked=isLockedProjectFile();editor.readOnly=locked;richEditor.contentDOM.contentEditable=locked?'false':'true';richEditor.contentDOM.setAttribute('aria-readonly',String(locked));$('editor-panel').classList.toggle('source-locked',locked);$('active-file').textContent=`${state.current}${locked?'  🔒':''}`;$('project-title').readOnly=isLockedProjectFile('paper/main.tex');if(locked)$('save-state').textContent='수정 잠김';if(!editorEventsBound){editor.addEventListener('beforeinput',event=>{if(isLockedProjectFile())event.preventDefault()});editor.addEventListener('input',()=>{if(isLockedProjectFile()){setEditorValueWithoutActivity(state.files[state.current]);return}const value=editorValue();state.files[state.current]=value;if(!projectBootstrapComplete)bootstrapEdits.set(state.current,value);if(!suppressProjectActivity)markProjectActivity('edit');syncCurrentFileToShared();markCollaborationChange();$('save-state').textContent=collabReady?'공동 편집 전송 중…':'로컬 저장 중…';setPdfFreshness(Boolean(renderedPdfUrl));sendCursor();renderCommentAnchors();scheduleCompileAfterSave();updateWordCount(value);});editor.addEventListener('click',sendCursor);editor.addEventListener('keyup',sendCursor);editorEventsBound=true}updateWordCount();renderCommentAnchors();sendCursor()}
let activeSelection=null;
function selectedEditorRange(){const selection=editorSelection(),value=editorValue();if(selection.end>selection.start){activeSelection={file:state.current,start:selection.start,end:selection.end,text:value.slice(selection.start,selection.end)};return activeSelection}if(activeSelection&&activeSelection.file===state.current&&value.slice(activeSelection.start,activeSelection.end)===activeSelection.text)return activeSelection;return null}
function resetInlineCodexComposer(){const toolbar=$('selection-toolbar');toolbar.classList.remove('composing','sending');for(const composer of toolbar.querySelectorAll('.selection-codex-composer'))composer.hidden=true;$('selection-codex-prompt').value='';$('selection-comment-prompt').value=''}
function hideSelectionToolbar(){const toolbar=$('selection-toolbar');toolbar.hidden=true;resetInlineCodexComposer()}
let selectionPointer={x:0,y:0};
function captureEditorSelection(event={}){if(Number.isFinite(event.clientX)&&event.clientX>0)selectionPointer={x:event.clientX,y:event.clientY};const selection=editorSelection(),value=editorValue();if(selection.end<=selection.start){hideSelectionToolbar();return}activeSelection={file:state.current,start:selection.start,end:selection.end,text:value.slice(selection.start,selection.end)};const toolbar=$('selection-toolbar'),bounds=richEditor.dom.getBoundingClientRect();toolbar.hidden=false;requestAnimationFrame(()=>{const pointerX=selectionPointer.x||bounds.right-150;const pointerY=selectionPointer.y||bounds.top+70;const preferredLeft=pointerX+10;const left=preferredLeft+toolbar.offsetWidth<=innerWidth-10?preferredLeft:pointerX-toolbar.offsetWidth-10;const above=pointerY-toolbar.offsetHeight-10;const top=above>=bounds.top?above:pointerY+12;toolbar.style.setProperty('--selection-toolbar-left',`${Math.max(bounds.left+8,Math.min(left,innerWidth-toolbar.offsetWidth-10))}px`);toolbar.style.setProperty('--selection-toolbar-top',`${Math.max(58,Math.min(top,innerHeight-toolbar.offsetHeight-10))}px`)})}
function activateAssistantTab(id,{handoff=false,focus=false}={}){const panel=$('assistant-panel');setAssistantCollapsed(false);document.querySelectorAll('.tab').forEach(tab=>{const selected=tab.dataset.tab===id;tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus()});document.querySelectorAll('.assistant-content').forEach(content=>{content.classList.remove('tab-entering');content.classList.toggle('hidden',content.id!==id)});const active=$(id);$('assistant-tools').dispatchEvent(new Event('paper-tab-selected'));if(handoff){panel.classList.remove('assistant-handoff');void panel.offsetWidth;panel.classList.add('assistant-handoff');active.classList.add('tab-entering');panel.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});setTimeout(()=>{panel.classList.remove('assistant-handoff');active.classList.remove('tab-entering')},220)}}
function applyCodexRevision(selection,replacement){if(isLockedProjectFile()){alert('잠긴 파일은 수정할 수 없습니다.');return}if(selection.file!==state.current||editorValue().slice(selection.start,selection.end)!==selection.text){alert('Codex 요청 이후 원문이 변경되어 자동 적용하지 않았습니다. 다시 선택해 주세요.');return}richEditor.replaceRange(replacement,selection.start,selection.end,true);activeSelection={file:state.current,start:selection.start,end:selection.start+replacement.length,text:replacement};updateEditorMetadata();markProjectActivity('codex');hideSelectionToolbar();const apply=$('suggestion').querySelector('#apply-codex');if(apply){apply.textContent='✓ 원문에 적용됨';apply.disabled=true}}
function openInlineSelectionComposer(composerId,inputId,targetWidth=440){const toolbar=$('selection-toolbar'),composer=$(composerId),input=$(inputId);for(const item of toolbar.querySelectorAll('.selection-codex-composer'))item.hidden=item!==composer;composer.hidden=false;const width=Math.min(targetWidth,innerWidth-20);toolbar.style.setProperty('--composer-width',`${width}px`);requestAnimationFrame(()=>{if(toolbar.hidden||composer.hidden)return;toolbar.classList.add('composing');const currentLeft=parseFloat(toolbar.style.getPropertyValue('--selection-toolbar-left'))||toolbar.getBoundingClientRect().left;toolbar.style.setProperty('--selection-toolbar-left',`${Math.max(10,Math.min(currentLeft,innerWidth-width-10))}px`);input.focus()})}
function prepareCodexRequest(){const selection=selectedEditorRange();if(!selection)return;activeSelection=selection;openInlineSelectionComposer('selection-codex-composer','selection-codex-prompt')}
function prepareInlineComment(){const selection=selectedEditorRange();if(!selection)return;activeSelection=selection;openInlineSelectionComposer('selection-comment-composer','selection-comment-prompt',400)}
function closeInlineCodexComposer(){const toolbar=$('selection-toolbar');toolbar.classList.remove('composing');setTimeout(()=>{if(!toolbar.classList.contains('composing'))for(const composer of toolbar.querySelectorAll('.selection-codex-composer'))composer.hidden=true},120)}
function sendInlineCodexRequest(){const selection=activeSelection;const prompt=$('selection-codex-prompt');const instruction=prompt.value.trim();if(!instruction){prompt.focus();return}if(!selection||state.current!==selection.file||$('editor').value.slice(selection.start,selection.end)!==selection.text){hideSelectionToolbar();alert('선택한 원문이 변경되었습니다. 문장을 다시 선택해 주세요.');return}const toolbar=$('selection-toolbar');toolbar.classList.add('sending');$('instruction').value=instruction;hideSelectionToolbar();requestCodexRevision(selection,instruction,{handoff:true})}
function addCommentForSelection(selection,body){const comment={id:crypto.randomUUID(),anchor:selection.text.slice(0,90),body,file:selection.file,start:selection.start,end:selection.end,revision:Date.now(),actor:actor.name,color:actor.color,...collabSession.encodeRange(selection.file,selection.start,selection.end)};if(sharedMetadataReady)sharedComments.set(comment.id,comment);else state.comments.unshift(comment);listFiles();renderComments();save();markProjectActivity('comment')}
function sendInlineComment(){const selection=activeSelection,prompt=$('selection-comment-prompt'),body=prompt.value.trim();if(!body){prompt.focus();return}if(!selection||state.current!==selection.file||$('editor').value.slice(selection.start,selection.end)!==selection.text){hideSelectionToolbar();alert('선택한 원문이 변경되었습니다. 문장을 다시 선택해 주세요.');return}addCommentForSelection(selection,body);$('selection-comment-send').textContent='✓ 등록됨';hideSelectionToolbar();$('selection-comment-send').textContent='등록';activeSelection=null}
const codexProfiles={"luna-medium":{label:'6.1 Sol Light',model:'gpt-6.1-sol',reasoning:'low'},"luna-high":{label:'6.1 Sol Medium',model:'gpt-6.1-sol',reasoning:'medium'},"sol-high":{label:'6.1 Sol High',model:'gpt-6.1-sol',reasoning:'high'}};
const storedCodexProfile=preferences.get('paper-codex-profile');let codexProfile=codexProfiles[storedCodexProfile]?storedCodexProfile:'luna-medium';
function selectedCodexProfile(){return codexProfiles[codexProfile]||codexProfiles['luna-medium']}
function setCodexProfile(profile){if(!codexProfiles[profile])return;codexProfile=profile;preferences.set('paper-codex-profile',profile);$('selected-model-label').textContent=selectedCodexProfile().label;for(const input of document.querySelectorAll('input[name="codex-profile"]'))input.checked=input.value===profile}
function installCodexProfileSettings(){const instruction=$('instruction');setCodexProfile(codexProfile);instruction.placeholder='어떻게 다듬을까요?';instruction.addEventListener('keydown',event=>{if(event.key!=='Enter'||event.shiftKey||event.isComposing||event.keyCode===229)return;event.preventDefault();if(!$('ask').disabled)$('ask').click()});for(const input of document.querySelectorAll('input[name="codex-profile"]'))input.onchange=()=>{if(input.checked)setCodexProfile(input.value)}}
function ensureCodexThread(){let thread=$('codex-thread');if(thread)return thread;thread=document.createElement('div');thread.id='codex-thread';thread.className='codex-thread';thread.setAttribute('aria-live','polite');thread.hidden=true;$('codex-request-summary').after(thread);return thread}
function showSentCodexRequest(){$('codex-request-form').hidden=true;$('codex-request-summary').hidden=false;$('codex-request-text').hidden=true;$('codex-request-summary').querySelector('.codex-sent-badge').textContent='Codex 대화';$('codex-new-request').textContent='새 대화';$('codex-request-model').textContent=selectedCodexProfile().label;ensureCodexThread();window.WorkspaceI18n?.localize($('codex-request-summary'))}
let codexConversation=[],codexVisibleTurns=[],codexConversationEpoch=0,codexRequestController=null;
function codexTurnNode(turn,proposalNumber){const article=document.createElement('article');article.className=`codex-thread-turn codex-thread-turn-${turn.role}`;const head=document.createElement('header');head.className='codex-thread-turn-head';const label=document.createElement('strong');label.textContent=turn.role==='user'?'내 요청':'Codex 제안';const meta=document.createElement('small');meta.textContent=turn.role==='assistant'?`${proposalNumber} · ${turn.profile||''}`:turn.profile||'';head.append(label,meta);article.append(head);if(turn.role==='assistant'){const proposal=document.createElement('div');proposal.className='latex-preview codex-thread-proposal';proposal.innerHTML=latexPreview(turn.replacement||'');article.append(proposal);if(turn.summary){const summary=document.createElement('p');summary.className='codex-thread-summary';summary.textContent=turn.summary;article.append(summary)}}else{const request=document.createElement('p');request.className='codex-thread-request';request.textContent=turn.content;article.append(request)}return article}
function renderCodexThread({excludeLatestAssistant=false}={}){const thread=ensureCodexThread();let turns=codexVisibleTurns;if(excludeLatestAssistant&&turns.at(-1)?.role==='assistant')turns=turns.slice(0,-1);let proposalNumber=0;const nodes=turns.map(turn=>codexTurnNode(turn,turn.role==='assistant'?++proposalNumber:proposalNumber));thread.replaceChildren(...nodes);thread.hidden=!nodes.length;window.WorkspaceI18n?.localize(thread)}
function startNewCodexRequest(){codexConversationEpoch+=1;codexRequestController?.abort();codexRequestController=null;stopCodexThinking();$('ask').disabled=false;codexConversation=[];codexVisibleTurns=[];$('codex-request-summary').hidden=true;$('codex-request-form').hidden=false;$('instruction').value='';ensureCodexThread().replaceChildren();ensureCodexThread().hidden=true;$('suggestion').replaceChildren();$('assist').querySelector(':scope > .codex-followup')?.remove();requestAnimationFrame(()=>$('instruction').focus())}
let codexThinkingTimer=0,codexElapsedTimer=0;
const codexThinkingStages=['선택한 문장의 구조와 의도를 읽고 있습니다','현재 파일 문맥과 LaTeX 표현을 확인하고 있습니다','요청에 맞는 수정안을 구성하고 있습니다','원문의 의미와 변경 범위를 다시 검토하고 있습니다'];
function stopCodexThinking(){clearInterval(codexThinkingTimer);clearInterval(codexElapsedTimer);codexThinkingTimer=0;codexElapsedTimer=0}
function startCodexThinking(){stopCodexThinking();let stage=0,elapsed=0;$('suggestion').innerHTML=`<div class="suggestion codex-loading" role="status" aria-live="polite"><div class="codex-thinking-head"><span class="codex-thinking-spinner" aria-hidden="true"></span><span class="codex-thinking-copy"><strong>Codex가 원고를 검토하고 있습니다<span class="codex-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span></strong><small id="codex-thinking-stage" class="codex-thinking-stage">${codexThinkingStages[0]}</small><small id="codex-thinking-elapsed" class="codex-thinking-elapsed">0초 경과</small></span></div><div class="codex-thinking-progress" aria-hidden="true"></div></div>`;codexThinkingTimer=setInterval(()=>{stage=(stage+1)%codexThinkingStages.length;const target=$('codex-thinking-stage');if(!target)return;target.classList.remove('stage-changing');void target.offsetWidth;target.textContent=codexThinkingStages[stage];target.classList.add('stage-changing')},1800);codexElapsedTimer=setInterval(()=>{elapsed+=1;const target=$('codex-thinking-elapsed');if(target)target.textContent=`${elapsed}초 경과`},1000)}
function renderCodexResult(selection,result){$('assist').querySelector(':scope > .codex-followup')?.remove();const proposalNumber=Math.max(1,codexVisibleTurns.filter(turn=>turn.role==='assistant').length);$('suggestion').innerHTML=`<article class="suggestion codex-result"><header class="codex-result-head"><span class="codex-result-icon" aria-hidden="true">✦</span><span class="codex-result-head-text"><strong>Codex 수정안</strong><small>${esc(selectedCodexProfile().label)} · 원문을 바꾸기 전 검토하세요</small></span></header><div class="latex-preview codex-proposal">${latexPreview(result.replacement)}</div><details class="codex-change-details"><summary>원문과 변경 비교</summary><div class="codex-diff"><div class="diff-block diff-before">− ${esc(selection.text)}</div><div class="diff-block diff-after">+ ${esc(result.replacement)}</div></div></details>${result.summary?`<div class="codex-summary">${esc(result.summary)}</div>`:''}<div class="codex-followup"><div class="codex-followup-head"><strong>이 수정안을 더 다듬기</strong><span>${proposalNumber}번째 제안</span></div><div class="codex-followup-row"><textarea id="codex-followup-input" aria-label="Codex 후속 요청" placeholder="예: 좋긴 한데 너무 비슷해. 다른 제목 3개를 제안해줘"></textarea><button id="codex-followup-send" type="button">이어서 요청</button></div><div id="codex-followup-status" class="codex-followup-status" aria-live="polite">현재 선택과 이전 제안을 이어서 기억합니다.</div></div><div class="codex-result-actions"><button id="apply-codex">검토한 수정안을 원문에 적용</button></div></article>`;$('assist').append($('suggestion').querySelector('.codex-followup'));$('apply-codex').onclick=()=>applyCodexRevision(selection,result.replacement);$('codex-followup-send').onclick=()=>sendCodexFollowup(selection);$('codex-followup-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();sendCodexFollowup(selection)}})}
function sendCodexFollowup(selection){const input=$('codex-followup-input'),instruction=input.value.trim();if(!instruction){input.focus();return}requestCodexRevision(selection,instruction,{continuation:true})}
async function requestCodexRevision(selection,instruction,{handoff=false,continuation=false,displayInstruction=instruction}={}){
  if(!selection){alert('본문에서 수정할 문장을 먼저 선택해 주세요.');return}
  codexRequestController?.abort();
  const controller=new AbortController();
  codexRequestController=controller;
  if(!continuation)codexConversationEpoch+=1;
  const epoch=codexConversationEpoch;
  const superseded=()=>epoch!==codexConversationEpoch||codexRequestController!==controller;
  activateAssistantTab('assist',{handoff});hideSelectionToolbar();
  const history=continuation?codexConversation.slice(-4).map(turn=>({...turn,content:turn.content.slice(0,5000)})):[];
  if(!continuation){codexConversation=[];codexVisibleTurns=[];showSentCodexRequest()}
  const profile=selectedCodexProfile().label;
  codexConversation.push({role:'user',content:instruction});
  codexVisibleTurns.push({role:'user',content:displayInstruction,profile});
  renderCodexThread();
  const button=continuation?$('codex-followup-send'):$('ask');
  button.disabled=true;startCodexThinking();
  try{
    const response=await fetch('/api/codex',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({file:selection.file,selection:selection.text,instruction,source:state.files[selection.file],actor_id:actor.id,profile:codexProfile,history})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'Codex 요청 실패');
    if(superseded())return;
    stopCodexThinking();
    codexConversation.push({role:'assistant',content:JSON.stringify({replacement:result.replacement,summary:result.summary||''})});
    codexVisibleTurns.push({role:'assistant',replacement:result.replacement,summary:result.summary||'',profile});
    renderCodexThread({excludeLatestAssistant:true});renderCodexResult(selection,result);
  }catch(error){
    if(superseded())return;
    stopCodexThinking();codexConversation.pop();codexVisibleTurns.pop();renderCodexThread();
    $('suggestion').innerHTML=`<div class="suggestion"><strong>Codex 연결 오류</strong><br>${esc(error.message)}</div>`;
  }finally{
    if(!superseded()){stopCodexThinking();button.disabled=false;codexRequestController=null}
  }
}
function installSelectionTools(){const editor=$('editor'),surface=richEditor.contentDOM,toolbar=$('selection-toolbar');let selectionDrag=null;const finishSelectionDrag=event=>{if(!selectionDrag||event.pointerId!==selectionDrag.pointerId)return;const moved=selectionDrag.moved;selectionDrag=null;const selection=editorSelection();if(moved&&selection.end>selection.start)captureEditorSelection(event);else hideSelectionToolbar()};const cancelSelectionDrag=event=>{if(!selectionDrag||event.pointerId!==selectionDrag.pointerId)return;selectionDrag=null;hideSelectionToolbar()};surface.addEventListener('pointerdown',event=>{if(event.button!==0)return;selectionDrag={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,moved:false};hideSelectionToolbar()});document.addEventListener('pointermove',event=>{if(!selectionDrag||event.pointerId!==selectionDrag.pointerId||event.buttons!==1)return;selectionPointer={x:event.clientX,y:event.clientY};if(Math.hypot(event.clientX-selectionDrag.startX,event.clientY-selectionDrag.startY)>=3)selectionDrag.moved=true});document.addEventListener('pointerup',finishSelectionDrag);document.addEventListener('pointercancel',cancelSelectionDrag);surface.addEventListener('keyup',event=>{const selection=editorSelection();if(event.shiftKey&&selection.end>selection.start)captureEditorSelection()});editor.addEventListener('input',hideSelectionToolbar);editor.addEventListener('scroll',hideSelectionToolbar);toolbar.addEventListener('pointerdown',event=>{if(!event.target.closest('input'))event.preventDefault()});$('selection-comment').onclick=prepareInlineComment;$('selection-comment-send').onclick=sendInlineComment;$('selection-comment-close').onclick=closeInlineCodexComposer;$('selection-comment-prompt').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();sendInlineComment()}else if(event.key==='Escape'){event.preventDefault();closeInlineCodexComposer()}});$('selection-codex').onclick=prepareCodexRequest;$('selection-codex-send').onclick=sendInlineCodexRequest;$('selection-codex-close').onclick=closeInlineCodexComposer;$('selection-codex-prompt').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();sendInlineCodexRequest()}else if(event.key==='Escape'){event.preventDefault();closeInlineCodexComposer()}});document.addEventListener('pointerdown',event=>{if(!surface.contains(event.target)&&!toolbar.contains(event.target))hideSelectionToolbar()})}
function goToSourceLocation(file,line=1,column=0){
  const candidates=[file,`paper/${String(file).replace(/^paper\//,'')}`,...Object.keys(state.files).filter(path=>path.endsWith(`/${baseName(file)}`))];
  const target=candidates.find(path=>state.files[path]!==undefined);
  if(!target)return false;
  if(state.current&&state.files[state.current]!==undefined)state.files[state.current]=editorValue();
  state.current=target;setEditor();listFiles();
  const lines=editorValue().split('\n');const safeLine=Math.max(1,Math.min(Number(line)||1,lines.length));
  const start=lines.slice(0,safeLine-1).reduce((total,value)=>total+value.length+1,0)+Math.min(Number(column)||0,lines[safeLine-1].length);
  focusEditor();setEditorSelection(start,Math.min(start+lines[safeLine-1].length,editorValue().length));
  richEditor?.scrollTo(start);sendCursor();return true;
}
function synctexReference(){return renderedSynctex.startsWith('id:')?{compile_id:renderedSynctex.slice(3)}:{synctex_base64:renderedSynctex}}
async function requestSynctex(path,payload,generation=pdfRenderGeneration){
  const send=async reference=>{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,...reference})});const result=await response.json();return {response,result}};
  const attempt=await send(synctexReference());
  if(generation!==pdfRenderGeneration)return null;
  const fallback=renderedSynctexFallback;
  if(attempt.response.ok||!renderedSynctex.startsWith('id:')||!fallback||!/SyncTeX cache expired/i.test(String(attempt.result.error||'')))return attempt;
  const retry=await send({synctex_base64:fallback});
  if(generation!==pdfRenderGeneration)return null;
  if(retry.response.ok){renderedSynctex=fallback;renderedSynctexFallback=''}
  return retry;
}
async function syncSourceToPdf(){
  if(!renderedSynctex||!state.current.endsWith('.tex')||!canUseRenderedSynctex())return;
  const value=editorValue(),selection=editorSelection();const line=value.slice(0,selection.start).split('\n').length;const column=selection.start-(value.lastIndexOf('\n',selection.start-1)+1);
  const generation=pdfRenderGeneration,file=state.current;
  try{const attempt=await requestSynctex('/api/synctex-view',{file:file.replace(/^paper\//,''),line,column},generation);if(!attempt||generation!==pdfRenderGeneration||file!==state.current||!canUseRenderedSynctex())return;const {response,result}=attempt;if(!response.ok)throw new Error(result.error||'PDF 위치 검색 실패');const page=document.querySelector(`.pdf-page[data-page="${result.page}"]`);if(!page)throw new Error('렌더링된 PDF 페이지를 찾지 못했습니다.');page.scrollIntoView({behavior:'smooth',block:'center'});document.querySelectorAll('.pdf-source-highlight').forEach(marker=>marker.remove());const marker=document.createElement('span');marker.className='pdf-source-highlight';const scale=Number(page.dataset.scale)||1;marker.style.left=`${Math.max(0,result.x*scale)}px`;marker.style.top=`${Math.max(0,result.y*scale)}px`;marker.style.width=`${Math.max(24,result.width*scale)}px`;marker.style.height=`${Math.max(10,result.height*scale)}px`;page.append(marker);setTimeout(()=>marker.remove(),700)}catch(error){if(generation===pdfRenderGeneration)notify(error.message,{title:'소스 위치 연결 오류',tone:'error'})}
}
function lineForOffset(source,offset){return source.slice(0,Math.max(0,offset)).split('\n').length}
function sourceLocationFor(pattern){for(const [file,source] of Object.entries(state.files)){if(typeof source!=='string')continue;const match=typeof pattern==='string'?{index:source.indexOf(pattern)}:pattern.exec(source);if(match&&match.index>=0)return {file,line:lineForOffset(source,match.index)}}return null}
function parseLatexDiagnostics(message,entrypoint=selectedEntrypoint()){return parseCompileDiagnostics(message,entrypoint)}
function renderCompileDiagnostics(diagnostics=[],detail=''){latestCompileDiagnostics=diagnostics;latestCompileErrorDetail=String(detail||'').slice(-6000);const panel=$('compile-diagnostics'),list=$('compile-diagnostic-list'),fix=$('fix-compile-error');panel.hidden=!diagnostics.length;fix.hidden=!diagnostics.length||/제한 시간 안에 응답|timed out/i.test(latestCompileErrorDetail);list.replaceChildren(...diagnostics.map(item=>{const row=document.createElement('div');row.className='diagnostic-item';const symbol=document.createElement('span');symbol.className='check-symbol';symbol.textContent='!';const button=document.createElement('button');button.type='button';button.textContent=`${item.file}:${item.line} · ${item.message}`;button.onclick=()=>{if(innerWidth<=1180)activateFocusMode('source');goToSourceLocation(item.file,item.line)};row.append(symbol,button);return row}))}
function compileDiagnosticSelection(item){if(!item||!goToSourceLocation(item.file,item.line))return null;const source=editorValue(),lines=source.split('\n'),line=Math.max(1,Math.min(Number(item.line)||1,lines.length)),first=Math.max(1,line-10),last=Math.min(lines.length,line+10),starts=[];let offset=0;for(const value of lines){starts.push(offset);offset+=value.length+1}const start=starts[first-1],end=last<lines.length?starts[last]:source.length;return {file:state.current,start,end,text:source.slice(start,end)}}
async function requestCompileDiagnosticFix(){const item=latestCompileDiagnostics[0],selection=compileDiagnosticSelection(item);if(!item||!selection)return;const korean=document.documentElement.lang==='ko';const displayInstruction=korean?`${item.file}:${item.line}의 컴파일 오류를 AI로 고쳐줘.\n${item.message}`:`Fix the compile error at ${item.file}:${item.line} with AI.\n${item.message}`;const instruction=korean?`다음 LaTeX 컴파일 오류의 원인을 분석하고, 선택된 원문 범위 안에서 가장 작은 수정으로 고쳐줘. 논문의 의미와 서식은 유지하고 컴파일을 통과하는 수정안만 제안해줘.\n\n오류 위치: ${item.file}:${item.line}\n정규화된 오류: ${item.message}\n컴파일 로그:\n${latestCompileErrorDetail}`:`Analyze the following LaTeX compile error and fix it with the smallest change inside the selected source range. Preserve the manuscript's meaning and formatting, and propose only a revision that should compile.\n\nError location: ${item.file}:${item.line}\nNormalized error: ${item.message}\nCompiler log:\n${latestCompileErrorDetail}`;const button=$('fix-compile-error');button.disabled=true;button.setAttribute('aria-busy','true');try{await requestCodexRevision(selection,instruction,{handoff:true,displayInstruction})}finally{button.disabled=false;button.removeAttribute('aria-busy')}}
function allTexSources(){return Object.entries(state.files).filter(([path,value])=>path.endsWith('.tex')&&typeof value==='string')}
function allPaperSource(){return allTexSources().map(([,source])=>source).join('\n')}
function bibliographyCatalog(){const entries=[];for(const [file,source] of Object.entries(state.files))if(file.endsWith('.bib'))for(const entry of bibliographyEntries(source))entries.push({...entry,file});return entries}
function renderAssetInventory(){const source=allPaperSource();const items=Object.keys(state.assets).filter(path=>path.startsWith('paper/')).sort();$('asset-inventory-summary').textContent=`${items.length}개`;$('asset-inventory').replaceChildren(...items.map(path=>{const name=baseName(path);const stem=name.replace(/\.[^.]+$/,'');const used=source.includes(name)||source.includes(stem);const row=document.createElement('div');row.className='inventory-item';row.innerHTML=`<span class="check-symbol">${used?'●':'○'}</span>`;const button=document.createElement('button');button.type='button';button.textContent=`${name} · ${used?'본문에서 사용':'미사용'}`;button.onclick=()=>{const location=sourceLocationFor(name)||sourceLocationFor(stem);if(location)goToSourceLocation(location.file,location.line);else showAssetPreview(path)};row.append(button);return row}))}
function renderReferenceInventory(){const source=allPaperSource();const entries=bibliographyCatalog();const cited=new Set([...source.matchAll(/\\cite(?:t|p)?\{([^}]+)\}/g)].flatMap(match=>match[1].split(',').map(key=>key.trim().toLowerCase())));const counts=new Map();for(const entry of entries)counts.set(entry.key,(counts.get(entry.key)||0)+1);const missing=[...cited].filter(key=>!entries.some(entry=>entry.key===key));$('reference-inventory-summary').textContent=`${entries.length}개 · 누락 ${missing.length}`;const rows=[...missing.map(key=>({key,status:'인용 키 누락',kind:'missing'})),...entries.map(entry=>({key:entry.key,status:counts.get(entry.key)>1?'중복':cited.has(entry.key)?'사용 중':'미인용',file:entry.file,kind:counts.get(entry.key)>1?'duplicate':cited.has(entry.key)?'used':'unused'}))];$('reference-inventory').replaceChildren(...rows.slice(0,80).map(item=>{const row=document.createElement('div');row.className='inventory-item';row.innerHTML=`<span class="check-symbol">${item.kind==='used'?'●':'○'}</span>`;const button=document.createElement('button');button.type='button';button.textContent=`${item.key} · ${item.status}`;button.onclick=()=>{const location=item.file?sourceLocationFor(new RegExp(`@[A-Za-z]+\\s*\\{\\s*${item.key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`,'i')):sourceLocationFor(item.key);if(location)goToSourceLocation(location.file,location.line)};row.append(button);return row}))}
function importBibtex(){const input=$('bibtex-import');const incoming=input.value.trim();if(!incoming){input.focus();return}const parsed=bibliographyEntries(incoming);if(!parsed.length){alert('유효한 BibTeX 항목을 찾지 못했습니다.');return}const target=Object.keys(state.files).find(path=>path.endsWith('references.bib'))||Object.keys(state.files).find(path=>path.endsWith('.bib'))||'paper/references.bib';const existing=state.files[target]||'';const merged=mergeBibliography(existing,incoming);const added=bibliographyEntries(merged).length-bibliographyEntries(existing).length;state.files[target]=merged;input.value='';save();renderReferenceInventory();if(added)markCompileInputsChanged();alert(added?`${added}개 항목을 ${target}에 추가했습니다.`:'모든 citation key가 이미 존재합니다.')}
function addCheck(list,severity,message,location=null){list.push({severity,message,location})}
function runSubmissionChecks(){
  state.files[state.current]=editorValue();const source=allPaperSource();const checks=[];const entries=bibliographyCatalog();const bibKeys=new Set(entries.map(entry=>entry.key));const citations=[...source.matchAll(/\\cite(?:t|p)?\{([^}]+)\}/g)].flatMap(match=>match[1].split(',').map(key=>key.trim().toLowerCase()));
  const missingCitations=[...new Set(citations.filter(key=>!bibKeys.has(key)))];addCheck(checks,missingCitations.length?'error':'ok',missingCitations.length?`누락된 citation key ${missingCitations.length}개: ${missingCitations.slice(0,5).join(', ')}`:'모든 citation key가 bibliography에 존재합니다.',missingCitations[0]?sourceLocationFor(missingCitations[0]):null);
  const labels=new Set([...source.matchAll(/\\label\{([^}]+)\}/g)].map(match=>match[1]));const refs=[...source.matchAll(/\\(?:ref|eqref|autoref)\{([^}]+)\}/g)].map(match=>match[1]);const missingRefs=[...new Set(refs.filter(key=>!labels.has(key)))];addCheck(checks,missingRefs.length?'error':'ok',missingRefs.length?`정의되지 않은 label ${missingRefs.length}개: ${missingRefs.slice(0,5).join(', ')}`:'본문의 label/reference 연결이 일치합니다.',missingRefs[0]?sourceLocationFor(missingRefs[0]):null);
  const todos=[...source.matchAll(/(?:TODO|FIXME|\[추가 필요\]|TBD|XXX)/gi)];addCheck(checks,todos.length?'warning':'ok',todos.length?`임시 표기 ${todos.length}개가 남아 있습니다.`:'TODO·FIXME·임시 표기가 없습니다.',todos[0]?sourceLocationFor(todos[0][0]):null);
  const identity=source.match(/\\(?:author|affiliations?|thanks)\{(?!\s*(?:Anonymous(?:\s+Submission)?|)\s*\})([^}]*)\}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|orcid/gi);addCheck(checks,identity?'warning':'ok',identity?'저자·소속·이메일 또는 ORCID로 보이는 익명성 점검 항목이 있습니다.':'명백한 저자·소속·이메일·ORCID 노출을 찾지 못했습니다.',identity?sourceLocationFor(identity[0]):null);
  const includeMatches=[...source.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)];const available=new Set(Object.keys(state.assets).flatMap(path=>[path.replace(/^paper\//,''),baseName(path),path.replace(/^paper\//,'').replace(/\.[^.]+$/,'')]));const missingAssets=includeMatches.map(match=>match[1]).filter(name=>![name,baseName(name),name.replace(/\.[^.]+$/,'')].some(candidate=>available.has(candidate)));addCheck(checks,missingAssets.length?'error':'ok',missingAssets.length?`그림 파일 ${missingAssets.length}개를 찾을 수 없습니다: ${missingAssets.slice(0,4).join(', ')}`:'모든 includegraphics 대상이 프로젝트 자산에 있습니다.',missingAssets[0]?sourceLocationFor(missingAssets[0]):null);
  const pageCount=activePdfDocument?.numPages||0;const pageLimit=Number(projectManifest.page_limit)||0;addCheck(checks,!pageCount?'warning':pageLimit&&pageCount>pageLimit?'error':'ok',!pageCount?'정상 컴파일된 PDF가 없어 페이지 수를 확인할 수 없습니다.':pageLimit?`마지막 정상 PDF ${pageCount}페이지 · 설정된 제한 ${pageLimit}페이지`:`마지막 정상 PDF가 ${pageCount}페이지로 생성되었습니다.`);addCheck(checks,lastPdfAudit?.all_fonts_embedded?'ok':'warning',lastPdfAudit?.all_fonts_embedded?`PDF 글꼴 ${lastPdfAudit.font_count}개가 모두 포함되어 있습니다.`:lastPdfAudit?.unembedded_fonts?.length?`포함되지 않은 PDF 글꼴: ${lastPdfAudit.unembedded_fonts.join(', ')}`:'PDF 글꼴 포함 여부를 확인할 수 없습니다.');
  const unresolved=source.match(/\?\?/g)?.length||0;addCheck(checks,unresolved?'warning':'ok',unresolved?`소스에 ?? 문자열이 ${unresolved}개 있습니다.`:'소스에 남은 ?? 문자열이 없습니다.',unresolved?sourceLocationFor('??'):null);
  const errors=checks.filter(item=>item.severity==='error').length,warnings=checks.filter(item=>item.severity==='warning').length;$('submission-check-summary').textContent=`${checks.length}개 검사 · 오류 ${errors} · 확인 필요 ${warnings}`;$('submission-check-list').replaceChildren(...checks.map(item=>{const row=document.createElement('div');row.className=`check-item ${item.severity}`;row.innerHTML=`<span class="check-symbol">${item.severity==='ok'?'✓':item.severity==='error'?'!':'△'}</span>`;const button=document.createElement('button');button.type='button';button.textContent=item.message;if(item.location)button.onclick=()=>goToSourceLocation(item.location.file,item.location.line);row.append(button);return row}));renderAssetInventory();renderReferenceInventory();
}
function renderTaskBoard(){const board=$('task-board');if(!state.tasks.length){const empty=document.createElement('p');empty.className='hint';window.PaperI18n.setText(empty,'workspace.tasks.empty');board.replaceChildren(empty);return}board.replaceChildren(...state.tasks.map(task=>{const row=document.createElement('article');row.className=`task-card ${task.done?'done':''}`;const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=Boolean(task.done);toggle.setAttribute('aria-label',`${task.title} 완료`);toggle.onchange=()=>{const updated={...task,done:toggle.checked};if(sharedMetadataReady)sharedTasks.set(task.id,updated);else{Object.assign(task,updated);save();renderTaskBoard()}};const body=document.createElement('div');const label=document.createElement('div');label.className='task-label';label.textContent=task.title;const meta=document.createElement('div');meta.className='task-meta';meta.textContent=`${task.actor||'담당자 없음'} · ${task.file||'프로젝트'}`;body.append(label,meta);if(task.file){body.tabIndex=0;body.setAttribute('role','button');body.setAttribute('aria-label',`${task.title}, ${task.file} ${task.line||1}행으로 이동`);body.onclick=()=>goToSourceLocation(task.file,task.line||1);body.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();goToSourceLocation(task.file,task.line||1)}}}const remove=document.createElement('button');remove.type='button';remove.className='task-delete';remove.textContent='×';remove.setAttribute('aria-label',`${task.title} 삭제`);remove.onclick=()=>{if(sharedMetadataReady)sharedTasks.delete(task.id);else{state.tasks=state.tasks.filter(item=>item.id!==task.id);save();renderTaskBoard()}};row.append(toggle,body,remove);return row}))}
function addTask(){const input=$('task-title');const title=input.value.trim();if(!title){input.focus();return}const selection=editorSelection();const line=state.current.endsWith('.tex')?editorValue().slice(0,selection.start).split('\n').length:1;const task={id:crypto.randomUUID(),title:title.slice(0,160),actor:actor.name,file:state.current,line,done:false,created_at:new Date().toISOString()};if(sharedMetadataReady)sharedTasks.set(task.id,task);else state.tasks.unshift(task);input.value='';save();renderTaskBoard();markProjectActivity('task')}
async function createProjectZip({verifyCompile=false}={}){state.files[state.current]=editorValue();if(verifyCompile){const compiled=await runUpdate({fullBuild:true});if(!compiled)throw new Error('현재 소스가 컴파일되지 않아 제출 패키지를 만들지 않았습니다. 오류를 먼저 해결해 주세요.')}const payload=await compilePayload(),response=await fetch('/api/package',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),result=await response.json();if(!response.ok)throw new Error(result.error||'ZIP 생성 실패');const bytes=Uint8Array.from(atob(result.zip_base64),char=>char.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'})),link=document.createElement('a');link.href=url;link.download=`${projectSlug}-source-${new Date().toISOString().slice(0,10)}.zip`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);return result}
async function downloadSourcePackage(){const button=$('download-source-package');button.disabled=true;button.textContent='깨끗한 컴파일 확인 중…';try{const result=await createProjectZip({verifyCompile:true});$('submission-check-summary').textContent=`Source ZIP 생성 완료 · ${result.file_count}개 파일`}catch(error){alert(`제출 패키지를 만들지 못했습니다.\n${error.message}`)}finally{button.disabled=false;button.textContent='Source ZIP 만들기'}}
async function downloadProjectZip(){const button=$('download-project-zip');button.disabled=true;button.classList.add('loading');button.setAttribute('aria-busy','true');try{await createProjectZip();notify('현재 프로젝트 코드를 ZIP으로 저장했습니다.',{title:'코드 ZIP 준비 완료'})}catch(error){notify(error.message,{title:'코드 ZIP 생성 실패',tone:'error'})}finally{button.disabled=false;button.classList.remove('loading');button.removeAttribute('aria-busy')}}
function installAuthoringTools(){$('bibtex-import').setAttribute('aria-label','가져올 BibTeX 항목');$('task-title').setAttribute('aria-label','새 할 일 제목');$('name-input').setAttribute('aria-label','표시 이름');document.querySelectorAll('input[name="profile-color"]').forEach(input=>input.setAttribute('aria-label',input.closest('label')?.title||'프로필 색상'));$('action-dialog-input').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();$('action-dialog-confirm').click()}});$('name-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();$('save-name').click()}});$('run-submission-checks').onclick=runSubmissionChecks;$('download-source-package').onclick=downloadSourcePackage;$('download-project-zip').onclick=downloadProjectZip;$('import-bibtex').onclick=importBibtex;$('add-task').onclick=addTask;$('task-title').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();addTask()}});richEditor.contentDOM.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey){event.preventDefault();syncSourceToPdf()}});renderTaskBoard();renderAssetInventory();renderReferenceInventory()}
let compileQueue=Promise.resolve(),compileRevision=0,compileController=null,compileRequestGeneration=0;
function compileAfterSave(){const revision=++compileRevision;compileController?.abort();compileQueue=compileQueue.finally(()=>revision===compileRevision?runUpdate():undefined);return compileQueue}
function setRenderStateCompiling(file){const target=$('render-state'),label=window.PaperI18n.t('workspace.compile.compiling',{file});target.classList.add('compiling');target.removeAttribute('data-i18n');target.removeAttribute('data-i18n-variables');target.setAttribute('aria-label',label);target.innerHTML=`<span class="render-state-spinner" aria-hidden="true"></span><span class="render-state-label">${esc(label)}</span>`}
function setRenderStateMessage(key,variables={}){const target=$('render-state');target.classList.remove('compiling');target.removeAttribute('aria-label');window.PaperI18n.setText(target,key,variables)}
async function runUpdate(prepared={}){const generation=++compileRequestGeneration,contentRevision=prepared.contentRevision??workspaceContentRevision;compileController?.abort();const controller=new AbortController();compileController=controller;state.files[state.current]=editorValue();let payload=prepared.payload,fingerprint=prepared.fingerprint,compileTimedOut=false;let timeout=0;const current=()=>generation===compileRequestGeneration&&contentRevision===workspaceContentRevision&&!controller.signal.aborted;const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{compileTimedOut=true;controller.abort();reject(new DOMException('Compile request timed out','TimeoutError'))},compileRequestTimeoutMs)});try{payload=payload||await Promise.race([compilePayload(),deadline]);fingerprint=fingerprint||await Promise.race([compilePayloadFingerprint(payload),deadline]);if(prepared.fullBuild)payload={...payload,build_mode:'clean'};if(!current())return false;setRenderStateCompiling(payload.entrypoint);const headers={'Content-Type':'application/json','X-Compile-Client':compileClientId};if(compileStateId)headers['X-Compile-State']=compileStateId;const response=await fetch('/api/compile',{method:'POST',headers,body:JSON.stringify(payload),signal:controller.signal});const result=await response.json();if(!response.ok)throw new Error(result.error||'컴파일 실패');if(!current())return false;setCompileStateId(result.build_state_id);clearTimeout(timeout);const binary=base64Bytes(result.pdf_base64),synctex=result.synctex_base64||'';await renderPdfPreviewLazy(binary,result.compile_id?`id:${result.compile_id}`:synctex,synctex,current);if(!current())return false;lastPdfAudit=result.pdf_audit||null;renderCompileDiagnostics([]);setRenderStateMessage(result.cached?'workspace.compile.cached':'workspace.compile.current',{file:payload.entrypoint,seconds:(result.elapsed_ms/1000).toFixed(1)});setPdfFreshness(false);save();persistMainPageCount(payload).catch(error=>reportClientError(error,'persistMainPageCount'));persistPdfPreview(binary,synctex,fingerprint).catch(error=>reportClientError(error,'persistPdfPreview'));return true}catch(error){if(generation!==compileRequestGeneration||contentRevision!==workspaceContentRevision||error.name==='RenderingCancelledException'||(error.name==='AbortError'&&!compileTimedOut))return false;const hasPreviousPdf=Boolean(renderedPdfUrl),file=payload?.entrypoint||selectedEntrypoint();setRenderStateMessage(compileTimedOut?'workspace.compile.timeout':hasPreviousPdf?'workspace.compile.previousError':'workspace.compile.error',{file});setPdfFreshness(hasPreviousPdf);const message=compileTimedOut?'컴파일 서버가 제한 시간 안에 응답하지 않았습니다.':error.message;const diagnostics=parseLatexDiagnostics(message,payload?.entrypoint);renderCompileDiagnostics(diagnostics,message);if(!renderedPdfUrl){disposePdfPreview();resetPdfPageIndicator();const preview=$('paper-preview');preview.classList.remove('pdf-mode');preview.innerHTML=pdfErrorMarkup(diagnostics[0]);$('pdf-error-action')?.addEventListener('click',openPrimaryCompileDiagnostic)}if(hasPreviousPdf){if(compileTimedOut)notify('컴파일 응답이 지연되어 마지막 정상 PDF를 유지했습니다.',{title:'PDF 응답 시간 초과',tone:'error'});else notify('마지막 정상 PDF를 유지했습니다. 검사 탭에서 오류 위치를 확인하세요.',{title:'PDF 컴파일 오류',tone:'error'})}return false}finally{clearTimeout(timeout);if(compileController===controller)compileController=null}}
$('refresh-pdf').onclick=async()=>{const button=$('refresh-pdf');button.classList.add('loading');button.disabled=true;try{await runUpdate()}finally{button.classList.remove('loading');button.disabled=false}};
$('download-pdf').onclick=()=>{if(!renderedPdfUrl)return;const link=document.createElement('a');link.href=renderedPdfUrl;link.download=pdfFileName();document.body.append(link);link.click();link.remove()};
window.addEventListener('pagehide',event=>{if(event.persisted)return;++pdfRenderRequest;++pdfRenderGeneration;disposeAssetPdf();disposePdfPreview();if(renderedPdfUrl)URL.revokeObjectURL(renderedPdfUrl)});
async function createFile(folder='paper'){
  const name=cleanSegment(await actionDialog({title:'새 파일',message:`${folder||'프로젝트'}에 만들 파일 이름을 입력하세요.`,value:'section.tex',confirmLabel:'만들기'}));
  if(!name)return;
  const path=folder?`${folder}/${name}`:name;
  if(projectPathExists(path))return notify('같은 이름의 항목이 이미 있습니다.',{tone:'error'});
  state.files[path]='% 새 파일';state.current=path;
  for(let parent=folder;parent;parent=parentPath(parent))state.collapsedFolders=state.collapsedFolders.filter(item=>item!==parent);
  publishSharedTree();setEditor();listFiles();save();markCompileInputsChanged();markProjectActivity('file')
}
async function createFolder(parent=''){
  const name=cleanSegment(await actionDialog({title:'새 폴더',message:`${parent||'프로젝트 루트'} 아래에 만들 폴더 이름을 입력하세요.`,value:parent?'results':'experiments',confirmLabel:'만들기'}));
  if(!name)return;
  const path=parent?`${parent}/${name}`:name;
  if(projectPathExists(path))return notify('같은 이름의 항목이 이미 있습니다.',{tone:'error'});
  state.folders.push(path);
  for(let folder=parent;folder;folder=parentPath(folder))state.collapsedFolders=state.collapsedFolders.filter(item=>item!==folder);
  publishSharedTree();listFiles();save();markProjectActivity('folder')
}
const pathInTree=(candidate,root)=>candidate===root||candidate.startsWith(`${root}/`);
const renamedTreePath=(candidate,source,destination)=>pathInTree(candidate,source)?destination+candidate.slice(source.length):candidate;
function renameHasCollision(type,source,destination){
  if(type!=='folder')return projectPathExists(destination);
  const occupied=[...Object.keys(state.files),...Object.keys(state.assets),...state.folders];
  if(occupied.some(candidate=>pathInTree(candidate,destination)&&!pathInTree(candidate,source)))return true;
  const moving=[...Object.keys(state.files),...Object.keys(state.assets),...state.folders].filter(candidate=>pathInTree(candidate,source));
  const movingSet=new Set(moving);
  return moving.some(candidate=>{const target=renamedTreePath(candidate,source,destination);return occupied.includes(target)&&!movingSet.has(target)})
}
function canMutateTreeTarget(type,path){return !accountReadOnly&&Boolean(path)&&path!=='paper'&&path!=='paper/main.tex'&&!isLockedProjectFile(path)&&(type!=='folder'||!Object.keys(state.files).some(file=>pathInTree(file,path)&&isLockedProjectFile(file)))}
async function renameTarget(type,path){
  if(!canMutateTreeTarget(type,path))return;
  const name=cleanSegment(await actionDialog({title:'이름 변경',message:baseName(path),value:baseName(path),confirmLabel:'변경'}));
  if(!name||name===baseName(path)||!canMutateTreeTarget(type,path))return;
  const destination=parentPath(path)?`${parentPath(path)}/${name}`:name;
  if(renameHasCollision(type,path,destination))return notify('대상 위치에 같은 이름의 항목이 있어 변경하지 않았습니다.',{tone:'error'});
  const moves=type==='asset'&&state.assets[path]?.server?[{source:path,destination,asset:state.assets[path]}]:type==='folder'?Object.entries(state.assets).filter(([asset,metadata])=>metadata.server&&pathInTree(asset,path)).map(([source,asset])=>({source,destination:renamedTreePath(source,path,destination),asset})):[];
  try{if(moves.length)await moveServerAssetsSafely(moves)}catch(error){return notify(error.message,{title:'공유 자료 이름 변경 실패',tone:'error'})}
  const movedAssets=Object.keys(state.assets).filter(asset=>type==='asset'?asset===path:type==='folder'&&pathInTree(asset,path));
  if(type==='file'){
    state.files[destination]=state.files[path];delete state.files[path];if(state.current===path)state.current=destination
  }else if(type==='asset'){
    state.assets[destination]={...state.assets[path],server:state.assets[path].server};delete state.assets[path];state.uploads=state.uploads.map(item=>item===path?destination:item)
  }else{
    state.files=Object.fromEntries(Object.entries(state.files).map(([file,content])=>[renamedTreePath(file,path,destination),content]));
    state.assets=Object.fromEntries(Object.entries(state.assets).map(([file,content])=>[renamedTreePath(file,path,destination),content]));
    state.uploads=state.uploads.map(item=>renamedTreePath(item,path,destination));
    state.folders=state.folders.map(folder=>renamedTreePath(folder,path,destination));
    state.collapsedFolders=state.collapsedFolders.map(folder=>renamedTreePath(folder,path,destination));
    if(pathInTree(state.current,path))state.current=renamedTreePath(state.current,path,destination)
  }
  richEditor?.retainDocuments?.(Object.keys(state.files));publishSharedTree();
  const persistence=reconcileLocalAssets(movedAssets,movedAssets.map(asset=>renamedTreePath(asset,path,destination)));
  setEditor();listFiles();save();markCompileInputsChanged();markProjectActivity('rename');
  await persistence.catch(error=>notify(error.message,{title:'로컬 자료 저장 실패',tone:'error'}));
}
async function deleteTarget(type,path){
  if(!canMutateTreeTarget(type,path))return;
  if(!await actionDialog({title:'삭제',message:`'${baseName(path)}'을(를) 삭제할까요? 공동 편집자에게도 즉시 반영됩니다.`,confirmLabel:'삭제',tone:'danger'}))return;
  if(!canMutateTreeTarget(type,path))return;
  const serverPaths=type==='asset'&&state.assets[path]?.server?[path]:type==='folder'?Object.entries(state.assets).filter(([asset,metadata])=>metadata.server&&pathInTree(asset,path)).map(([asset])=>asset):[];
  try{for(const serverPath of serverPaths)await deleteServerAsset(serverPath)}catch(error){return notify(`${error.message} 삭제가 일부만 반영되었을 수 있으므로 파일 목록을 새로 확인해 주세요.`,{title:'공유 자료 삭제 실패',tone:'error'})}
  const removedAssets=Object.keys(state.assets).filter(asset=>type==='asset'?asset===path:type==='folder'&&pathInTree(asset,path));
  if(type==='file')delete state.files[path];
  else if(type==='asset'){delete state.assets[path];state.uploads=state.uploads.filter(item=>item!==path)}
  else{state.files=Object.fromEntries(Object.entries(state.files).filter(([file])=>!pathInTree(file,path)));state.assets=Object.fromEntries(Object.entries(state.assets).filter(([file])=>!pathInTree(file,path)));state.uploads=state.uploads.filter(item=>!pathInTree(item,path));state.folders=state.folders.filter(folder=>!pathInTree(folder,path));state.collapsedFolders=state.collapsedFolders.filter(folder=>!pathInTree(folder,path))}
  const persistence=reconcileLocalAssets(removedAssets);
  richEditor?.retainDocuments?.(Object.keys(state.files));publishSharedTree();if(!Object.hasOwn(state.files,state.current))state.current=Object.hasOwn(state.files,'paper/main.tex')?'paper/main.tex':Object.keys(state.files)[0];setEditor();listFiles();save();markCompileInputsChanged();markProjectActivity('delete');
  await persistence.catch(error=>notify(error.message,{title:'로컬 자료 삭제 실패',tone:'error'}));
}
$('new-file').onclick=()=>createFile(state.activeFolder||'paper');
$('new-folder').onclick=()=>createFolder('');
$('active-file-actions').onclick=event=>showTreeMenu(event,activeAsset?'asset':'file',activeAsset||state.current);
$('files').oncontextmenu=event=>{if(event.target===$('files'))showTreeMenu(event,'root','')};
let sidebarDragDepth=0;const sidebar=document.querySelector('.sidebar');sidebar.addEventListener('dragenter',event=>{if(!hasLocalFiles(event))return;event.preventDefault();sidebarDragDepth+=1;sidebar.classList.add('file-dragging')});sidebar.addEventListener('dragover',event=>{if(!hasLocalFiles(event))return;event.preventDefault();event.dataTransfer.dropEffect='copy'});sidebar.addEventListener('dragleave',event=>{if(!hasLocalFiles(event))return;sidebarDragDepth=Math.max(0,sidebarDragDepth-1);if(!sidebarDragDepth)clearDropState()});sidebar.addEventListener('drop',async event=>{if(!hasLocalFiles(event))return;event.preventDefault();sidebarDragDepth=0;clearDropState();await importLocalFiles(await droppedLocalFiles(event.dataTransfer),'paper')});
document.addEventListener('click',()=>{$('tree-menu').hidden=true});document.addEventListener('scroll',()=>{$('tree-menu').hidden=true},true);window.addEventListener('blur',()=>{$('tree-menu').hidden=true});
$('tree-menu').onclick=async event=>{const action=event.target.dataset.action;if(!action)return;const {type,path}=contextTarget;const folder=type==='folder'?path:type==='file'?parentPath(path):'';if(action==='new-file')await createFile(folder);if(action==='new-folder')await createFolder(folder);if(action==='upload'){pendingUploadFolder=folder;$('upload').click()}if(action==='rename')await renameTarget(type,path);if(action==='delete')await deleteTarget(type,path);$('tree-menu').hidden=true;};
$('tree-menu').addEventListener('keydown',event=>{if(event.key==='Escape'){$('tree-menu').hidden=true;if(treeMenuTrigger?.isConnected)treeMenuTrigger.focus();event.preventDefault();return}window.PaperUI.navigateMenu(event,$('tree-menu'))});
$('upload').onchange=async e=>{const folder=pendingUploadFolder||state.activeFolder||'paper';pendingUploadFolder='';await importLocalFiles(Array.from(e.target.files).map(file=>({file,relativePath:file.name})),folder);e.target.value='';};
document.querySelectorAll('.tab').forEach(tab=>{tab.onclick=()=>activateAssistantTab(tab.dataset.tab);tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const tabs=[...document.querySelectorAll('.tab')],current=tabs.indexOf(tab);const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;activateAssistantTab(tabs[next].dataset.tab,{focus:true});event.preventDefault()})});
function installAssistantTabScrolling(){
  const tabs=document.querySelector('.assistant-tabs'),previous=$('assistant-tabs-prev'),next=$('assistant-tabs-next');
  let pending=0;
  const update=()=>{
    const overflow=tabs.scrollWidth>tabs.parentElement.clientWidth+1,ko=window.PaperI18n?.getLanguage()==='ko';
    // Reserve both affordances while overflowing so revealing a tab does not
    // change its viewport width and clip the selected label a second time.
    previous.hidden=next.hidden=!overflow;
    previous.disabled=tabs.scrollLeft<1;
    next.disabled=tabs.scrollLeft+tabs.clientWidth>=tabs.scrollWidth-1;
    previous.setAttribute('aria-label',ko?'이전 도구':'Previous tools');next.setAttribute('aria-label',ko?'다음 도구':'More tools');
  };
  const revealSelected=()=>{
    pending=0;update();
    const selected=tabs.querySelector('[aria-selected="true"]');
    if(!selected||!tabs.clientWidth)return;
    const viewport=tabs.getBoundingClientRect(),active=selected.getBoundingClientRect(),inset=4;
    if(active.left<viewport.left+inset)tabs.scrollLeft+=active.left-viewport.left-inset;
    else if(active.right>viewport.right-inset)tabs.scrollLeft+=active.right-viewport.right+inset;
    update();
  };
  const scheduleReveal=()=>{if(!pending)pending=requestAnimationFrame(revealSelected)};
  for(const [button,direction] of [[previous,-1],[next,1]])button.onclick=()=>tabs.scrollBy({left:direction*Math.max(80,tabs.clientWidth*.75),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  tabs.addEventListener('scroll',update,{passive:true});tabs.addEventListener('paper-tab-selected',scheduleReveal);
  const sizes=new ResizeObserver(scheduleReveal);sizes.observe(tabs);tabs.querySelectorAll('.tab').forEach(tab=>sizes.observe(tab));
  window.PaperI18n?.onChange(scheduleReveal);document.fonts.ready.then(scheduleReveal);scheduleReveal();
}
installAssistantTabScrolling();
installCodexProfileSettings();
$('codex-new-request').onclick=startNewCodexRequest;
$('fix-compile-error').onclick=requestCompileDiagnosticFix;
$('ask').onclick=()=>{const instruction=$('instruction').value.trim();if(!instruction){$('instruction').focus();return}requestCodexRevision(selectedEditorRange(),instruction)};
$('add-comment').onclick=()=>{const selection=selectedEditorRange();const body=$('comment-body').value.trim();if(!selection||!body){alert('본문에서 문장을 드래그하고 댓글을 입력해 주세요.');return;}addCommentForSelection(selection,body);$('comment-body').value='';activeSelection=null;};
function syncRemoteManifestAssets(manifest){
  const nextItems=(manifest.files||[]).filter(manifestItemIsAsset),nextPaths=new Set(nextItems.map(item=>`paper/${item.path}`));
  for(const path of [...remoteAssetPaths]){
    if(nextPaths.has(path))continue;
    remoteAssetPaths.delete(path);remoteAssetSources.delete(path);
    if(state.assets[path]?.remote){delete state.assets[path];deleteLocalAsset(path).catch(()=>{})}
  }
  for(const item of nextItems){
    const name=`paper/${item.path}`,source=item.source||item.path;
    const url=projectFileUrl(source,manifest);
    const existing=state.assets[name]||{};
    // IndexedDB may still hold bytes fetched before this runtime revision.
    if(!runtimeFileRevision(manifest,source)||existing.runtimeSource!==url){
      delete existing.data;delete existing.loading;
    }
    remoteAssetPaths.add(name);remoteAssetSources.set(name,url);
    state.assets[name]={...existing,runtimeSource:runtimeFileRevision(manifest,source)?url:'',type:extensionOf(name)==='pdf'?'application/pdf':'application/octet-stream',size:Number(item.size)||existing.size||0,remote:true};
  }
  if(activeAsset&&!state.assets[activeAsset])setEditor()
}
async function loadProjectManifest(){const response=await fetch(`${projectBase}/project/project.json`,{cache:'no-store'});if(!response.ok)throw new Error('project.json을 찾지 못했습니다.');return normalizeManifest(await response.json())}
let workspacePersistenceReady;
async function loadProject(){
  await (workspacePersistenceReady??=workspacePersistence.initialize());
  projectManifest=await loadProjectManifest();
  for(const path of state.uploads)if(state.assets[path]?.data)await storeLocalAsset(path,state.assets[path]).catch(()=>{});
  state.assets={};
  await loadLocalAssets().catch(()=>{});
  await loadServerAssets().catch(error=>notify(error.message,{title:'공유 자산 연결 지연',tone:'warning'}));
  const previewSignal=AbortSignal.timeout(3000);
  const previewPromise=fetchPreviewArtifact(previewSignal);
  const initialPreviewPromise=previewPromise.then(async preview=>{
    if(preview)return preview;
    if(projectManifest.runtime_revision)return null;
    return fetchPersistedPdfPreview('',previewSignal);
  }).catch(error=>{if(!previewSignal.aborted)reportClientError(error,'fetchPersistedPdfPreview');return null});
  const remoteSources={};
  const manifestAssetPaths=new Set(projectManifest.files.filter(manifestItemIsAsset).map(item=>`paper/${item.path}`));
  remoteAssetPaths.clear();
  remoteAssetSources.clear();
  syncRemoteManifestAssets(projectManifest);
  for(const path of manifestAssetPaths)delete state.files[path];
  const requiredProjectSources=new Set(serverManagedManifestItems(projectManifest).map(item=>item.path));
  // Prioritize the visible manuscript while fetching the remaining files in parallel.
  const fetchSource=async item=>{
    const name=`paper/${item.path}`;
    const source=item.source||item.path;
    if(!manifestItemIsAsset(item)){
      const value=await fetchProjectSource(name,projectFileUrl(source),{required:requiredProjectSources.has(item.path),revision:runtimeFileRevision(projectManifest,source)});
      if(typeof value==='string')remoteSources[name]=value;
    }
  };
  const mainItem=projectManifest.files.find(item=>item.path==='main.tex'&&!manifestItemIsAsset(item));
  const rest=projectManifest.files.filter(item=>item!==mainItem);
  const restPromise=parallelLimit(rest,5,fetchSource).then(()=>null,error=>error);
  if(mainItem)await fetchSource(mainItem);
  if(typeof remoteSources['paper/main.tex']==='string'&&!isLatexDocument(state.files['paper/main.tex'])){
    state.files['paper/main.tex']=remoteSources['paper/main.tex'];
    if(state.current==='paper/main.tex'){setEditor();syncProjectTitleFromTex(true);window.__paperMarkStartupReady?.();$('save-state').textContent='서버 원고 표시됨 · 공동 편집 병합 중'}
  }
  const restError=await restPromise;if(restError)throw restError;
  // Paint the first usable source immediately. Safari can take longer to
  // finish IndexedDB/Yjs bootstrap for an established profile; manuscript
  // visibility must not depend on that background merge completing.
  const provisionalMain=state.files['paper/main.tex'];
  if(!isLatexDocument(provisionalMain)&&typeof remoteSources['paper/main.tex']==='string')state.files['paper/main.tex']=remoteSources['paper/main.tex'];
  for(const [name,value] of Object.entries(remoteSources))if(name!=='paper/main.tex'&&!isProjectSource(name,state.files[name]))state.files[name]=value;
  if(state.files[state.current]===undefined)state.current='paper/main.tex';
  setEditor();listFiles();syncProjectTitleFromTex(true);window.__paperMarkStartupReady?.();$('save-state').textContent='서버 원고 표시됨 · 공동 편집 병합 중';
  let persistedPreview=null,displayedPersistedFingerprint='';
  const initialPdfRequest=pdfRenderRequest;
  const initialPreviewRender=initialPreviewPromise.then(async preview=>{
    if(!preview||pdfRenderRequest!==initialPdfRequest)return;
    if(preview.fingerprint)persistedPreview=preview;
    if(await renderCachedPdf(preview)){
      displayedPersistedFingerprint=preview.fingerprint||'';
      if(!compileController)setRenderStateMessage('workspace.compile.lastSuccessful',{file:selectedEntrypoint()});
      setPdfFreshness(true);
    }
  });
  await collabBootstrapReady;
  projectBootstrapComplete=true;
  const remoteMain=remoteSources['paper/main.tex'];
  // Read the current shared value without allocating an empty manuscript.
  // Startup seeds the canonical text after the source and draft merge.
  const sharedMainValue=collabSession.files.get('paper/main.tex')?.toString()||'';
  const localMain=sharedMainValue||state.files['paper/main.tex'];
  const canCoordinateProjectUpgrade=collabSession.offline||collabSession.isBootstrapLeader?.()===true;
  let sharedProjectVersion=sharedProject.get('manifestVersion');
  if(typeof sharedProjectVersion!=='string')sharedProjectVersion='';
  if(!sharedProjectVersion&&canCoordinateProjectUpgrade){sharedProjectVersion=typeof state.projectVersion==='string'&&state.projectVersion?state.projectVersion:projectManifest.version;sharedProject.set('manifestVersion',sharedProjectVersion)}
  const sharedRuntimeRevision=String(sharedProject.get('serverRuntimeRevision')||''),hasServerRuntime=/^[0-9a-f]{64}$/.test(sharedRuntimeRevision);
  // Once a room has runtime metadata, only the collaboration server may apply
  // a staged source revision. The legacy version migration remains available
  // solely for rooms that predate the runtime-revision protocol.
  const projectVersionChanged=!hasServerRuntime&&canCoordinateProjectUpgrade&&Boolean(sharedProjectVersion&&sharedProjectVersion!==projectManifest.version);
  const serverManagedProjectFiles=new Set(projectManifest.files.filter(item=>item.managed).map(item=>`paper/${item.path}`));
  const retiredProjectFiles=new Set(projectManifest.retired_paths.map(path=>`paper/${path}`));
  collabSession.document.transact(()=>{for(const path of manifestAssetPaths)collabSession.files.delete(path)},actor.id);

  if(projectVersionChanged&&retiredProjectFiles.size){
    let retiredIndex=0;
    collabSession.document.transact(()=>{
      for(const path of retiredProjectFiles){
        const sharedValue=collabSession.files.get(path)?.toString?.();
        const localValue=typeof sharedValue==='string'&&sharedValue?sharedValue:state.files[path];
        const previousSnapshot=state.serverSourceSnapshots[path];
        const requiresPreservation=typeof localValue==='string'&&localValue&&(!previousSnapshot||!sourceSnapshotMatches(previousSnapshot,localValue));
        if(requiresPreservation){
          ensureFolder('paper/drafts');
          const safeName=baseName(path).replace(/[^A-Za-z0-9._-]/g,'_');
          const draftPath=`paper/drafts/retired-${Date.now()}-${retiredIndex++}-${safeName}`;
          state.files[draftPath]=localValue;
          replaceSharedText(collabSession.textFor(draftPath),localValue);
        }
        delete state.files[path];
        collabSession.files.delete(path);
        delete state.serverSourceSnapshots[path];
      }
    },actor.id);
    if(state.files[state.current]===undefined)state.current='paper/main.tex';
  }

  let preservedDraftPath='';
  if(hasServerRuntime){
    for(const path of retiredProjectFiles){
      if(collabSession.files.has(path)||typeof state.files[path]!=='string')continue;
      const value=state.files[path];
      delete state.files[path];
      if(state.current===path)state.current='paper/main.tex';
      if(!value||sourceSnapshotMatches(state.serverSourceSnapshots[path],value))continue;
      ensureFolder('paper/drafts');
      const draftPath=`paper/drafts/browser-before-server-sync-${crypto.randomUUID()}-${baseName(path)}`;
      state.files[draftPath]=value;
      preservedDraftPath||=draftPath;
    }
  }
  if(typeof remoteMain==='string'){
    if(hasServerRuntime){
      state.files['paper/main.tex']=collabSession.files.has('paper/main.tex')?sharedMainValue:remoteMain;
    }else if(projectVersionChanged&&isLatexDocument(sharedMainValue)&&sharedMainValue!==remoteMain){
      ensureFolder('paper/drafts');
      const previousVersion=state.projectVersion||'collaboration-draft';
      preservedDraftPath=`paper/drafts/${previousVersion}-${Date.now()}.tex`;
      state.files[preservedDraftPath]=sharedMainValue;
      state.files['paper/main.tex']=remoteMain;
      replaceSharedText(collabSession.textFor('paper/main.tex'),remoteMain);
      state.current='paper/main.tex';
    }else if(isLatexDocument(sharedMainValue)){
      state.files['paper/main.tex']=sharedMainValue;
      state.current=state.files[state.current]!==undefined?state.current:'paper/main.tex';
    }else if(!isLatexDocument(localMain)){
      if(typeof localMain==='string'&&localMain.trim()&&!looksLikeHtml(localMain)){ensureFolder('paper/drafts');state.files['paper/drafts/pre-analysis-main.tex']||=localMain;}
      state.files['paper/main.tex']=remoteMain;
      state.current='paper/main.tex';
    }else if(state.serverMainSnapshot&&!sourceSnapshotMatches(state.serverMainSnapshot,remoteMain)){
      if(!sourceSnapshotMatches(state.serverMainSnapshot,localMain)){ensureFolder('paper/drafts');preservedDraftPath=`paper/drafts/browser-before-server-sync-${Date.now()}.tex`;state.files[preservedDraftPath]=localMain;}
      state.files['paper/main.tex']=remoteMain;
      state.current='paper/main.tex';
    }else if(projectVersionChanged&&localMain!==remoteMain){
      ensureFolder('paper/drafts');
      const previousVersion=state.projectVersion||'browser-draft';
      preservedDraftPath=`paper/drafts/${previousVersion}.tex`;state.files[preservedDraftPath]||=localMain;
      state.files['paper/main.tex']=remoteMain;
      state.current='paper/main.tex';
    }
    state.serverMainSnapshot=sourceFingerprint(remoteMain);
  }

  for(const [name,value] of Object.entries(remoteSources)){
    if(name==='paper/main.tex')continue;
    if(hasServerRuntime&&serverManagedProjectFiles.has(name)){
      const sharedValue=collabSession.files.get(name)?.toString?.();
      if(typeof sharedValue==='string')state.files[name]=sharedValue;
      continue;
    }
    if(name==='paper/references.bib'){
      state.files[name]=mergeBibliography(state.files[name],value);
      if(projectVersionChanged&&serverManagedProjectFiles.has(name))replaceSharedText(collabSession.textFor(name),state.files[name]);
      if(serverManagedProjectFiles.has(name))state.serverSourceSnapshots[name]=sourceFingerprint(value);
      continue;
    }
    const localValue=state.files[name];
    const previousSnapshot=state.serverSourceSnapshots[name];
    const serverChanged=typeof previousSnapshot==='string'&&!sourceSnapshotMatches(previousSnapshot,value);
    const replaceManaged=serverManagedProjectFiles.has(name)&&(projectVersionChanged||serverChanged);
    if(!isProjectSource(name,localValue)||replaceManaged){
      if(isProjectSource(name,localValue)&&localValue!==value){
        ensureFolder('paper/drafts');
        const safeName=baseName(name).replace(/[^A-Za-z0-9._-]/g,'_');
        state.files[`paper/drafts/browser-before-server-sync-${Date.now()}-${safeName}`]=localValue;
      }
      state.files[name]=value;
      if(replaceManaged)replaceSharedText(collabSession.textFor(name),state.files[name]);
    }
    if(serverManagedProjectFiles.has(name))state.serverSourceSnapshots[name]=sourceFingerprint(value);
  }
  if(canCoordinateProjectUpgrade&&projectVersionChanged)sharedProject.set('manifestVersion',projectManifest.version);
  const synchronizedProjectVersion=sharedProject.get('manifestVersion');
  if(typeof synchronizedProjectVersion==='string'&&synchronizedProjectVersion)state.projectVersion=synchronizedProjectVersion;
  for(const [path,text] of collabSession.files){if(manifestAssetPaths.has(path)||(projectVersionChanged&&serverManagedProjectFiles.has(path)))continue;const value=text?.toString?.();if(typeof value==='string'&&(value||hasServerRuntime))state.files[path]=value}

  // Local input made while the server state was loading must survive the
  // authoritative rebind, even when another author changed the same file.
  for(const [path,value] of bootstrapEdits){
    if(value===state.files[path])continue;
    ensureFolder('paper/drafts');
    const draftPath=`paper/drafts/browser-connect-${crypto.randomUUID()}-${baseName(path)}`;
    state.files[draftPath]=value;
    replaceSharedText(collabSession.textFor(draftPath),value);
    preservedDraftPath||=draftPath;
  }
  bootstrapEdits.clear();
  initializeSharedMetadata();
  setEditor();projectTitleStartupPending=false;syncProjectTitleFromTex(true);if(!renderedPdfUrl&&!activePdfDocument)render();listFiles();save();initializeServerBackups();initializeServerSourceRefresh();
  if(preservedDraftPath&&!sourceConflictDismissed){sourceConflictBanner.hidden=false;$('open-preserved-draft').onclick=()=>{state.current=preservedDraftPath;setEditor();listFiles();sourceConflictBanner.hidden=true};notify('기존 브라우저 초안을 drafts에 보존했습니다.',{title:'서버 원본 변경 감지'})}
  if(typeof state.files[`paper/${projectManifest.entrypoint}`]==='string'){
    if(!document.querySelector('.preview-panel').getClientRects().length)await initialPreviewRender;
    workspaceReadyForCompile=true;updateMainCompileControl();
    try{const context=JSON.parse(sessionStorage.getItem(`paper-workspace-position:${projectSlug}`)||'null');if(context?.file===state.current){const length=editorValue().length;setEditorSelection(Math.min(length,Math.max(0,context.start||0)),Math.min(length,Math.max(0,context.end||0)));requestAnimationFrame(()=>{if(richEditor?.scrollDOM){richEditor.scrollDOM.scrollTop=context.scrollTop||0;richEditor.scrollDOM.scrollLeft=context.scrollLeft||0}})}}catch{}

    // A manifest preview has no source fingerprint; it is only a placeholder.
    // Validate against the merged manuscript even when a preview was displayed.
    {
      const contentRevision=workspaceContentRevision,payload=await compilePayload(),fingerprint=await compilePayloadFingerprint(payload);
      if(persistedPreview?.fingerprint!==fingerprint)persistedPreview=await fetchPersistedPdfPreview(fingerprint).catch(()=>null);
      if(contentRevision!==workspaceContentRevision)return;
      const renderedCached=persistedPreview?.fingerprint===fingerprint&&(displayedPersistedFingerprint===fingerprint||await renderCachedPdf(persistedPreview,()=>contentRevision===workspaceContentRevision));
      if(contentRevision!==workspaceContentRevision)return;
      if(renderedCached){setRenderStateMessage('workspace.compile.persisted',{file:payload.entrypoint});setPdfFreshness(false);persistMainPageCount(payload).catch(error=>reportClientError(error,'persistMainPageCount'))}
      else await runUpdate({payload,fingerprint,contentRevision});
    }
  }
  else{$('render-state').textContent='원고 로드 오류';$('suggestion').innerHTML='<div class="suggestion"><strong>원고를 불러오지 못했습니다.</strong><br>유효한 LaTeX 원고를 유지하고 서버 소스는 적용하지 않았습니다.</div>';}
}
function reportClientError(error,scope='runtime'){console.error(error);window.__paperReportError?.(`${scope}: ${error?.stack||error?.message||error}`)}
function installOptionalFeature(name,installer){try{installer()}catch(error){reportClientError(error,name);notify(`${name} 기능만 비활성화했습니다. 원고 편집은 계속 사용할 수 있습니다.`,{title:'일부 기능 호환 모드'})}}
initializeRichEditor();
// Start the manuscript request before optional UI features. A browser-specific
// failure in resizing, PDF helpers, or selection tools must never block source.
let projectLoadPromise
function ensureProjectLoaded(){
  if(!projectLoadPromise)projectLoadPromise=loadProject().catch(error=>{projectLoadPromise=undefined;projectTitleStartupPending=false;if(state.projectTitle)setProjectTitle(state.projectTitle);reportClientError(error,'loadProject');$('render-state').textContent='프로젝트 로드 오류';$('suggestion').innerHTML=`<div class="suggestion"><strong>원고 로드 오류</strong><br>${esc(error.message)}</div>`;notify(error.message,{title:'원고를 불러오지 못했습니다.',tone:'error'})})
  return projectLoadPromise
}
if(/^\/p\/[^/]+\/rebuttal(?:\/|$)/.test(location.pathname) || new URLSearchParams(location.search).get('view')==='reviews')void loadReviewProjectTitle();
else ensureProjectLoaded();
document.addEventListener('visibilitychange',sendCursor);window.addEventListener('focus',sendCursor);window.addEventListener('blur',sendCursor);document.addEventListener('focusin',sendCursor);document.addEventListener('focusout',sendCursor);collabBootstrapReady.then(()=>{lastCursorPayload='';sendCursor();restorePaperPresenceLocation()});
installOptionalFeature('초기 편집 화면',setEditor);installOptionalFeature('초기 파일 목록',listFiles);installOptionalFeature('초기 댓글',renderComments);installOptionalFeature('초기 PDF 화면',render);
for(const [name,installer] of [['본문 컴파일 고정',installMainCompileControl],['패널 조절',installPanelResizers],['집중 화면',installFocusModes],['확대·축소',installZoomControls],['자료 미리보기',installAssetViewer],['PDF 페이지 표시',installPdfPageIndicator],['편집기 단축키',installEditorShortcuts],['선택 영역 도구',installSelectionTools],['논문 작성 도구',installAuthoringTools],['상태 센터',installStatusCenter]])installOptionalFeature(name,installer);
$('file-search').addEventListener('input',applyFileFilter);$('clear-file-search').onclick=()=>{$('file-search').value='';applyFileFilter();$('file-search').focus()};$('editor').addEventListener('input',()=>{syncProjectTitleFromTex();renderRemoteCursors();renderCommentAnchors()});$('editor').addEventListener('scroll',()=>{renderRemoteCursors();renderCommentAnchors()});window.addEventListener('resize',()=>{requestAnimationFrame(refreshEditorLayout);renderRemoteCursors();renderCommentAnchors()});window.addEventListener('pagehide',event=>{try{const selection=editorSelection();sessionStorage.setItem(`paper-workspace-position:${projectSlug}`,JSON.stringify({file:state.current,...selection,scrollTop:richEditor?.scrollDOM?.scrollTop||0,scrollLeft:richEditor?.scrollDOM?.scrollLeft||0}))}catch{}if(!event.persisted){clearTimeout(window.saveTimer);clearTimeout(serverSourceRefreshTimer)}if(!activeAsset&&!isLockedProjectFile()&&state.current&&state.files[state.current]!==undefined)state.files[state.current]=editorValue();save({keepRecovery:true});if(!event.persisted){richEditor?.destroy();collabSession.destroy()}});
window.addEventListener('pageshow',event=>{if(event.persisted){refreshEditorLayout();lastCursorPayload='';sendCursor();schedulePdfPageIndicatorUpdate()}});

if(accountReadOnly){
  document.body.dataset.accessRole='viewer';
  for(const id of ['new-file','new-folder','upload','upload-button','add-task','add-comment','backup-now','create-checkpoint']){
    const element=document.getElementById(id);if(element)element.disabled=true;
  }
  const badge=document.createElement('span');badge.textContent=window.PaperI18n?.getLanguage()==='ko'?'열람 전용':'Read only';
  badge.setAttribute('role','status');badge.style.cssText='padding:4px 8px;font-size:12px;color:var(--theme-text-secondary)';
  document.getElementById('active-file')?.after(badge);
}
