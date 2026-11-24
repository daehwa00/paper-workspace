"""Render the standalone login page."""
import html


def render_page(language, redirect, error_code, copy, personal_accounts,
                login_url, styles, favicon_data, light_logo, dark_logo):
    username_field = ''
    if personal_accounts:
        copy['description'] = '개인 공간 이름과 발급받은 암호를 입력하세요.' if language == 'ko' else 'Enter your workspace name and issued password.'
        label = '개인 공간' if language == 'ko' else 'Workspace'
        placeholder = '개인 공간 이름' if language == 'ko' else 'Workspace name'
        username_field = f'<label><span class="sr-only">{label}</span><input name="username" autocomplete="username" autofocus required pattern="[A-Za-z0-9][A-Za-z0-9_-]{{0,63}}" placeholder="{placeholder}"></label>'
    password_focus = '' if personal_accounts else ' autofocus'
    error = copy.get(error_code, "")
    message = f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ""
    action = html.escape(login_url(redirect, language), quote=True)
    english_url = html.escape(login_url(redirect, "en"), quote=True)
    korean_url = html.escape(login_url(redirect, "ko"), quote=True)
    favicon = html.escape(favicon_data, quote=True)
    logo_light = html.escape(light_logo, quote=True)
    logo_dark = html.escape(dark_logo, quote=True)
    heading = 'Paper Workspace 로그인' if language == 'ko' else 'Log in to Paper Workspace'
    theme_script = "try{const t=localStorage.getItem('paper-workspace-theme')||'system',d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.dataset.colorScheme=d?'dark':'light'}catch(_){}"
    body = f"""<!doctype html>
<html lang="{language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f8f8f9"><script>{theme_script}</script>
<link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" sizes="64x64" href="/assets/paper-workspace-icon.png"><link rel="icon" type="image/png" sizes="64x64" href="{favicon}">
<link rel="preload" href="/assets/inter-variable.woff2" as="font" type="font/woff2" crossorigin>
<title>{html.escape(copy['title'])}</title><style>{styles}</style></head>
<body class="login-page"><main aria-labelledby="login-title">
<header><picture class="mark brand-symbol" aria-hidden="true"><img class="brand-mark-light" src="{logo_light}" width="48" height="48" alt=""><img class="brand-mark-dark" src="{logo_dark}" width="48" height="48" alt=""></picture><h1 id="login-title">{heading}</h1></header>
{message}<form method="post" action="{action}" aria-describedby="login-help">{username_field}
<label><span class="sr-only">{html.escape(copy['password_label'])}</span><input name="password" type="password" autocomplete="current-password" placeholder="{html.escape(copy['password_label'])}"{password_focus} required></label>
<button class="primary" type="submit">{html.escape(copy['submit'])}</button></form>
<p id="login-help" class="login-help">{html.escape(copy['description'])}</p>
<nav class="language" aria-label="{html.escape(copy['language_label'])}"><a href="{english_url}" hreflang="en" lang="en" aria-current="{'true' if language == 'en' else 'false'}">English</a><span aria-hidden="true">·</span><a href="{korean_url}" hreflang="ko" lang="ko" aria-current="{'true' if language == 'ko' else 'false'}">한국어</a></nav>
</main></body></html>"""
    return body.encode("utf-8")
