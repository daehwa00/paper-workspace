(()=>{
  const storageKey='paper-workspace-theme';
  const preferences=window.PaperPreferenceStorage;
  const modes=new Set(['system','light','dark']);
  const media=window.matchMedia('(prefers-color-scheme: dark)');
  const root=document.documentElement;
  const meta=document.querySelector('meta[name="theme-color"]');
  const dialog=document.querySelector('.theme-dialog');
  const triggers=[...document.querySelectorAll('.theme-trigger')];
  const themeSelect=dialog?.querySelector('select[name="workspace-theme"]');
  const i18n=window.PaperI18n;
  i18n?.register('en',{'appearance.title':'Appearance','appearance.interfaceTheme':'Interface theme','appearance.interfaceThemeDescription':'Select your interface color scheme','appearance.system':'System','appearance.light':'Light','appearance.dark':'Dark'});
  i18n?.register('ko',{'appearance.title':'화면 모드','appearance.interfaceTheme':'인터페이스 테마','appearance.interfaceThemeDescription':'작업 화면의 색상 모드를 선택합니다','appearance.system':'시스템','appearance.light':'라이트','appearance.dark':'다크'});
  if(dialog)i18n?.apply(dialog);

  function selectedMode(){
    const value=preferences.get(storageKey)||'system';
    return modes.has(value)?value:'system';
  }

  function applyTheme(mode=selectedMode()){
    const dark=mode==='dark'||(mode==='system'&&media.matches);
    root.dataset.theme=mode;
    root.dataset.colorScheme=dark?'dark':'light';
    root.style.colorScheme=dark?'dark':'light';
    if(meta)meta.content=dark?'#080808':'#f5f5f5';
    if(themeSelect&&themeSelect.value!==mode){
      themeSelect.value=mode;
      themeSelect.dispatchEvent(new Event('input',{bubbles:true}));
    }
    triggers.forEach(trigger=>{
      trigger.dataset.resolvedTheme=dark?'dark':'light';
      trigger.title=trigger.getAttribute('aria-label')||trigger.title;
    });
  }

  function translate(){
    if(!dialog)return;
    const text=(en,ko)=>document.documentElement.lang==='ko'?ko:en;
    const labels={
      'appearance.title':text('Appearance','화면 모드'),
      'appearance.interfaceTheme':text('Interface theme','인터페이스 테마'),
      'appearance.interfaceThemeDescription':text('Select your interface color scheme','작업 화면의 색상 모드를 선택합니다'),
      'appearance.system':text('System','시스템'),
      'appearance.light':text('Light','라이트'),
      'appearance.dark':text('Dark','다크')
    };
    dialog.querySelectorAll('[data-i18n]').forEach(node=>{if(labels[node.dataset.i18n])node.textContent=labels[node.dataset.i18n]});
    dialog.querySelectorAll('[data-i18n-label]').forEach(node=>{if(labels[node.dataset.i18nLabel])node.setAttribute('aria-label',labels[node.dataset.i18nLabel])});
    if(dialog.hasAttribute('data-ui-locale')){
      dialog.querySelector('h2').textContent=labels['appearance.title'];
      dialog.querySelector('p').textContent=text('Applies to the hub and all papers in this browser.','이 브라우저의 허브와 모든 논문에 함께 적용됩니다.');
      dialog.querySelector('.dialog-actions button').textContent=text('Done','완료');
      triggers.forEach(trigger=>{trigger.setAttribute('aria-label',text('Appearance settings','화면 모드 설정'));trigger.title=trigger.getAttribute('aria-label')});
    }
    themeSelect?.dispatchEvent(new Event('input',{bubbles:true}));
  }

  function openDialog(event){
    applyTheme();translate();
    window.PaperUI.openDialog(dialog,{trigger:event.currentTarget});
  }

  triggers.forEach(trigger=>trigger.addEventListener('click',openDialog));
  dialog?.addEventListener('change',event=>{
    const input=event.target.closest('select[name="workspace-theme"]');
    if(!input||!modes.has(input.value))return;
    preferences.set(storageKey,input.value);
    applyTheme(input.value);
  });
  media.addEventListener?.('change',()=>{
    if(selectedMode()==='system')applyTheme('system');
  });
  window.addEventListener('storage',event=>{
    if(event.key===storageKey)applyTheme();
  });
  window.addEventListener('paper-language-change',()=>{translate();applyTheme()});
  translate();applyTheme();
})();
