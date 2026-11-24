/* Avoid showing an unverified list title while the manuscript is loading. */
(()=>{
  const field=document.getElementById('project-title')
  if(!field)return
  field.value=''
  field.placeholder=document.documentElement.lang==='ko'?'논문 불러오는 중…':'Loading paper…'
})()
