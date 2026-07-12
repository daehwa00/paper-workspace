const list=document.getElementById('project-list');
const search=document.getElementById('project-search');
const sort=document.getElementById('project-sort');
const avatar=document.getElementById('hub-collab-name');
const nameDialog=document.getElementById('hub-name-dialog');
const nameInput=document.getElementById('hub-name-input');
const slugPattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const thumbnailPattern=/^\/projects\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/thumbnail\.(?:png|jpe?g|webp)$/i;
let projects=[];
sort.value=localStorage.getItem('paper-workspace:project-sort')||'recent';
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const collaboratorInitial=name=>{const words=String(name||'').trim().split(/\s+/).filter(Boolean);return (words.length>1?words.slice(0,2).map(word=>word[0]).join(''):words[0]?.slice(0,2)||'?').toUpperCase()};
const profileColors=['#2457d6','#7c3aed','#0891b2','#059669','#d97706','#dc2626','#db2777'];
nameInput.setAttribute('aria-label','표시 이름');
document.querySelectorAll('input[name="hub-profile-color"]').forEach(input=>input.setAttribute('aria-label',input.closest('label')?.title||'프로필 색상'));
function currentProfile(){let storedName=localStorage.getItem('collab-name');if(storedName==='daehwa'&&!localStorage.getItem('collab-name-user-set')){storedName='나';localStorage.setItem('collab-name',storedName)}const name=(storedName||'나').trim()||'나';const storedColor=localStorage.getItem('collab-color');return{name,color:profileColors.includes(storedColor)?storedColor:'#2457d6'}}
function paintAvatar(){const profile=currentProfile();avatar.textContent=collaboratorInitial(profile.name);avatar.style.background=profile.color;avatar.title=`${profile.name} · 표시 이름 변경`;avatar.setAttribute('aria-label',`${profile.name} 프로필 설정`)}
function localProjectState(slug){try{const draft=JSON.parse(localStorage.getItem(`paper-workspace:${slug}`)||'null');const comments=Array.isArray(draft?.comments)?draft.comments.length:0;const tasks=Array.isArray(draft?.tasks)?draft.tasks.filter(task=>!task.done).length:0;const edited=Boolean(draft?.files&&Object.keys(draft.files).length);const lastActive=Number(localStorage.getItem(`paper-workspace:last-active:${slug}`))||0;return{comments,tasks,edited,lastActive}}catch{return{comments:0,tasks:0,edited:false,lastActive:0}}}
function sortedProjects(items){const decorated=items.map((project,index)=>({project,index,local:localProjectState(project.slug)}));if(sort.value==='name')decorated.sort((left,right)=>String(left.project.display_name||left.project.slug).localeCompare(String(right.project.display_name||right.project.slug),'ko'));else if(sort.value==='comments')decorated.sort((left,right)=>right.local.comments-left.local.comments||right.local.lastActive-left.local.lastActive||left.index-right.index);else decorated.sort((left,right)=>right.local.lastActive-left.local.lastActive||left.index-right.index);return decorated}
function renderSession(authenticated){avatar.hidden=!authenticated;if(authenticated)paintAvatar()}
async function loadSession(){try{const response=await fetch('/_auth/verify',{headers:{Accept:'application/json'},cache:'no-store'});renderSession(response.ok)}catch{renderSession(false)}}
avatar.addEventListener('click',()=>{const profile=currentProfile();nameInput.value=profile.name;document.querySelector(`input[name="hub-profile-color"][value="${profile.color}"]`).checked=true;nameDialog.showModal();nameInput.focus()});
nameInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();nameDialog.close('confirm')}});
nameDialog.addEventListener('close',()=>{if(nameDialog.returnValue!=='confirm')return;const name=nameInput.value.trim();const color=document.querySelector('input[name="hub-profile-color"]:checked')?.value;if(!name)return;localStorage.setItem('collab-name',name.slice(0,32));localStorage.setItem('collab-name-user-set','1');if(profileColors.includes(color))localStorage.setItem('collab-color',color);paintAvatar()});
window.addEventListener('storage',event=>{if(!avatar.hidden&&(event.key==='collab-name'||event.key==='collab-color'))paintAvatar()});
window.addEventListener('focus',()=>{if(!avatar.hidden)paintAvatar()});
function renderProjects(){
  const query=search.value.trim().toLowerCase();
  const visible=sortedProjects(projects.filter(project=>`${project.display_name||''} ${project.description||''} ${project.slug||''}`.toLowerCase().includes(query)));
  list.setAttribute('aria-busy','false');
  if(!visible.length){list.innerHTML='<div class="empty-card">검색 조건에 맞는 논문이 없습니다.</div>';return}
  list.innerHTML=visible.map(({project,local})=>{
    if(!slugPattern.test(project.slug||''))return '';
    const title=escapeHtml(project.display_name||project.slug);
    const description=escapeHtml(project.description||'논문 작업공간');
    const updated=escapeHtml(project.updated_at||'');
    const thumbnail=thumbnailPattern.test(project.thumbnail||'')?project.thumbnail:'';
    const visual=thumbnail?`<div class="project-thumbnail-wrap"><img class="project-thumbnail" src="${escapeHtml(thumbnail)}" alt="${title} 첫 페이지 미리보기" loading="lazy" /></div>`:'<span class="project-icon">T</span>';
    const meta=[updated,local.edited?'편집 기록 있음':'',local.comments?`댓글 ${local.comments}`:'',local.tasks?`할 일 ${local.tasks}`:''].filter(Boolean);
    return `<a class="project-card" href="/p/${encodeURIComponent(project.slug)}"><div class="project-card-top">${visual}<svg class="project-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg></div><div class="project-card-copy"><h3>${title}</h3><p>${description}</p></div>${meta.length?`<div class="project-meta">${meta.map(item=>`<span>${escapeHtml(item)}</span>`).join('')}</div>`:''}</a>`;
  }).join('')||'<div class="empty-card">표시할 수 있는 논문이 없습니다.</div>';
}
async function loadProjects(){
  try{
    const response=await fetch('/projects/index.json',{cache:'no-store'});
    if(!response.ok)throw new Error('프로젝트 목록을 불러오지 못했습니다.');
    const payload=await response.json();
    projects=Array.isArray(payload)?payload:(Array.isArray(payload.projects)?payload.projects:[]);
    renderProjects();
  }catch(error){list.innerHTML=`<div class="empty-card">${escapeHtml(error.message)}<br><small>서버의 projects/index.json을 확인하세요.</small></div>`}
}
search.addEventListener('input',renderProjects);
sort.addEventListener('change',()=>{localStorage.setItem('paper-workspace:project-sort',sort.value);renderProjects()});
loadProjects();
loadSession();
