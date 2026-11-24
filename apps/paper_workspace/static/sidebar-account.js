/* Shared account controls and settings markup for both workspace modes. */
(()=>{
let footer=`<div class="sidebar-account">
<details data-disclosure-menu="mobile" id="mobile-utilities" class="mobile-utilities">
<summary aria-label="언어, 상태 및 화면 설정" title="언어, 상태 및 화면 설정">
<span aria-hidden="true">•••</span>
</summary>
<div class="mobile-utility-items">
<label class="language-control">
<select id="workspace-language" aria-label="Language">
<option value="en">EN</option>
<option value="ko">한국어</option>
</select>
</label>
<button id="status-center-toggle" class="status-center-toggle" type="button" aria-expanded="false" aria-controls="status-center" title="작업공간 상태 보기">
<span id="collab-status" class="status-dot connecting" aria-hidden="true">
</span>
<span id="collab-label" class="collab-label">연결 중</span>
<span class="status-chevron" aria-hidden="true">›</span>
</button>
<button id="review-appearance-trigger" class="theme-trigger" type="button" title="화면 모드 설정" aria-label="화면 모드 설정" aria-haspopup="dialog">
<svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true">
<circle cx="12" cy="12" r="3.5"/>
<path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/>
</svg>
<svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true">
<path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z"/>
</svg>
</button>
</div>
</details>
<span class="presence">
<button id="collab-name" class="avatar" title="표시 이름 변경">나</button>
</span>
</div>`;
if(matchMedia('(min-width:768px)').matches)footer=footer.replace('<details ', '<details open ');
const dialogs=`<dialog data-ui-locale id="name-dialog" class="name-dialog" aria-labelledby="name-title" aria-describedby="name-description">
<form method="dialog">
<h2 id="name-title">표시 이름 설정</h2>
<p id="name-description">공동 편집자에게 보이는 이름과 프로필 색상입니다.</p>
<div class="settings-group">
<label class="settings-row" for="name-input">
<span class="settings-copy">
<strong>표시 이름</strong>
</span>
<input id="name-input" aria-labelledby="name-title" maxlength="32" autocomplete="name" placeholder="이름 또는 닉네임" required />
</label>
<fieldset class="profile-colors settings-row">
<legend class="sr-only">프로필 색상</legend>
<span class="settings-copy" aria-hidden="true">
<strong>프로필 색상</strong>
</span>
<div id="color-options" class="color-options">
<label class="color-option" title="파랑">
<input type="radio" name="profile-color" value="#2457d6">
<span class="color-swatch" style="--profile-color:#2457d6">
</span>
</label>
<label class="color-option" title="보라">
<input type="radio" name="profile-color" value="#7c3aed">
<span class="color-swatch" style="--profile-color:#7c3aed">
</span>
</label>
<label class="color-option" title="청록">
<input type="radio" name="profile-color" value="#0891b2">
<span class="color-swatch" style="--profile-color:#0891b2">
</span>
</label>
<label class="color-option" title="초록">
<input type="radio" name="profile-color" value="#059669">
<span class="color-swatch" style="--profile-color:#059669">
</span>
</label>
<label class="color-option" title="주황">
<input type="radio" name="profile-color" value="#d97706">
<span class="color-swatch" style="--profile-color:#d97706">
</span>
</label>
<label class="color-option" title="빨강">
<input type="radio" name="profile-color" value="#dc2626">
<span class="color-swatch" style="--profile-color:#dc2626">
</span>
</label>
<label class="color-option" title="분홍">
<input type="radio" name="profile-color" value="#db2777">
<span class="color-swatch" style="--profile-color:#db2777">
</span>
</label>
</div>
</fieldset>
</div>
<div class="dialog-actions">
<button id="cancel-name" value="cancel" class="quiet-dialog" formnovalidate>취소</button>
<button value="confirm" class="primary" id="save-name">저장</button>
</div>
</form>
</dialog>
<dialog data-ui-locale class="theme-dialog" aria-labelledby="appearance-title">
<form method="dialog">
<h2 id="appearance-title">화면 모드</h2>
<p id="review-appearance-description">이 브라우저의 허브와 모든 논문에 함께 적용됩니다.</p>
<fieldset class="theme-options settings-group" aria-label="Appearance" data-i18n-label="appearance.title">
<div class="settings-row">
<span class="settings-copy">
<strong id="theme-setting-label" data-i18n="appearance.interfaceTheme">Interface theme</strong>
<small id="review-appearance-help" data-i18n="appearance.interfaceThemeDescription">Select your interface color scheme</small>
</span>
<select id="workspace-theme" name="workspace-theme" aria-label="Interface theme" data-i18n-label="appearance.interfaceTheme" data-property-picker>
<option value="system" data-i18n="appearance.system">System</option>
<option value="light" data-i18n="appearance.light">Light</option>
<option value="dark" data-i18n="appearance.dark">Dark</option>
</select>
</div>
</fieldset>
<div class="dialog-actions">
<button id="review-appearance-done" value="close" class="primary">완료</button>
</div>
</form>
</dialog>
<aside id="status-center" class="status-center" hidden aria-labelledby="status-center-title">
<header data-ui-locale><strong id="status-center-title"></strong><button id="status-center-close" type="button" class="icon-button quiet">×</button></header>
<div id="status-center-details"></div>
</aside>`;
const script=document.currentScript;
script.insertAdjacentHTML('afterend',footer+dialogs);
const media=matchMedia('(min-width:768px)');media.addEventListener?.('change',event=>{const menu=document.getElementById('mobile-utilities');if(menu)menu.open=event.matches});
const palette=['#2457d6','#7c3aed','#0891b2','#059669','#d97706','#dc2626','#db2777'];
const normalize=value=>String(value??'').trim().slice(0,32);
const valid=value=>Boolean(normalize(value).replace(/[\s\u200b-\u200d\ufeff]/gu,''))&&!['나','me','secondary_host'].includes(normalize(value).toLowerCase());
const initial=name=>{const words=normalize(name).split(/\s+/).filter(Boolean);return (words.length>1?words.slice(0,2).map(word=>word[0]).join(''):words[0]?.slice(0,2)||'?').toUpperCase()};
const $ = id => document.getElementById(id);
const text = (en, ko) => document.documentElement.lang === 'ko' ? ko : en;
const storage = window.PaperPreferenceStorage;
let profile;
function identity() {
  let id=storage.get('collab-id');
  if(!id){id=crypto.randomUUID();storage.set('collab-id',id)}
  return id;
}
function translateSettings() {
  const required = $('name-dialog').dataset.required === 'true';
  const labels = {
    'name-title': text('Display name settings','표시 이름 설정'),
    'name-description': required ? text('Enter a name or nickname so collaborators can recognize you. It will be remembered in this browser.','공동저자가 구분할 수 있도록 이름이나 닉네임을 입력해 주세요. 이 브라우저에서 기억합니다.') : text('Your name and profile color shown to collaborators.','공동 편집자에게 보이는 이름과 프로필 색상입니다.'),
    'cancel-name': text('Cancel','취소'),
    'save-name': required ? text('Save and continue','저장하고 계속') : text('Save','저장')
  };
  for (const [id, label] of Object.entries(labels)) $(id).textContent = label;
  const nameLabel = text('Display name','표시 이름');
  $('name-input').setAttribute('aria-label', nameLabel);
  $('name-input').placeholder = text('Name or nickname','이름 또는 닉네임');
  $('name-input').closest('label').querySelector('strong').textContent = nameLabel;
  const colorLabel = text('Profile color','프로필 색상');
  document.querySelector('.profile-colors legend').textContent = colorLabel;
  document.querySelector('.profile-colors strong').textContent = colorLabel;
  const colors = document.documentElement.lang === 'ko' ? ['파랑','보라','청록','초록','주황','빨강','분홍'] : ['Blue','Purple','Teal','Green','Orange','Red','Pink'];
  document.querySelectorAll('.color-option').forEach((option,index) => {
    option.title = colors[index];option.querySelector('input').setAttribute('aria-label',colors[index]);
  });
  const summary = $('mobile-utilities').querySelector('summary');
  summary.title = text('Language, status and appearance','언어, 상태 및 화면 설정');
  summary.setAttribute('aria-label',summary.title);
  $('workspace-language').setAttribute('aria-label',text('Language','언어 선택'));
  $('collab-name').setAttribute('aria-label',text('Change display name','표시 이름 변경'));
}
function createProfile({actor, required = false, onChange = () => {}, onSave = () => {}}) {
  if (profile) return profile;
  const dialog = $('name-dialog'), input = $('name-input'), avatar = $('collab-name');
  const needsName = () => required && !valid(actor.name);
  function open() {
    if (dialog.open) return;
    dialog.dataset.required = String(needsName());
    input.value = valid(actor.name) ? actor.name : '';
    input.setCustomValidity('');
    $('cancel-name').hidden = needsName();
    for (const option of dialog.querySelectorAll('input[name="profile-color"]')) option.checked = option.value === actor.color;
    translateSettings();
    window.PaperUI.openDialog(dialog,{focus:input});
  }
  function sync() {
    actor.id = identity();
    actor.name = normalize(storage.get('collab-name') ?? actor.name) || text('Author','작성자');
    const savedColor = storage.get('collab-color');
    if (palette.includes(savedColor)) actor.color = savedColor;
    if (!palette.includes(actor.color)) actor.color = palette[0];
    avatar.textContent = valid(actor.name) ? initial(actor.name) : '?';
    avatar.title = actor.name;
    avatar.style.background = actor.color;
    avatar.style.color = window.PaperUI.contrastTextFor(actor.color);
    onChange(actor,valid(actor.name));
    if (needsName()) open();
    else if (dialog.open && dialog.dataset.required === 'true') dialog.close();
  }
  avatar.addEventListener('click',open);
  input.addEventListener('input',() => input.setCustomValidity(''));
  dialog.querySelector('form').addEventListener('submit',event => {
    if (event.submitter?.value === 'cancel') {
      if (needsName()) event.preventDefault();
      return;
    }
    const name = normalize(input.value);
    if (!valid(name)) {
      event.preventDefault();
      input.setCustomValidity(text('Enter your name or nickname instead of a default name.','기본 이름 대신 본인의 이름이나 닉네임을 입력해 주세요.'));
      input.reportValidity();return;
    }
    const color = dialog.querySelector('input[name="profile-color"]:checked')?.value;
    storage.set('collab-name',name);storage.set('collab-name-user-set','1');
    if (palette.includes(color)) storage.set('collab-color',color);
    // Leave native form submission in charge of closing the dialog.
    dialog.dataset.required = 'false';
    sync();onSave(actor);
  });
  dialog.addEventListener('cancel',event => {if (needsName()) event.preventDefault()});
  dialog.addEventListener('close',() => {if (needsName()) open()});
  window.addEventListener('storage',event => {if (!event.key || ['collab-id','collab-name','collab-color'].includes(event.key)) sync()});
  window.addEventListener('focus',sync);
  profile = {open,sync};sync();return profile;
}
window.addEventListener('paper-language-change',translateSettings);
window.addEventListener('storage',event=>{
  if(event.key==='paper-workspace-language' && ['en','ko'].includes(event.newValue) && window.PaperI18n?.getLanguage()!==event.newValue){
    window.PaperI18n?.setLanguage(event.newValue,{persist:false,updateUrl:true});
  }
});
document.addEventListener('DOMContentLoaded',translateSettings,{once:true});
translateSettings();
function createStatusPanel({content,onOpen}={}) {
  const panel=$('status-center'), trigger=$('status-center-toggle'), closeButton=$('status-center-close');
  const anchor=()=>innerWidth<768?$('mobile-utilities').querySelector('summary'):trigger;
  const popup=window.PaperUI.createPopover(trigger,'status-center','',{element:panel,width:320,anchor,onHide:()=>panel.classList.remove('open')});
  const body=$('status-center-details');
  if(content)body.replaceChildren(content);
  new ResizeObserver(()=>{if(trigger.getAttribute('aria-expanded')==='true')window.PaperUI.positionFloating(anchor(),panel,{width:320})}).observe(body);
  const translate=()=>{
    const label=text('Workspace status','작업공간 상태');
    $('status-center-title').textContent=label;panel.setAttribute('aria-label',label);
    closeButton.setAttribute('aria-label',text('Close status panel','상태 창 닫기'));
  };
  const close=({returnFocus=true}={})=>popup.hide(returnFocus);
  const open=()=>{
    onOpen?.();translate();
    if(innerWidth<768)$('mobile-utilities').open=false;
    popup.show();panel.classList.add('open');closeButton.focus();
  };
  trigger.onclick=event=>{event.stopPropagation();trigger.getAttribute('aria-expanded')==='true'?close():open()};
  closeButton.onclick=()=>close();
  window.addEventListener('paper-language-change',translate);
  translate();
  return {open,close,body,panel};
}
window.PaperSidebarProfile={palette,normalize,valid,initial,identity,create:createProfile};
window.PaperSidebarAccount={createStatusPanel};
})();
