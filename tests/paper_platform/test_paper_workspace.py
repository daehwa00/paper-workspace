from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_custom_workspace_has_no_texlyre_brand_or_login() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    assert "Paper Workspace" in html
    assert "TeXlyre" not in html
    assert "Log in" not in html
    assert 'id="project-title"' in html
    assert 'class="brand"' not in html
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "setProjectTitle" in app
    assert "syncProjectTitleFromTex" in app


def test_workspace_serves_editor_preview_upload_and_assistant_surfaces() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    for identifier in ("editor", "paper-preview", "upload", "suggestion", "refresh-pdf", "download-pdf"):
        assert f'id="{identifier}"' in html
    assert "localStorage" in app
    assert "render" in app
    assert "loadProject" in app
    assert "/project/project.json" in app
    assert "loadProjectManifest" in app
    assert "validManifestPath" in app
    assert "/api/compile" in app
    assert "compileAfterSave" in app
    assert "자동 갱신 10" not in app
    assert "renderPdfPreview" in app
    assert "syncPdfToSource" in app
    assert 'id="sync-highlight"' in html
    assert ".pdf-page canvas:hover,.pdf-page canvas:focus{outline:none!important}" in html
    assert "sync-soft-focus" in html


def test_workspace_panel_widths_are_resizable_and_persisted() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    css = (ROOT / "apps/paper_workspace/static/app.css").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'data-resize="editor-preview"' in html
    assert 'data-resize="preview-assistant"' in html
    assert 'id="reset-layout"' in html
    assert "grid-template-columns:minmax(390px,var(--editor-width" in css
    assert "layoutKey='paper-workspace-layout'" in app
    assert "installPanelResizers" in app
    assert "setPointerCapture" in app
    assert "/app.css?v=20260710-pdf-page-indicator-1" in html
    assert "/app.js?v=20260710-mathematical-derivations-1" in html


def test_editor_and_pdf_have_independent_persistent_zoom_controls() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    for identifier in ("editor-zoom-out", "editor-zoom-in", "pdf-zoom-out", "pdf-zoom-in"):
        assert f'id="{identifier}"' in html
    assert "editorZoom:1,pdfZoom:1" in app
    assert "installZoomControls" in app
    assert "viewer.style.zoom=String(layout.pdfZoom)" in app
    assert "displayScale=scale*layout.pdfZoom" in app


def test_profile_color_can_be_selected_and_persisted() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'name="profile-color"' in html
    assert html.count('class="color-swatch"') == 7
    assert "localStorage.getItem('collab-color')" in app
    assert "localStorage.setItem('collab-color',actor.color)" in app
    assert "$('collab-name').style.background=actor.color" in app


def test_collaborators_render_as_an_avatar_stack_without_a_headcount() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    server = (ROOT / "apps/paper_workspace/collaboration/server.py").read_text(encoding="utf-8")
    assert 'id="collaborator-avatars"' in html
    assert 'id="presence-label"' not in html
    assert ".collaborator-avatar" in html
    assert "collaboratorInitial" in app
    assert "avatar.dataset.tooltip" in app
    assert "명 ·" not in app
    assert 'actor["selection"]' in server
    assert 'id="remote-cursors"' in html
    assert "renderRemoteCursors" in app
    assert "goToCollaborator" in app
    assert "MAX_EVENT_BYTES" in server
    assert "max_size=MAX_EVENT_BYTES" in server


def test_text_selection_exposes_comment_and_codex_actions() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'id="selection-toolbar"' in html
    assert 'id="selection-comment"' in html
    assert 'id="selection-codex"' in html
    assert "Codex에게 요청 보내기" in html
    assert "prepareCodexRequest" in app
    assert "latexPreview" in app
    assert "mathPreview" in app
    assert "\\mathbb" in app
    assert "math-frac" in html
    assert 'class="latex-preview"' in app
    assert ".replace(/\\s*\\n\\s*/g,' ')" in app
    assert "let dragged=false" in app
    assert "if(dragged&&editor.selectionEnd>editor.selectionStart)" in app
    assert "captureEditorSelection" in app
    assert "requestCodexRevision" in app
    assert "fetch('/api/codex'" in app


def test_preview_header_keeps_controls_without_redundant_title() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    assert '<div class="panel-header preview-header"><span class="render-controls">' in html
    assert '<span>PDF 미리보기</span>' not in html
    assert ".preview-header{justify-content:flex-end}" in html
    assert ".preview-panel .preview-header{position:sticky;top:0" in html


