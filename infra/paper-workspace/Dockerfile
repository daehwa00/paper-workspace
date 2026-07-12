FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY --chmod=644 apps/paper_workspace/static /usr/share/nginx/html
COPY --chmod=644 examples/paper-workspace-project /usr/share/nginx/html/project
USER root
RUN mkdir -p /usr/share/nginx/html/projects
COPY --chmod=644 infra/paper-workspace/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=644 infra/paper-workspace/nginx-main.conf /etc/nginx/nginx.conf
RUN set -eu; \
    cd /usr/share/nginx/html; \
    replace_hash() { html="$1"; token="$2"; asset="$3"; hash="$(sha256sum "$asset" | cut -c1-16)"; sed -i "s/${token}/${hash}/g" "$html"; }; \
    replace_hash index.html __APP_CSS_HASH__ app.css; \
    replace_hash index.html __COMPONENTS_CSS_HASH__ components.css; \
    replace_hash index.html __UX_CSS_HASH__ ux.css; \
    replace_hash index.html __THEME_CSS_HASH__ theme.css; \
    replace_hash index.html __THEME_JS_HASH__ theme.js; \
    replace_hash index.html __I18N_JS_HASH__ i18n.js; \
    replace_hash index.html __WORKSPACE_I18N_JS_HASH__ workspace-i18n.js; \
    replace_hash index.html __PAPER_COLLAB_HASH__ vendor/paper-collab.js; \
    replace_hash index.html __PAPER_EDITOR_HASH__ vendor/paper-editor.js; \
    replace_hash index.html __APP_JS_HASH__ app.js; \
    replace_hash hub.html __HUB_CSS_HASH__ hub.css; \
    replace_hash hub.html __HUB_UX_CSS_HASH__ hub-ux.css; \
    replace_hash hub.html __THEME_CSS_HASH__ theme.css; \
    replace_hash hub.html __THEME_JS_HASH__ theme.js; \
    replace_hash hub.html __I18N_JS_HASH__ i18n.js; \
    replace_hash hub.html __HUB_JS_HASH__ hub.js; \
    ! grep -R '__[A-Z_]*_HASH__' index.html hub.html; \
    find /usr/share/nginx/html -type d -exec chmod 755 {} +
USER nginx

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
