# syntax=docker/dockerfile:1.19

FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY --chmod=644 apps/paper_workspace/static/*.css apps/paper_workspace/static/*.js apps/paper_workspace/static/*.html apps/paper_workspace/static/*.png apps/paper_workspace/static/favicon.ico apps/paper_workspace/static/site.webmanifest /usr/share/nginx/html/
COPY --exclude=*.orig --exclude=*.bak --exclude=*.swp --exclude=*~ --exclude=.DS_Store --chmod=644 apps/paper_workspace/static/assets /usr/share/nginx/html/assets
COPY --exclude=*.orig --exclude=*.bak --exclude=*.swp --exclude=*~ --exclude=.DS_Store --chmod=644 apps/paper_workspace/static/vendor /usr/share/nginx/html/vendor
COPY --chmod=644 examples/paper-workspace-project /usr/share/nginx/html/project
USER root
RUN mkdir -p /usr/share/nginx/html/projects
COPY --chmod=644 infra/paper-workspace/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=644 infra/paper-workspace/nginx-main.conf /etc/nginx/nginx.conf
COPY --chmod=644 scripts/paper_platform/verify_static_tokens.sh /usr/local/bin/verify-static-tokens
RUN set -eu; \
    cd /usr/share/nginx/html; \
    replace_hash() { html="$1"; token="$2"; asset="$3"; hash="$(sha256sum "$asset" | cut -c1-16)"; sed -i "s/${token}/${hash}/g" "$html"; name="${asset##*/}"; sed -i -E "s|(${name}\?v=)[0-9a-f]{16}|\1${hash}|g" "$html"; }; \
    replace_data() { html="$1"; token="$2"; asset="$3"; data="$(base64 "$asset" | tr -d '\n')"; sed -i "s|${token}|${data}|g" "$html"; }; \
    replace_hash site.webmanifest __APPLE_TOUCH_ICON_HASH__ apple-touch-icon.png; \
    replace_hash site.webmanifest __FAVICON_PNG_HASH__ assets/favicon-64.png; \
    cp assets/favicon-64.png assets/paper-workspace-icon.png; \
    cp apple-touch-icon.png assets/paper-workspace-touch.png; \
    cp site.webmanifest assets/paper-workspace.webmanifest; \
    for page in index.html hub.html rebuttal.html; do \
      replace_hash "$page" __FOLIO_LIGHT_HASH__ assets/paper-folio-light.svg; \
      replace_hash "$page" __FOLIO_DARK_HASH__ assets/paper-folio-dark.svg; \
    done; \
    replace_hash index.html __FAVICON_ICO_HASH__ favicon.ico; \
    replace_hash index.html __FAVICON_PNG_HASH__ assets/favicon-64.png; \
    replace_data index.html __FAVICON_DATA__ assets/favicon-64.png; \
    replace_hash index.html __APPLE_TOUCH_ICON_HASH__ apple-touch-icon.png; \
    replace_hash index.html __WEBMANIFEST_HASH__ assets/paper-workspace.webmanifest; \
    replace_hash index.html __APP_CSS_HASH__ app.css; \
    replace_hash index.html __BOOTSTRAP_JS_HASH__ bootstrap.js; \
    replace_hash index.html __BOOTSTRAP_WATCHDOG_JS_HASH__ bootstrap-watchdog.js; \
    replace_hash index.html __COMPONENTS_CSS_HASH__ components.css; \
    replace_hash index.html __UX_CSS_HASH__ ux.css; \
    replace_hash index.html __PROJECT_FRAME_CSS_HASH__ project-frame.css; \
    replace_hash index.html __THEME_CSS_HASH__ theme.css; \
    replace_hash index.html __THEME_JS_HASH__ theme.js; \
    replace_hash index.html __I18N_JS_HASH__ i18n.js; \
    replace_hash index.html __WORKSPACE_I18N_JS_HASH__ workspace-i18n.js; \
    replace_hash index.html __WORKSPACE_CORE_JS_HASH__ workspace-core.js; \
    replace_hash index.html __WORKSPACE_STORAGE_JS_HASH__ workspace-storage.js; \
    replace_hash index.html __PDF_VIEWPORT_JS_HASH__ pdf-viewport.js; \
    replace_hash index.html __PAPER_COLLAB_HASH__ vendor/paper-collab.js; \
    replace_hash index.html __PAPER_EDITOR_HASH__ vendor/paper-editor.js; \
    replace_hash workspace-pdf.js __PDFJS_MJS_HASH__ vendor/pdfjs/pdf.mjs; \
    replace_hash workspace-pdf.js __PDFJS_WORKER_HASH__ vendor/pdfjs/pdf.worker.mjs; \
    replace_hash index.html __WORKSPACE_PDF_JS_HASH__ workspace-pdf.js; \
    replace_hash index.html __APP_JS_HASH__ app.js; \
    replace_hash index.html __WORKSPACE_BACKUPS_JS_HASH__ workspace-backups.js; \
    replace_hash index.html __PROJECT_TITLE_STARTUP_JS_HASH__ project-title-startup.js; \
    replace_hash index.html __SIDEBAR_ACCOUNT_JS_HASH__ sidebar-account.js; \
    replace_hash index.html __PROJECT_PRESENCE_JS_HASH__ project-presence.js; \
    replace_hash index.html __PROJECT_PRESENCE_CSS_HASH__ project-presence.css; \
    replace_hash rebuttal.html __SIDEBAR_ACCOUNT_JS_HASH__ sidebar-account.js; \
    replace_hash rebuttal.html __PROJECT_PRESENCE_JS_HASH__ project-presence.js; \
    replace_hash rebuttal.html __PROJECT_PRESENCE_CSS_HASH__ project-presence.css; \
    replace_hash index.html __REBUTTAL_BACKUP_JS_HASH__ rebuttal-backup.js; \
    replace_hash rebuttal.html __BOOTSTRAP_JS_HASH__ bootstrap.js; \
    replace_hash rebuttal.html __FAVICON_ICO_HASH__ favicon.ico; \
    replace_hash rebuttal.html __FAVICON_PNG_HASH__ assets/favicon-64.png; \
    replace_data rebuttal.html __FAVICON_DATA__ assets/favicon-64.png; \
    replace_hash rebuttal.html __APPLE_TOUCH_ICON_HASH__ apple-touch-icon.png; \
    replace_hash rebuttal.html __WEBMANIFEST_HASH__ assets/paper-workspace.webmanifest; \
    replace_hash rebuttal.html __THEME_CSS_HASH__ theme.css; \
    replace_hash rebuttal.html __THEME_JS_HASH__ theme.js; \
    replace_hash rebuttal.html __PAPER_COLLAB_HASH__ vendor/paper-collab.js; \
    replace_hash rebuttal.html __PAPER_EDITOR_HASH__ vendor/paper-editor.js; \
    replace_hash rebuttal.js __REBUTTAL_COMMENTS_JS_HASH__ rebuttal-comments.js; \
    replace_hash rebuttal.js __REBUTTAL_TRANSLATION_JS_HASH__ rebuttal-translation.js; \
    replace_hash rebuttal.js __REBUTTAL_SESSION_JS_HASH__ rebuttal-session.js; \
    replace_hash rebuttal.js __REBUTTAL_SUBMISSION_JS_HASH__ rebuttal-submission.js; \
    replace_hash rebuttal.html __REBUTTAL_JS_HASH__ rebuttal.js; \
    replace_hash rebuttal.html __REBUTTAL_CSS_HASH__ rebuttal.css; \
    replace_hash rebuttal.html __PROJECT_FRAME_CSS_HASH__ project-frame.css; \
    replace_hash rebuttal.html __REBUTTAL_BACKUP_JS_HASH__ rebuttal-backup.js; \
    replace_hash hub.html __HUB_CSS_HASH__ hub.css; \
    replace_hash hub.html __BOOTSTRAP_JS_HASH__ bootstrap.js; \
    replace_hash hub.html __HUB_UX_CSS_HASH__ hub-ux.css; \
    replace_hash hub.html __THEME_CSS_HASH__ theme.css; \
    replace_hash hub.html __THEME_JS_HASH__ theme.js; \
    replace_hash hub.html __I18N_JS_HASH__ i18n.js; \
    replace_hash hub.html __HUB_JS_HASH__ hub.js; \
    replace_hash hub.html __HUB_CALENDAR_JS_HASH__ hub-calendar.js; \
    replace_hash hub.html __FAVICON_ICO_HASH__ favicon.ico; \
    replace_hash hub.html __FAVICON_PNG_HASH__ assets/favicon-64.png; \
    replace_data hub.html __FAVICON_DATA__ assets/favicon-64.png; \
    replace_hash hub.html __APPLE_TOUCH_ICON_HASH__ apple-touch-icon.png; \
    replace_hash hub.html __WEBMANIFEST_HASH__ assets/paper-workspace.webmanifest; \
    sh /usr/local/bin/verify-static-tokens index.html hub.html rebuttal.html rebuttal.js site.webmanifest workspace-pdf.js; \
    find /usr/share/nginx/html -type d -exec chmod 755 {} +
USER nginx

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