def test_sticky_pdf_toolbar_tracks_current_and_total_pages() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'id="pdf-page-indicator"' in html
    assert 'aria-label="현재 PDF 페이지"' in html
    assert ".pdf-page-indicator" in html
    assert "wrapper.dataset.page=String(pageNumber)" in app
    assert "updatePdfPageIndicator" in app
    assert "schedulePdfPageIndicatorUpdate" in app
    assert "installPdfPageIndicator" in app
    assert "page.getBoundingClientRect()" in app
    assert "현재 PDF ${pageNumber}페이지, 전체 ${pages.length}페이지" in app


def test_typing_does_not_replace_the_rendered_pdf_with_placeholder() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "window.saveTimer=setTimeout(()=>{if(save())compileAfterSave()},250)" in app
    assert "setTimeout(()=>{save();render()},250)" not in app


def test_editor_shortcuts_support_mac_and_control_key_workflows() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "event.metaKey||event.ctrlKey" in app
    assert "if(key==='s')" in app
    assert "if(key==='z')" in app
    assert "if(event.shiftKey)redoEditor();else undoEditor()" in app
    assert "if(key==='y')" in app
    assert "installEditorShortcuts()" in app
    assert "editor.addEventListener('beforeinput',recordEditorHistory)" in app


def test_paper_assistant_can_be_collapsed_and_restored() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    css = (ROOT / "apps/paper_workspace/static/app.css").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'id="toggle-assistant"' in html
    assert 'aria-expanded="true"' in html
    assert ".workspace.assistant-collapsed" in css
    assert "assistantCollapsed:false" in app
    assert "setAssistantCollapsed" in app
    assert "localStorage.setItem(layoutKey" in app


def test_project_sidebar_can_be_collapsed_and_persisted() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'id="toggle-sidebar"' in html
    assert ".shell.sidebar-collapsed .sidebar" in html
    assert "sidebarCollapsed:false" in app
    assert "updateSidebarToggle" in app
    assert "layout.sidebarCollapsed=!layout.sidebarCollapsed" in app
    assert 'class="tree-action sidebar-toggle"' not in html
    assert ".side-heading .sidebar-toggle" in html


def test_local_files_and_folders_can_be_dropped_into_the_project_tree() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    css = (ROOT / "apps/paper_workspace/static/app.css").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    compiler = (ROOT / "apps/paper_workspace/compiler/server.py").read_text(encoding="utf-8")
    assert 'id="drop-hint"' in html
    assert ".sidebar.file-dragging" in css
    assert ".folder-row.drop-target" in css
    assert "webkitGetAsEntry" in app
    assert "droppedLocalFiles" in app
    assert "importLocalFiles" in app
    assert "compilePayload" in app
    assert 'payload.get("assets", {})' in compiler
    assert "safe_project_path" in compiler


def test_upload_button_targets_the_selected_folder() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "선택 폴더에 자료 올리기" in html
    assert "state.activeFolder=path" in app
    assert "pendingUploadFolder||state.activeFolder||'paper'" in app


def test_name_setup_toast_respects_hidden_state_and_closes_after_save() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert ".name-toast[hidden]{display:none}" in html
    assert "$('name-toast').hidden=true" in app


def test_comment_cards_navigate_to_source_and_can_be_resolved() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "comment-card" in html
    assert "goToComment" in app
    assert "commentLocation" in app
    assert "resolve-comment" in app
    assert "state.comments.filter" in app


def test_workspace_shell_assets_are_revalidated() -> None:
    nginx = (ROOT / "infra/paper-workspace/nginx.conf").read_text(encoding="utf-8")
    assert 'location = /index.html' in nginx
    assert 'location ~ ^/(app\\.css|app\\.js)$' in nginx
    assert 'Cache-Control "no-cache, no-store, must-revalidate"' in nginx
    assert nginx.count('Cache-Control "no-cache, no-store, must-revalidate"') >= 2


def test_workspace_deployment_is_unprivileged_and_tls_terminated() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    caddy = (ROOT / "infra/paper-workspace/Caddyfile").read_text(encoding="utf-8")
    assert "read_only: true" in compose
    assert "no-new-privileges:true" in compose
    assert 'PAPER_BIND_ADDRESS:-127.0.0.1}:443:443' in compose
    assert "reverse_proxy workspace:8080" in caddy


