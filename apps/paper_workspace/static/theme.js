(()=>{
  const storageKey='paper-workspace-theme';
  const modes=new Set(['system','light','dark']);
  const media=window.matchMedia('(prefers-color-scheme: dark)');
  const root=document.documentElement;
  const meta=document.querySelector('meta[name="theme-color"]');
  const dialog=document.querySelector('.theme-dialog');
  const triggers=[...document.querySelectorAll('.theme-trigger')];

  function selectedMode(){
    const value=localStorage.getItem(storageKey)||'system';
    return modes.has(value)?value:'system';
  }

  function applyTheme(mode=selectedMode()){
    const dark=mode==='dark'||(mode==='system'&&media.matches);
    root.dataset.theme=mode;
    root.dataset.colorScheme=dark?'dark':'light';
    root.style.colorScheme=dark?'dark':'light';
    if(meta)meta.content=dark?'#0b1220':'#101828';
    document.querySelectorAll('input[name="workspace-theme"]').forEach(input=>{
      input.checked=input.value===mode;
    });
    triggers.forEach(trigger=>{
      trigger.dataset.resolvedTheme=dark?'dark':'light';
      trigger.title=`화면 모드 설정 · ${mode==='system'?'시스템':dark?'다크':'라이트'}`;
    });
  }

  function openDialog(){
    applyTheme();
    if(typeof dialog?.showModal==='function')dialog.showModal();
  }

  triggers.forEach(trigger=>trigger.addEventListener('click',openDialog));
  dialog?.addEventListener('change',event=>{
    const input=event.target.closest('input[name="workspace-theme"]');
    if(!input||!modes.has(input.value))return;
    localStorage.setItem(storageKey,input.value);
    applyTheme(input.value);
  });
  media.addEventListener?.('change',()=>{
    if(selectedMode()==='system')applyTheme('system');
  });
  window.addEventListener('storage',event=>{
    if(event.key===storageKey)applyTheme();
  });
  applyTheme();
})();
