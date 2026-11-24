const backupIntervalMs=10*60*1000;
let backupInitialized=false;
let backupBusy=false;
let backupIdlePromise=Promise.resolve();
let resolveBackupIdle=null;
function backupProjectId(){return backupManifestId(projectManifest)}
function backupApi(path=''){return `/api/backups/projects/${backupProjectId()}/snapshots${path}`}
function backupPayload({includeRebuttal=true}={}){
  if(!activeAsset&&!isLockedProjectFile()&&state.current&&state.files[state.current]!==undefined)state.files[state.current]=editorValue();
  const rebuttal=includeRebuttal?rebuttalBackup()?.snapshot():null;
  return {title:String(state.projectTitle||titleOf(state.files['paper/main.tex']||'')||'Untitled Paper').slice(0,160),files:Object.fromEntries(Object.entries(state.files).filter(([,content])=>typeof content==='string').sort(([left],[right])=>left.localeCompare(right))),comments:Array.isArray(state.comments)?state.comments:[],tasks:Array.isArray(state.tasks)?state.tasks:[],...(rebuttal?{rebuttal}:{})};
}
function setBackupStatus(message,createdAt=null){const status=$('backup-status');status.textContent=message;const time=createdAt?new Date(createdAt).getTime():NaN;const age=Number.isFinite(time)?Date.now()-time:null;status.dataset.health=/오류|실패|error|failed/i.test(message)?'error':age!==null&&age>24*60*60*1000?'error':age!==null&&age>30*60*1000?'warning':/저장하는 중|불러오는 중|대기|saving|loading|waiting/i.test(message)?'pending':'ok'}
function backupDate(value){const date=new Date(value);return Number.isNaN(date.getTime())?(window.PaperI18n?.t('시간 정보 없음')||'Time unavailable'):window.PaperI18n?.formatDate(date)||new Intl.DateTimeFormat('en-US',{dateStyle:'short',timeStyle:'short'}).format(date)}
function renderBackupHistory(items){
  const list=$('backup-list');
  if(!items.length){list.innerHTML='<p class="backup-empty">아직 서버 백업이 없습니다.</p>';return}
  list.replaceChildren(...items.map(snapshot=>{
    const id=String(snapshot.id||snapshot.snapshot_id||'');
    const card=document.createElement('article');card.className='backup-card';
    const meta=document.createElement('div');meta.className='backup-card-meta';
    const title=document.createElement('strong');title.textContent=snapshot.title||snapshot.payload?.title||'논문 백업';
    const detail=document.createElement('span');const reason=String(snapshot.reason||'auto').startsWith('checkpoint:')?`버전 · ${String(snapshot.reason).slice(11)}`:snapshot.reason==='manual'?'수동':snapshot.reason==='pre-restore'?'복원 전':'자동';detail.textContent=`${backupDate(snapshot.checked_at||snapshot.checkedAt||snapshot.created_at||snapshot.createdAt)} · ${reason}${snapshot.actor?` · ${snapshot.actor}`:''}`;
    const actions=document.createElement('div');actions.className='tool-row';const compare=document.createElement('button');compare.type='button';compare.className='backup-restore';compare.textContent='비교';compare.disabled=!id;compare.onclick=()=>compareServerBackup(id,compare);const restore=document.createElement('button');restore.type='button';restore.className='backup-restore';restore.textContent='복원';restore.disabled=!id||accountReadOnly;restore.onclick=()=>restoreServerBackup(id,restore);
    actions.append(compare,restore);meta.append(title,detail);card.append(meta,actions);return card
  }))
}
async function loadBackupHistory(){
  try{const response=await fetch(backupApi(),{headers:{Accept:'application/json'},cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'백업 기록을 불러오지 못했습니다.');const items=backupItems(result);renderBackupHistory(items);const latest=items[0]?.checked_at||items[0]?.checkedAt||items[0]?.created_at||items[0]?.createdAt;setBackupStatus(items.length?`최근 백업 확인 ${backupDate(latest)}`:'10분 자동 백업 대기 중',latest);}
  catch(error){renderBackupHistory([]);setBackupStatus(`연결 오류 · ${error.message}`)}
}
async function createServerBackup(reason='manual',{quiet=false}={}){
  if(accountReadOnly||(restorePending&&reason!=='pre-restore'))return false;
  if(!hasDisplayName(actor.name))return false;
  if(backupBusy){if(reason!=='pre-restore')return false;await backupIdlePromise;return createServerBackup(reason,{quiet})}
  backupBusy=true;backupIdlePromise=new Promise(resolve=>{resolveBackupIdle=resolve});$('create-backup').disabled=true;setBackupStatus(reason==='pre-restore'?'현재 상태를 보존하는 중…':'서버에 저장하는 중…');
  try{await rebuttalBackup()?.refresh();const snapshot=backupPayload();const response=await fetch(backupApi(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({snapshot,actor:actor.name,reason})});const result=await response.json();if(!response.ok)throw new Error(result.error||'백업에 실패했습니다.');await loadBackupHistory();setBackupStatus(result.deduplicated?'변경 없음 · 백업 확인 완료':`백업 완료 · ${backupDate(result.checked_at||result.snapshot?.checked_at||result.created_at||result.snapshot?.created_at||Date.now())}`);return true}
  catch(error){setBackupStatus(`백업 실패 · ${error.message}`);if(!quiet)alert(`서버 백업에 실패했습니다.\n${error.message}`);return false}
  finally{backupBusy=false;resolveBackupIdle?.();resolveBackupIdle=null;$('create-backup').disabled=false}
}
function applyBackupSnapshot(snapshot){
  state.files=snapshot.files;
  state.comments=snapshot.comments;
  state.tasks=snapshot.tasks;
  state.projectTitle=snapshot.title||state.projectTitle;
  state.current=state.files[state.current]!==undefined?state.current:(state.files['paper/main.tex']!==undefined?'paper/main.tex':Object.keys(state.files)[0]);
  state.folders=[...new Set(['paper',...Object.keys(state.files).map(parentPath).filter(Boolean)])];
  richEditor?.retainDocuments?.(Object.keys(state.files));
  sharedText?.unobserve(sharedTextObserver);
  sharedText=null;
  // Metadata observers save immediately, so they must see the restored editor
  // and all shared maps from the same transaction.
  setEditorValueWithoutActivity(state.files[state.current]);
  if(sharedMetadataReady)collabSession.document.transact(()=>{
    replaceSharedMap(sharedComments,state.comments,item=>item.id||item.revision);
    replaceSharedMap(sharedTasks,state.tasks,item=>item.id);
    publishSharedTree();
  },actor.id);
}
let restorePending=false;
async function restoreServerBackup(snapshotId,button){
  if(accountReadOnly||restorePending)return;
  restorePending=true;button.disabled=true;
  let restoreOwnsBackup=false;

  try{
    if(!await actionDialog({title:'백업 복원',message:'이 백업으로 원고를 복원할까요? 현재 상태는 먼저 별도 백업으로 저장됩니다.',confirmLabel:'복원'}))return;
    await rebuttalBackup()?.refresh();
    const manuscriptRevision=()=>{
      const manuscript=backupPayload({includeRebuttal:false});
      const live=Array.from(collabSession.files,([path,text])=>[path,text.toString()]);
      return JSON.stringify([manuscript,live]);
    };
    const restoreGuard=manuscriptRevision();
    const restoreRevision=workspaceContentRevision,liveRevision=sharedFileRevision;
    const assertRestoreCurrent=()=>{
      if(sharedFileRevision!==liveRevision||workspaceContentRevision!==restoreRevision||manuscriptRevision()!==restoreGuard)
        throw new Error('복원 중 새 편집 내용이 감지되어 덮어쓰기를 중단했습니다. 다시 비교한 뒤 복원해 주세요.');
    };
    if(!await createServerBackup('pre-restore'))return;
    backupBusy=true;restoreOwnsBackup=true;$('create-backup').disabled=true;
    setBackupStatus('백업을 복원하는 중…');
    assertRestoreCurrent();
    const response=await fetch(backupApi(`/${encodeURIComponent(snapshotId)}`),{headers:{Accept:'application/json'},cache:'no-store'});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'백업을 불러오지 못했습니다.');
    const snapshot=validateBackupSnapshot(extractBackupSnapshot(result));
    assertRestoreCurrent();
    await rebuttalBackup()?.restore(snapshot.rebuttal);
    assertRestoreCurrent();
    applyBackupSnapshot(snapshot);
    setProjectTitle(state.projectTitle||titleOf(state.files['paper/main.tex']||''));setEditor();listFiles();renderComments();renderTaskBoard();save();markProjectActivity('restore');setBackupStatus(`복원 완료 · ${backupDate(result.created_at||result.snapshot?.created_at||Date.now())}`);await runUpdate()}
  catch(error){setBackupStatus(`복원 실패 · ${error.message}`);alert(`백업을 복원하지 못했습니다.\n${error.message}`)}
  finally{restorePending=false;button.disabled=false;if(restoreOwnsBackup){backupBusy=false;$('create-backup').disabled=false}}
}
async function compareServerBackup(snapshotId,button){button.disabled=true;try{const response=await fetch(backupApi(`/${encodeURIComponent(snapshotId)}`),{headers:{Accept:'application/json'},cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'버전을 불러오지 못했습니다.');const snapshot=validateBackupSnapshot(extractBackupSnapshot(result));const {changed,added,removed,modified}=compareBackupFiles(snapshot.files,backupPayload().files);const panel=$('backup-diff');panel.hidden=false;panel.textContent=changed.length?`현재 버전과 비교: 수정 ${modified.length} · 추가 ${added.length} · 삭제 ${removed.length} — ${changed.slice(0,6).join(', ')}${changed.length>6?'…':''}`:'현재 원고와 동일합니다.'}catch(error){alert(`버전을 비교하지 못했습니다.\n${error.message}`)}finally{button.disabled=false}}
function initializeServerBackups(){if(backupInitialized)return;backupInitialized=true;loadBackupHistory().finally(()=>createServerBackup('auto',{quiet:true}));setInterval(()=>createServerBackup('auto',{quiet:true}),backupIntervalMs)}
async function createNamedCheckpoint(){const input=$('checkpoint-name');const name=input.value.trim().replace(/[\r\n]+/g,' ').slice(0,68);if(!name){input.focus();return}const created=await createServerBackup(`checkpoint:${name}`);if(created)input.value=''}