def test_codex_bridge_uses_chatgpt_auth_without_exposing_it_to_browser() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    caddy = (ROOT / "infra/paper-workspace/Caddyfile").read_text(encoding="utf-8")
    bridge = (ROOT / "apps/paper_workspace/codex_bridge/server.mjs").read_text(encoding="utf-8")
    dockerfile = (ROOT / "apps/paper_workspace/codex_bridge/Dockerfile").read_text(encoding="utf-8")
    assert "env_file:" in compose
    assert "path: .env" in compose
    assert "CODEX_BRIDGE_TOKEN" in bridge
    assert "codex-auth:ro" in compose
    assert ":/workspace/project:ro" in compose
    assert "reverse_proxy codex-bridge:8790" in caddy
    assert 'header_up Authorization "Bearer {$CODEX_BRIDGE_TOKEN}"' in caddy
    assert "codex-bridge-token" not in (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "timingSafeEqual" in bridge
    assert "--sandbox', 'read-only" in bridge
    assert "--ephemeral" in bridge
    assert "--output-schema" in bridge
    assert "@openai/codex@0.144.1" in dockerfile
    assert "gpt-5.6-sol" in bridge
    assert "model_reasoning_effort" in bridge
    assert 'CMD ["sh", "/app/start.sh"]' in dockerfile
    assert (ROOT / "infra/paper-workspace/.gitignore").read_text(encoding="utf-8").splitlines() == [".env", ".env.auth", ".auth/", ".env.password"]


def test_project_sources_are_readable_and_html_fallbacks_are_rejected() -> None:
    dockerfile = (ROOT / "infra/paper-workspace/Dockerfile").read_text(encoding="utf-8")
    nginx = (ROOT / "infra/paper-workspace/nginx.conf").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    compiler = (ROOT / "apps/paper_workspace/compiler/server.py").read_text(encoding="utf-8")
    assert "find /usr/share/nginx/html -type d -exec chmod 755" in dockerfile
    assert "location /vendor/" in nginx
    assert "looksLikeHtml" in app
    assert "contentType.toLowerCase().includes('text/html')" in app
    assert "if(remoteMain){" in app
    assert "if(!isLatexDocument(localMain))" in app
    assert "state.files[`paper/drafts/${previousVersion}.tex`]||=localMain" in app
    assert "state.files['paper/main.tex']=remoteMain" in app
    assert "for _ in range(3):" in compiler
    assert '"-synctex=1"' in compiler
    assert 'self.path == "/synctex"' in compiler
    assert '"synctex_base64"' in compiler


def test_server_paper_sources_are_live_mounted_and_versioned() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "PAPER_PROJECT_DIR" in compose
    assert ":/usr/share/nginx/html/project:ro" in compose
    assert 'user: "${HOST_UID:-1000}:${HOST_GID:-1000}"' in compose
    assert "../../paper/" not in compose
    assert "serverMainSnapshot" in app
    assert "browser-before-server-sync" in app


def test_private_author_kit_is_not_bundled_in_public_runtime() -> None:
    nginx = (ROOT / "infra/paper-workspace/nginx.conf").read_text(encoding="utf-8")
    web_image = (ROOT / "infra/paper-workspace/Dockerfile").read_text(encoding="utf-8")
    compiler_image = (ROOT / "apps/paper_workspace/compiler/Dockerfile").read_text(encoding="utf-8")
    assert "location /author-kit/" not in nginx
    assert "paper/vendor" not in web_image
    assert "paper/vendor" not in compiler_image


def test_canonical_references_are_merged_by_bibtex_key() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "bibliographyEntries" in app
    assert "mergeBibliography" in app
    assert "state.files[name]=mergeBibliography(state.files[name],value)" in app


def test_project_manifest_controls_server_managed_files() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "projectManifest.files.filter(item=>item.managed)" in app
    assert "state.projectVersion!==projectManifest.version" in app
    assert "browser-before-server-sync" in app


def test_changed_projects_are_backed_up_to_server_every_ten_minutes() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")

    assert 'id="backup-status"' in html
    assert 'id="create-backup"' in html
    assert 'id="backup-list"' in html
    assert "const backupIntervalMs=10*60*1000" in app
    assert "signature===lastBackupSignature" in app
    assert "createServerBackup('pre-restore')" in app
    assert "setInterval(()=>createServerBackup('auto'" in app
    backup_payload = app[app.index("function backupPayload"):app.index("function backupSignature")]
    assert "state.assets" not in backup_payload
    assert ".replace(/[^A-Za-z0-9_-]+/g,'-')" in app
