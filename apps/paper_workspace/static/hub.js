const list=document.getElementById('project-list');
const search=document.getElementById('project-search');
const slugPattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
let projects=[];
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function renderProjects(){
  const query=search.value.trim().toLowerCase();
  const visible=projects.filter(project=>`${project.display_name||''} ${project.description||''} ${project.slug||''}`.toLowerCase().includes(query));
  if(!visible.length){list.innerHTML='<div class="empty-card">검색 조건에 맞는 논문이 없습니다.</div>';return}
  list.innerHTML=visible.map(project=>{
    if(!slugPattern.test(project.slug||''))return '';
    const title=escapeHtml(project.display_name||project.slug);
    const description=escapeHtml(project.description||'논문 작업공간');
    const updated=escapeHtml(project.updated_at||'');
    return `<a class="project-card" href="/p/${encodeURIComponent(project.slug)}"><div class="project-card-top"><span class="project-icon">T</span><span class="project-arrow" aria-hidden="true">↗</span></div><h3>${title}</h3><p>${description}</p><div class="project-meta"><code>/p/${escapeHtml(project.slug)}</code>${updated?`<span>${updated}</span>`:''}</div></a>`;
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
loadProjects();
