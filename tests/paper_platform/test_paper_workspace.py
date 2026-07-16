import json
from pathlib import Path

ROOT = Path(__file__).parents[2]


def workspace_markup() -> str:
    static = ROOT / "apps/paper_workspace/static"
    return "\n".join(
        (static / name).read_text(encoding="utf-8")
        for name in ("index.html", "app.css", "components.css", "ux.css")
    )


def test_custom_workspace_has_no_texlyre_brand_or_login() -> None:
    html = workspace_markup()
    assert "Paper Workspace" in html
    assert "TeXlyre" not in html
    assert "Log in" not in html
    assert 'id="project-title"' in html
    assert 'class="brand"' not in html
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "setProjectTitle" in app
    assert "syncProjectTitleFromTex" in app


def test_workspace_supports_persisted_english_and_korean_locales() -> None:
    html = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    engine = (ROOT / "apps/paper_workspace/static/i18n.js").read_text(encoding="utf-8")
    workspace = (ROOT / "apps/paper_workspace/static/workspace-i18n.js").read_text(encoding="utf-8")
    dockerfile = (ROOT / "infra/paper-workspace/Dockerfile").read_text(encoding="utf-8")

    assert '<html lang="en">' in html
    assert 'id="workspace-language"' in html
    assert 'value="en"' in html and 'value="ko"' in html
    assert "/i18n.js?v=__I18N_JS_HASH__" in html
    assert "/workspace-i18n.js?v=__WORKSPACE_I18N_JS_HASH__" in html
    assert "/workspace-core.js?v=__WORKSPACE_CORE_JS_HASH__" in html
    assert "/pdf-viewport.js?v=__PDF_VIEWPORT_JS_HASH__" in html
    assert "?lang=en|ko" not in engine
    assert "queryLanguage() || storedLanguage() || browserLanguage() || 'en'" in engine
    assert "paper-workspace-language" in engine
    assert "Send request to Codex" in workspace
    assert "Submission readiness" in workspace
    assert "__I18N_JS_HASH__" in dockerfile
    assert "__WORKSPACE_I18N_JS_HASH__" in dockerfile
    assert "__WORKSPACE_CORE_JS_HASH__" in dockerfile
    assert "__PDF_VIEWPORT_JS_HASH__" in dockerfile


def test_workspace_state_and_path_helpers_have_a_testable_module_boundary() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    core = (ROOT / "apps/paper_workspace/static/workspace-core.js").read_text(encoding="utf-8")

    assert "window.PaperWorkspaceCore" in core
    assert "normalizeState" in core
    assert "const {baseName,cleanSegment,constrain,extensionOf,normalizeState,parentPath,storedJson}" in app
    assert "function storedJson" not in app
    assert "const parentPath=" not in app


def test_dynamic_workspace_messages_use_semantic_translation_keys() -> None:
    engine = (ROOT / "apps/paper_workspace/static/i18n.js").read_text(encoding="utf-8")
    workspace = (ROOT / "apps/paper_workspace/static/workspace-i18n.js").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")

    assert "setText" in engine
    assert "workspace.compile.compiling" in workspace
    assert "workspace.tasks.empty" in workspace
    assert "setRenderStateCompiling" in app
    assert "setRenderStateMessage" in app
    assert "PaperI18n.setText(target,key,variables)" in app


def test_workspace_and_hub_use_the_character_favicon() -> None:
    workspace = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    hub = (ROOT / "apps/paper_workspace/static/hub.html").read_text(encoding="utf-8")
    favicon = ROOT / "apps/paper_workspace/static/favicon.ico"
    touch_icon = ROOT / "apps/paper_workspace/static/apple-touch-icon.png"
    assert '/favicon.ico?v=2' in workspace
    assert '/favicon.ico?v=2' in hub
    assert '/apple-touch-icon.png?v=2' in workspace
    assert '/apple-touch-icon.png?v=2' in hub
    assert favicon.is_file() and favicon.stat().st_size > 500
    assert touch_icon.is_file() and touch_icon.stat().st_size > 500


def test_workspace_language_chevron_uses_deterministic_geometry() -> None:
    components = (ROOT / "apps/paper_workspace/static/components.css").read_text(encoding="utf-8")
    assert '.language-control::after{content:"";position:absolute;top:50%' in components
    assert 'transform:translateY(-68%) rotate(45deg)' in components
    assert 'content:"⌄"' not in components


def test_shared_links_use_a_high_contrast_character_preview() -> None:
    workspace = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    hub = (ROOT / "apps/paper_workspace/static/hub.html").read_text(encoding="utf-8")
    preview = ROOT / "apps/paper_workspace/static/assets/share-preview-v2.png"
    for html in (workspace, hub):
        assert 'property="og:image" content="https://paper.glowme.kr/assets/share-preview-v2.png"' in html
        assert 'property="og:image:width" content="1200"' in html
        assert 'property="og:image:height" content="630"' in html
    assert preview.is_file() and preview.stat().st_size > 1_000


def test_workspace_serves_editor_preview_upload_and_assistant_surfaces() -> None:
    html = workspace_markup()
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
    assert "preview_entrypoints" in app
    assert "selectedEntrypoint" in app
    assert "const entrypoint=selectedEntrypoint()" in app
    assert "selectedPreviewMode" in app
    assert "preview_mode:selectedPreviewMode(entrypoint)" in app
    assert "자동 갱신 10" not in app
    assert "renderPdfPreview" in app
    assert "syncPdfToSource" in app
    assert 'id="sync-highlight"' in html
    assert "initialCoordinates=remoteCaretCoordinates(start)" in app
    assert "syncHighlightCoordinates" in app
    assert "activeLine.getBoundingClientRect()" in app
    assert "editor.scrollHeight-editor.clientHeight" in app
    assert "--sync-highlight-height" in app
    assert ".pdf-page canvas:hover,.pdf-page canvas:focus{outline:none!important}" in html
    assert "sync-soft-focus" in html


def test_projects_have_a_slug_scoped_hub_and_browser_state() -> None:
    html = (ROOT / "apps/paper_workspace/static/hub.html").read_text(encoding="utf-8")
    hub = (ROOT / "apps/paper_workspace/static/hub.js").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    caddy = (ROOT / "infra/paper-workspace/Caddyfile.password").read_text(encoding="utf-8")
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    assert "project-list" in html
    assert "/projects/index.json" in hub
    assert "projectSlug" in app
    assert "paper-workspace:${projectSlug}" in app
    assert "`${projectBase}/project/project.json`" in app
    assert "PAPER_PROJECTS_DIR" in compose
    assert "/p/([A-Za-z0-9]" in caddy
    assert "/projects/{re.project_asset.1}/{re.project_asset.2}" in caddy


def test_project_hub_uses_safe_first_page_thumbnails() -> None:
    hub = (ROOT / "apps/paper_workspace/static/hub.js").read_text(encoding="utf-8")
    css = (ROOT / "apps/paper_workspace/static/hub.css").read_text(encoding="utf-8")
    caddy = (ROOT / "infra/paper-workspace/Caddyfile.password").read_text(encoding="utf-8")
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    nginx = (ROOT / "infra/paper-workspace/nginx.conf").read_text(encoding="utf-8")
    assert "thumbnailPattern" in hub
    assert "project-thumbnail" in hub
    assert "data-project-fallback" in hub
    assert "`/projects/${encodeURIComponent(project.slug)}/thumbnail.png`" in hub
    assert "project-thumbnail-wrap" in css
    assert "public_thumbnail" in caddy
    assert "project-thumbnails:" in compose
    assert "project-thumbnail-storage-init:" in compose
    assert 'user: "${HOST_UID:-1000}:${HOST_GID:-1000}"' in compose
    assert "project_thumbnails:/usr/share/nginx/html/generated-thumbnails:ro" in compose
    assert "/generated-thumbnails/$1/thumbnail.png" in nginx


def test_project_hub_is_a_compact_sortable_paper_gallery() -> None:
    html = (ROOT / "apps/paper_workspace/static/hub.html").read_text(encoding="utf-8")
    hub = (ROOT / "apps/paper_workspace/static/hub.js").read_text(encoding="utf-8")
    css = (ROOT / "apps/paper_workspace/static/hub-ux.css").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")

    assert 'id="project-sort"' in html
    assert html.count('class="project-skeleton"') == 3
    assert "paper-workspace:project-sort" in hub
    assert "Recently active" in html
    assert "최근 작업순" in hub
    assert "편집 기록 있음" not in hub
    assert "project-page-count" in hub
    assert "page_count" in hub
    assert "/api/backups/activity" in hub
    assert "hub.lastEdited" in hub
    assert "modifiedAt" in hub
    assert "project.activity_id" in hub
    assert ".project-activity" in css
    assert "paper-workspace:last-active:" in app
    assert "markProjectActivity('edit')" in app
    assert "setEditorValueWithoutActivity(value)" in app
    assert "display:flex;flex-wrap:wrap;justify-content:center;align-items:stretch" in css
    assert ".project-card{width:100%;min-height:0;max-width:340px;flex:0 1 340px" in css
    assert ".project-activity{display:flex" in css
    assert "min-height:3.6em" in css
    assert "-webkit-line-clamp:3" in css
    assert ".project-card h3{min-height:0;font-size:16px}" in css
    assert ".hub-intro{align-items:center;padding:20px 24px" in css
    assert "max-width:340px" in css


def test_asset_selection_opens_a_zoomable_preview_and_download() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    for identifier in ("asset-viewer", "asset-image", "asset-zoom-in", "asset-zoom-out", "asset-download"):
        assert f'id="{identifier}"' in html
    assert "showAssetPreview" in app
    assert "isImageAsset" in app
    assert "assetZoom" in app
    assert "link.download=baseName(path)" in app


def test_workspace_panel_widths_are_resizable_and_persisted() -> None:
    html = workspace_markup()
    css = (ROOT / "apps/paper_workspace/static/app.css").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'data-resize="editor-preview"' in html
    assert 'data-resize="preview-assistant"' in html
    assert 'id="reset-layout"' in html
    assert "grid-template-columns:minmax(390px,var(--editor-width" in css
    assert "layoutKey='paper-workspace-layout'" in app
    assert "installPanelResizers" in app
    assert "setPointerCapture" in app
    assert "/app.css?v=__APP_CSS_HASH__" in html
    assert "/vendor/paper-collab.js?v=__PAPER_COLLAB_HASH__" in html
    assert "/app.js?v=__APP_JS_HASH__" in html
    dockerfile = (ROOT / "infra/paper-workspace/Dockerfile").read_text(encoding="utf-8")
    assert "sha256sum" in dockerfile
    assert "replace_hash index.html __PAPER_COLLAB_HASH__" in dockerfile
    assert "body.panel-resizing .workspace{transition:grid-template-columns .085s" in html
    assert ".sidebar{will-change:width,padding;transition:width .26s" in html
    assert "margin-left .26s cubic-bezier" in html
    assert "prefers-reduced-motion:reduce" in html


def test_editor_and_pdf_have_independent_persistent_zoom_controls() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    for identifier in ("editor-zoom-out", "editor-zoom-in", "pdf-zoom-out", "pdf-zoom-in"):
        assert f'id="{identifier}"' in html
    assert "event.metaKey||event.ctrlKey" in app
    assert "addEventListener('wheel'" in app
    assert "{passive:false}" in app
    assert "changeEditorZoom" in app
    assert "changePdfZoom" in app
    assert "editorZoom:1,pdfZoom:1" in app
    assert "installZoomControls" in app
    assert "viewer.style.zoom=String(layout.pdfZoom)" in app
    assert "displayScale=entry.scale*layout.pdfZoom" in app
    assert ".pdf-canvas-viewer{width:max-content;min-width:100%" in html


def test_workspace_has_submission_tooling_and_project_task_board() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    for identifier in (
        "run-submission-checks", "submission-check-list", "asset-inventory",
        "reference-inventory", "checkpoint-name", "create-checkpoint",
            "task-title", "add-task", "task-board", "download-source-package", "bibtex-import", "import-bibtex",
    ):
        assert f'id="{identifier}"' in html
    assert "runSubmissionChecks" in app
    assert "renderAssetInventory" in app
    assert "renderReferenceInventory" in app
    assert "renderTaskBoard" in app
    assert "createNamedCheckpoint" in app
    assert "downloadSourcePackage" in app
    assert "importBibtex" in app
    assert "compareServerBackup" in app
    assert "pdf_audit" in (ROOT / "apps/paper_workspace/compiler/server.py").read_text(encoding="utf-8")
    assert "poppler-utils" in (ROOT / "apps/paper_workspace/compiler/Dockerfile").read_text(encoding="utf-8")


def test_compile_errors_are_navigable_and_last_successful_pdf_is_preserved() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'id="compile-diagnostics"' in html
    assert 'id="fix-compile-error"' in html
    assert "parseLatexDiagnostics" in app
    assert "renderCompileDiagnostics" in app
    assert "compileDiagnosticSelection" in app
    assert "requestCompileDiagnosticFix" in app
    assert "latestCompileErrorDetail" in app
    assert "requestCodexRevision(selection,instruction,{handoff:true,displayInstruction})" in app
    assert "const tone=errorRow?'error'" in app
    assert ".status-dot.error{background:#f04438}" in html
    assert "goToSourceLocation" in app
    assert "if(hasPreviousPdf)" in app
    assert "notify('마지막 정상 PDF를 유지했습니다." in app
    assert "$('suggestion').innerHTML=`<div class=\"suggestion\"><strong>PDF 컴파일 오류" not in app


def test_project_version_upgrade_keeps_server_managed_sources_authoritative() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    manifest = json.loads(
        (ROOT / "examples/project-library/example-paper/project.json").read_text(encoding="utf-8")
    )

    assert "projectVersionChanged&&serverManagedProjectFiles.has(path)" in app
    assert "replaceSharedText(collabSession.textFor(name),state.files[name])" in app
    assert manifest["version"] != "unversioned"
    assert any(item["path"] == manifest["entrypoint"] and item["managed"] for item in manifest["files"])


def test_initial_compile_failure_replaces_pdf_spinner_with_error_state() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")

    assert "function pdfErrorMarkup" in app
    assert "if(!renderedPdfUrl)" in app
    assert "PDF를 만들지 못했습니다" in app


def test_synctex_supports_source_to_pdf_navigation() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    components = (ROOT / "apps/paper_workspace/static/components.css").read_text(encoding="utf-8")
    compiler = (ROOT / "apps/paper_workspace/compiler/server.py").read_text(encoding="utf-8")
    assert "syncSourceToPdf" in app
    assert "syncHighlightCoordinates" in app
    assert "activeLine.getBoundingClientRect()" in app
    assert "requestAnimationFrame(()=>showSourceSyncHighlight(start))" in app
    assert "height:var(--sync-highlight-height,23px)!important" in components
    assert "'/api/synctex-view'" in app
    assert "renderedSynctexFallback" in app
    assert "requestSynctex" in app
    assert "/SyncTeX cache expired/i" in app
    assert "event.metaKey||event.ctrlKey" in app
    assert 'self.path == "/synctex-view"' in compiler
    assert '"synctex", "view"' in compiler


def test_compiler_can_build_a_reproducible_source_package() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    compiler = (ROOT / "apps/paper_workspace/compiler/server.py").read_text(encoding="utf-8")
    assert 'id="download-source-package"' in html
    assert "'/api/package'" in app
    assert 'self.path == "/package"' in compiler
    assert "zipfile.ZipFile" in compiler
    assert "SHA256SUMS" in compiler


def test_profile_color_can_be_selected_and_persisted() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'name="profile-color"' in html
    assert html.count('class="color-swatch"') == 7
    assert "localStorage.getItem('collab-color')" in app
    assert "localStorage.setItem('collab-color',actor.color)" in app
    assert "$('collab-name').style.background=actor.color" in app


def test_profile_defaults_to_me_and_never_to_a_specific_person() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    hub = (ROOT / "apps/paper_workspace/static/hub.js").read_text(encoding="utf-8")

    assert "const defaultActorName=window.PaperI18n?.getLanguage()==='ko'?'나':'Me'" in app
    assert "if(localStorage.getItem('collab-name-user-set'))$('name-toast').hidden=true" in app
    assert "localStorage.setItem('collab-name-user-set','1')" in app
    assert "localStorage.setItem('collab-name-user-set','1')" in hub
    assert "?'daehwa':storedActorName" not in app


def test_collaborative_ux_exposes_source_pdf_and_compact_layout_states() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")

    for identifier in ("collab-label", "focus-modes", "source-conflict", "close-source-conflict", "pdf-freshness", "app-toasts", "action-dialog"):
        assert f'id="{identifier}"' in html
    assert "PaperCollab.createSession" in app
    assert "syncCurrentFileToShared" in app
    assert "setPdfFreshness" in app
    assert "installFocusModes" in app
    assert "ArrowLeft" in app and "ArrowRight" in app
    assert "window.alert=message=>notify" in app


def test_collaborators_render_as_an_avatar_stack_without_a_headcount() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    collaboration = (ROOT / "apps/paper_workspace/collaboration/client.js").read_text(encoding="utf-8")
    assert 'id="collaborator-avatars"' in html
    assert 'id="presence-label"' not in html
    assert ".collaborator-avatar" in html
    assert "collaboratorInitial" in app
    assert "avatar.dataset.tooltip" in app
    assert "명 ·" not in app
    assert "createRelativePositionFromTypeIndex" in collaboration
    assert 'id="remote-cursors"' in html
    assert "renderRemoteCursors" in app
    assert "goToCollaborator" in app
    assert "new WebsocketProvider" in collaboration
    assert "awareness.setLocalStateField" in collaboration


def test_text_selection_exposes_comment_and_codex_actions() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'id="selection-toolbar"' in html
    assert 'id="selection-comment"' in html
    assert 'id="selection-codex"' in html
    assert "Codex에게 요청 보내기" in html
    assert "prepareCodexRequest" in app
    assert "document.addEventListener('pointerup',finishSelectionDrag)" in app
    assert "document.addEventListener('pointercancel',cancelSelectionDrag)" in app
    assert "latexPreview" in app
    assert "mathPreview" in app
    assert "\\mathbb" in app
    assert "math-frac" in html
    assert 'class="latex-preview codex-proposal"' in app
    assert ".replace(/\\s*\\n\\s*/g,' ')" in app
    assert "let selectionDrag=null" in app
    assert "Math.hypot(event.clientX-selectionDrag.startX,event.clientY-selectionDrag.startY)>=3" in app
    assert "captureEditorSelection" in app
    assert "requestCodexRevision" in app
    assert "codex-thinking-spinner" in html
    assert "codex-thinking-progress" in html
    assert "codexThinkingStages" in app
    assert "startCodexThinking" in app
    assert "stopCodexThinking" in app
    assert 'role=\"status\"' in app
    assert "fetch('/api/codex'" in app
    for identifier in ("selection-codex-composer", "selection-codex-prompt", "selection-codex-send", "selection-codex-close"):
        assert f'id="{identifier}"' in html
    for identifier in ("selection-comment-composer", "selection-comment-prompt", "selection-comment-send", "selection-comment-close"):
        assert f'id="{identifier}"' in html
    assert "sendInlineCodexRequest" in app
    assert "closeInlineCodexComposer" in app
    assert "toolbar.classList.add('composing')" in app
    assert "toolbar.classList.add('sending')" in app
    assert "prefers-reduced-motion" in html
    assert "assistant-handoff" in html
    assert "assistant-content-in" in html
    assert "codex-thinking-in" in html
    assert "requestCodexRevision(selection,instruction,{handoff:true})" in app
    assert "activateAssistantTab(id,{handoff=false,focus=false}={})" in app
    assert 'role="tablist"' in html
    assert html.count('role="tab"') == 5
    assert "tab.setAttribute('aria-selected',String(selected))" in app
    assert "assistant-intro" in html
    assert ".assistant-intro{display:none}" in html
    assert ".codex-request-form{padding:0;border:0" in html
    assert ".suggestion.codex-result{margin-top:14px;padding:0 0 4px;border:0;border-radius:0;background:transparent;box-shadow:none" in html
    assert ".codex-followup{margin:0;padding:12px 0 10px;border:0" in html
    assert ".suggestion.codex-loading{border-left:0}" in html
    assert ".codex-followup-row{display:grid;grid-template-columns:minmax(0,1fr)" in html
    assert "#run-submission-checks{display:inline-flex" in html
    assert "#run-submission-checks::before{content:'▶'" in html
    assert "text-only navigation" in html
    assert ".assistant-tabs .tab::before{display:none!important}" in html
    assert "border-bottom:2px solid transparent" in html
    assert ".assistant-content textarea{resize:none!important}" in html
    assert ".join('\\n')" in app
    assert "Version history as a compact timeline" in html
    assert ".backup-list::before" in html
    assert ".backup-card::before" in html
    assert "grid-template-columns:minmax(0,1fr) auto" in html
    assert 'id="model-settings"' in html
    assert 'value="luna-medium"' in html
    assert 'value="luna-high"' in html
    assert 'value="sol-high"' in html
    assert "단문·문법·표현만" in html
    assert "논리 구조와 주장 강도" in html
    assert "paper-codex-profile" in app
    assert "installCodexProfileSettings" in app
    assert "profile:codexProfile" in app
    assert "codexConversation" in app
    assert "codexVisibleTurns" in app
    assert "codexConversationEpoch" in app
    assert "renderCodexThread" in app
    assert "ensureCodexThread" in app
    assert "renderCodexResult" in app
    assert "sendCodexFollowup" in app
    assert 'id=\"codex-followup-input\"' in app
    assert "profile:codexProfile,history" in app
    for identifier in ("codex-request-form", "codex-request-summary", "codex-request-text", "codex-new-request"):
        assert f'id="{identifier}"' in html
    assert "showSentCodexRequest" in app
    assert "startNewCodexRequest" in app
    assert "epoch!==codexConversationEpoch" in app
    assert "codex-change-details" in html
    assert "codex-result-actions" in html
    assert "원문을 바꾸기 전 검토하세요" in app
    assert "prepareInlineComment" in app
    assert "sendInlineComment" in app
    assert "addCommentForSelection" in app
    assert "$('selection-comment').onclick=prepareInlineComment" in app


def test_codex_prompt_wraps_and_enter_submits() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    css = (ROOT / "apps/paper_workspace/static/components.css").read_text(encoding="utf-8")
    assert 'id="instruction" wrap="soft"' in html
    assert "event.key!=='Enter'||event.shiftKey||event.isComposing||event.keyCode===229" in app
    assert "if(!$('ask').disabled)$('ask').click()" in app
    assert "#instruction{overflow-x:hidden" in css
    assert "#instruction::placeholder{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}" in css


def test_comment_prompt_has_no_horizontal_drag_track() -> None:
    css = (ROOT / "apps/paper_workspace/static/components.css").read_text(encoding="utf-8")
    assert "#comment-body{overflow-x:hidden" in css
    assert "#comment-body::placeholder{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}" in css
    assert "#add-comment{margin-top:8px}" in css


def test_preview_header_keeps_controls_without_redundant_title() -> None:
    html = workspace_markup()
    assert '<div class="panel-header preview-header"><span class="render-controls">' in html
    assert '<span>PDF 미리보기</span>' not in html
    assert ".preview-header{justify-content:flex-end}" in html
    assert ".preview-panel .preview-header{position:sticky;top:0" in html
    assert "left:-24px!important" in html
    assert "transform:translateZ(0)" in html
    assert 'id="download-pdf" class="pdf-control download-pdf"' in html
    assert 'aria-label="렌더링된 PDF 다운로드" disabled><svg' in html
    assert '<span>다운로드</span>' not in html
    assert ".render-state-spinner" in html
    assert ".render-state-label{position:absolute;width:1px" in html
    assert ".pdf-control{width:27px;height:27px;padding:5px;display:grid;place-items:center;border:1px solid transparent" in html
    assert ".zoom-controls{display:inline-flex;align-items:center;height:27px;border:0" in html


def test_sticky_pdf_toolbar_tracks_current_and_total_pages() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    viewport = (ROOT / "apps/paper_workspace/static/pdf-viewport.js").read_text(encoding="utf-8")
    assert 'id="pdf-page-indicator"' in html
    assert 'aria-label="현재 PDF 페이지"' in html
    assert ".pdf-page-indicator" in html
    assert "wrapper.dataset.page=String(pageNumber)" in app
    assert "updatePdfPageIndicator" in app
    assert "schedulePdfPageIndicatorUpdate" in app
    assert "installPdfPageIndicator" in app
    assert "page.getBoundingClientRect()" in viewport
    assert "PaperPdfViewport.currentPage" in app
    assert "현재 PDF ${pageNumber}페이지, 전체 ${pages.length}페이지" in app


def test_typing_does_not_replace_the_rendered_pdf_with_placeholder() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "const autoSaveDelayMs=1000" in app
    assert "window.saveTimer=setTimeout(()=>{if(save())compileAfterSave()},autoSaveDelayMs)" in app
    assert "function scheduleCompileAfterSave()" in app
    assert "setTimeout(()=>{save();render()},250)" not in app


def test_editor_shortcuts_support_mac_and_control_key_workflows() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    editor = (ROOT / "apps/paper_workspace/collaboration/editor.js").read_text(encoding="utf-8")
    assert "event.metaKey||event.ctrlKey" in app
    assert "if(key==='s')" in app
    assert "if(key==='z')" in app
    assert "historyKeymap" in editor
    assert "defaultKeymap" in editor
    assert "indentWithTab" in editor
    assert "installEditorShortcuts()" in app
    assert "editor.addEventListener('beforeinput',recordEditorHistory)" in app


def test_paper_assistant_can_be_collapsed_and_restored() -> None:
    html = workspace_markup()
    css = (ROOT / "apps/paper_workspace/static/app.css").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert 'id="toggle-assistant"' in html
    assert 'aria-expanded="true"' in html
    assert ".workspace.assistant-collapsed" in css
    assert "assistantCollapsed:false" in app
    assert "setAssistantCollapsed" in app
    assert "localStorage.setItem(layoutKey" in app
    assert "html,body{height:100%;overflow:hidden}" in html
    assert ".assistant-panel{display:flex;flex-direction:column;overflow:hidden}" in html
    assert ".assistant-panel>.assistant-content:not(.hidden)" in html
    assert "scrollbar-gutter:stable" in html
    assert ".workspace{min-height:0;overflow:hidden}" in html


def test_project_sidebar_can_be_collapsed_and_persisted() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    components = (ROOT / "apps/paper_workspace/static/components.css").read_text(encoding="utf-8")
    assert 'id="toggle-sidebar"' in html
    assert ".shell.sidebar-collapsed .sidebar" in html
    assert "sidebarCollapsed:false" in app
    assert "updateSidebarToggle" in app
    assert "layout.sidebarCollapsed=!layout.sidebarCollapsed" in app
    assert 'class="tree-action sidebar-toggle"' not in html
    assert ".side-heading .sidebar-toggle" in html
    assert 'id="sidebar-resizer"' in html
    assert 'data-resize="sidebar"' in html
    assert "sidebarWidth:224" in app
    assert "minSidebarWidth=180" in app
    assert "maxSidebarWidth=420" in app
    assert "--sidebar-width" in html
    assert "drag.sidebarWidth+event.clientX-drag.startX" in app
    assert "#files{flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto" in components
    assert "overscroll-behavior:contain;scrollbar-gutter:stable" in components


def test_local_files_and_folders_can_be_dropped_into_the_project_tree() -> None:
    html = workspace_markup()
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
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "선택 폴더에 자료 올리기" not in html
    assert 'id="upload" type="file" multiple hidden' in html
    assert "folder-children-inner" in app
    assert "grid-template-rows:1fr" in html
    assert "grid-template-rows:0fr" in html
    assert "row.setAttribute('aria-expanded'" in app
    assert "state.activeFolder=path" in app
    assert "pendingUploadFolder||state.activeFolder||'paper'" in app


def test_name_setup_toast_respects_hidden_state_and_closes_after_save() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert ".name-toast[hidden]{display:none}" in html
    assert "$('name-toast').hidden=true" in app


def test_workspace_accessibility_and_mobile_presence_contracts() -> None:
    static = ROOT / "apps/paper_workspace/static"
    html = (static / "index.html").read_text(encoding="utf-8")
    app = (static / "app.js").read_text(encoding="utf-8")
    css = (static / "ux.css").read_text(encoding="utf-8")
    assert 'id="remote-cursors" class="remote-cursors" aria-hidden="true"' in html
    assert "canvas.tabIndex=-1" in app
    assert "entry.canvas.tabIndex=0" in app
    assert "entry.canvas.tabIndex=-1" in app
    assert "body.tabIndex=0" in app
    assert "body.onkeydown" in app
    assert "setAttribute('aria-label','가져올 BibTeX 항목')" in app
    assert "setAttribute('aria-label','새 할 일 제목')" in app
    assert ".collaborator-avatars{display:flex;max-width:58px" in css
    assert ".app-toasts{right:max(8px,env(safe-area-inset-right));left:max(8px" in css


def test_dark_theme_covers_secondary_workspace_copy() -> None:
    css = (ROOT / "apps/paper_workspace/static/theme.css").read_text(encoding="utf-8")
    assert 'html[data-color-scheme="dark"] .status-center-list small' in css
    assert 'html[data-color-scheme="dark"] .task-meta' in css
    assert 'html[data-color-scheme="dark"] .backup-card-meta' in css
    assert 'html[data-color-scheme="dark"] .model-caption' in css


def test_dark_theme_reserves_white_for_rendered_paper() -> None:
    css = (ROOT / "apps/paper_workspace/static/theme.css").read_text(encoding="utf-8")
    assert '.sidebar .side-heading .tree-action' in css
    assert 'background:var(--theme-surface-raised)!important' in css
    assert '.suggestion:not(.codex-result):not(.codex-loading)' in css
    assert '.paper:has(.pdf-error-state)' in css
    assert '.diagnostic-item{background:#3a2025' in css
    assert 'border-color:transparent!important;background:transparent!important' in css


def test_comment_cards_navigate_to_source_and_can_be_resolved() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "comment-card" in html
    assert "goToComment" in app
    assert "commentLocation" in app
    assert "resolve-comment" in app
    assert "state.comments.filter" in app
    assert 'id="comment-anchors"' in html
    assert "renderCommentAnchors" in app
    assert "comment-line-indicator" in html
    assert "comment-anchor-marker" in html
    assert "activateAssistantTab('comments')" in app


def test_workspace_shell_assets_are_revalidated() -> None:
    nginx = (ROOT / "infra/paper-workspace/nginx.conf").read_text(encoding="utf-8")
    assert 'location = /index.html' in nginx
    assert 'location ~ ^/(app\\.css|components\\.css|ux\\.css|app\\.js)$' in nginx
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
    assert ":/workspace/project:ro" not in compose
    assert "reverse_proxy codex-bridge:8790" in caddy
    assert 'header_up Authorization "Bearer {$CODEX_BRIDGE_TOKEN}"' in caddy
    assert "codex-bridge-token" not in (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "timingSafeEqual" in bridge
    assert "--sandbox', 'read-only" in bridge
    assert "'--disable', 'shell_tool'" in bridge
    assert "'--disable', 'unified_exec'" in bridge
    assert "'--disable', 'multi_agent'" in bridge
    assert "containsSecret" in bridge
    assert "redactSecrets" in bridge
    assert "env: codexEnvironment()" in bridge
    assert "...process.env, CODEX_HOME" not in bridge
    assert "--ephemeral" in bridge
    assert "--output-schema" in bridge
    assert "@openai/codex@0.144.4" in dockerfile
    assert "gpt-5.6-sol" in bridge
    assert "gpt-5.6-luna" in bridge
    assert "'luna-medium'" in bridge
    assert "'luna-high'" in bridge
    assert "'sol-high'" in bridge
    assert "modelProfiles[payload.profile]" in bridge
    assert "boundedHistory" in bridge
    assert "revision_history" in bridge
    assert "history = boundedHistory(payload.history)" in bridge
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
    assert "preservedDraftPath=`paper/drafts/${previousVersion}.tex`" in app
    assert "state.files['paper/main.tex']=remoteMain" in app
    assert "def _needs_rerun" in compiler
    assert "if used_bibtex or _needs_rerun" in compiler
    assert '"compile_id"' in compiler
    assert '"-synctex=1"' in compiler
    assert '"-jobname=preview"' in compiler
    assert 'payload.get("entrypoint", "main.tex")' in compiler
    assert 'payload.get("preview_mode", "document")' in compiler
    assert "__fragment_preview.tex" in compiler
    assert 'self.path == "/synctex"' in compiler
    assert '"synctex_base64"' in compiler


def test_performance_paths_avoid_eager_assets_and_redundant_compile_work() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    compiler = (ROOT / "apps/paper_workspace/compiler/server.py").read_text(encoding="utf-8")
    backup = (ROOT / "apps/paper_workspace/backup/server.py").read_text(encoding="utf-8")
    collaboration = (ROOT / "apps/paper_workspace/collaboration/client.js").read_text(encoding="utf-8")
    nginx = (ROOT / "infra/paper-workspace/nginx.conf").read_text(encoding="utf-8")
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")

    assert "indexedDB.open('paper-workspace-assets'" in app
    assert "remoteAssetSources" in app
    assert "parallelLimit(paths,4" in app
    assert "const autoSaveDelayMs=1000" in app
    assert "trimEditorHistory" in app
    assert "layoutAnimationFrame=requestAnimationFrame" in app
    assert "compileController?.abort()" in app
    assert "compile_id" in app
    assert "compilePayloadFingerprint" in app
    assert "fetchPersistedPdfPreview" in app
    assert "persistPdfPreview" in app
    assert "compileRequestGeneration" in app
    assert "persistedPreview?.fingerprint===fingerprint" in app
    assert "relative.startsWith('drafts/')&&relative!==entrypoint" in app
    assert "const pdfPreRenderZoom=2" in app
    assert "pdfMaxCanvasPixels=16_000_000" in app
    assert "const releasePage=entry=>" in app
    assert "_cache_get" in compiler
    assert "COMPILE_CACHE_TTL" in compiler
    assert "if used_bibtex or _needs_rerun" in compiler
    assert "PAPER_PROJECTS_ROOT" not in compose
    assert ":/projects:ro" not in compose
    assert ":/project-default:ro" not in compose
    assert "zlib.compress" in backup
    assert "IndexeddbPersistence" in collaboration
    assert 'Cache-Control "public, max-age=31536000, immutable"' in nginx


def test_compiler_receives_only_request_scoped_files() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    compiler = (ROOT / "apps/paper_workspace/compiler/server.py").read_text(encoding="utf-8")
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")

    assert "remote_assets" not in app
    assert "PROJECT_LIBRARY_ROOT" not in compiler
    assert "DEFAULT_PROJECT_ROOT" not in compiler
    assert '"openin_any": "p"' in compiler
    assert '"openout_any": "p"' in compiler
    assert "PAPER_PROJECTS_ROOT" not in compose
    assert ":/projects:ro" not in compose
    assert ":/project-default:ro" not in compose


def test_backend_workers_have_bounded_and_clean_failure_paths() -> None:
    compiler = (ROOT / "apps/paper_workspace/compiler/server.py").read_text(encoding="utf-8")
    bridge = (ROOT / "apps/paper_workspace/codex_bridge/server.mjs").read_text(encoding="utf-8")
    collaboration = (ROOT / "apps/paper_workspace/collaboration/client.js").read_text(encoding="utf-8")

    assert "PAPER_MAX_CONCURRENT_COMPILES" in compiler
    assert "_compile_slots.acquire(blocking=False)" in compiler
    assert 'self.path == "/health"' in compiler
    assert "BrokenPipeError, ConnectionResetError" in compiler
    assert "detached: true" in bridge
    assert "process.kill(-child.pid, 'SIGKILL')" in bridge
    assert "await rm(outputPath, { force: true })" in bridge
    assert "bootstrapReady && isBootstrapLeader()" in collaboration


def test_server_paper_sources_are_live_mounted_and_versioned() -> None:
    compose = (ROOT / "infra/paper-workspace/compose.yaml").read_text(encoding="utf-8")
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    assert "PAPER_PROJECT_DIR" in compose
    assert ":/usr/share/nginx/html/project:ro" in compose
    assert 'user: "${HOST_UID:-1000}:${HOST_GID:-1000}"' in compose
    assert "../../paper/" not in compose
    assert "serverMainSnapshot" in app
    assert "sourceFingerprint" in app
    assert "persistedState({compactDrafts:true})" in app
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


def test_archived_drafts_are_bounded_by_a_shared_fifo_queue() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")

    assert "const archivedDraftLimit=30" in app
    assert "function draftQueuePaths()" in app
    assert "function pruneDraftQueue({sync=false}={})" in app
    assert "queue.filter(path=>path!==active).slice(0,excess)" in app
    assert "pruneDraftQueue({sync:true})" in app


def test_project_version_replaces_stale_collaboration_main() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    reconciliation = app[app.index("let preservedDraftPath=''"):app.index("state.projectVersion=projectManifest.version")]
    version_branch = "if(projectVersionChanged&&isLatexDocument(sharedMainValue)&&sharedMainValue!==remoteMain)"
    shared_branch = "else if(isLatexDocument(sharedMainValue))"

    assert reconciliation.index(version_branch) < reconciliation.index(shared_branch)
    assert "state.files[preservedDraftPath]=sharedMainValue" in reconciliation
    assert "replaceSharedText(collabSession.textFor('paper/main.tex'),remoteMain)" in reconciliation


def test_project_backups_are_verified_on_open_and_every_ten_minutes() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    css = (ROOT / "apps/paper_workspace/static/components.css").read_text(encoding="utf-8")

    assert 'id="backup-status"' in html
    assert 'id="create-backup"' in html
    assert 'id="backup-list"' in html
    assert "const backupIntervalMs=10*60*1000" in app
    assert "signature===lastBackupSignature" not in app
    assert "loadBackupHistory().finally(()=>createServerBackup('auto',{quiet:true}))" in app
    assert "createServerBackup('pre-restore')" in app
    assert "setInterval(()=>createServerBackup('auto'" in app
    backup_payload = app[app.index("function backupPayload"):app.index("function setBackupStatus")]
    assert "state.assets" not in backup_payload
    assert ".replace(/[^A-Za-z0-9_-]+/g,'-')" in app
    assert "#create-checkpoint{border-color:#2457d6;background:#2457d6;color:#fff" in css
    assert ".backup-card>.tool-row{gap:0;padding:1px;border:1px solid #dbe7ff" in css
    assert ".backup-card>.tool-row .backup-restore+.backup-restore{border-left:1px solid #dbe7ff!important" in css


def test_workspace_status_names_the_problem_and_offers_actions() -> None:
    html = workspace_markup()
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")

    for identifier in ("health-collab-action", "health-pdf-action", "health-backup-action"):
        assert f'id="{identifier}"' in html
    assert "`${problemName} 오류`" in app
    assert "`${problemName} 확인`" in app
    assert "activateAssistantTab('checks'" in app
    assert "createServerBackup('manual')" in app


def test_workspace_pending_operations_have_deadlines_and_precise_detection() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")
    translations = (ROOT / "apps/paper_workspace/static/workspace-i18n.js").read_text(encoding="utf-8")

    assert "collaborationWatchdogMs" in app
    assert "collabSession?.provider?.synced" in app
    assert "collaborationWatchdogFailed=true" in app
    assert "compileRequestTimeoutMs" in app
    assert "compileTimedOut=true;controller.abort()" in app
    assert "/대기|중|준비|waiting|preparing|compiling/" not in app
    assert "workspace.compile.timeout" in translations


def test_workspace_exposes_safari_and_manifest_icons() -> None:
    workspace = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    hub = (ROOT / "apps/paper_workspace/static/hub.html").read_text(encoding="utf-8")
    manifest = (ROOT / "apps/paper_workspace/static/site.webmanifest").read_text(encoding="utf-8")
    for html in (workspace, hub):
        assert 'rel="apple-touch-icon" sizes="180x180"' in html
        assert 'href="/apple-touch-icon.png?v=2"' in html
        assert 'rel="manifest" href="/site.webmanifest?v=2"' in html
        assert 'href="/favicon.ico?v=2"' in html
    assert (ROOT / "apps/paper_workspace/static/apple-touch-icon.png").is_file()
    assert (ROOT / "apps/paper_workspace/static/favicon.ico").is_file()
    assert '"name": "Paper Workspace"' in manifest
    assert '"background_color": "#172b4d"' in manifest


def test_appearance_mode_is_shared_across_hub_workspace_and_login() -> None:
    workspace = (ROOT / "apps/paper_workspace/static/index.html").read_text(encoding="utf-8")
    hub = (ROOT / "apps/paper_workspace/static/hub.html").read_text(encoding="utf-8")
    theme = (ROOT / "apps/paper_workspace/static/theme.js").read_text(encoding="utf-8")
    css = (ROOT / "apps/paper_workspace/static/theme.css").read_text(encoding="utf-8")
    gate = (ROOT / "apps/paper_workspace/password_gate/server.py").read_text(encoding="utf-8")
    dockerfile = (ROOT / "infra/paper-workspace/Dockerfile").read_text(encoding="utf-8")
    caddy = (ROOT / "infra/paper-workspace/Caddyfile.password").read_text(encoding="utf-8")

    for html in (workspace, hub):
        assert 'class="theme-trigger"' in html
        assert 'value="system"' in html
        assert 'value="light"' in html
        assert 'value="dark"' in html
        assert "/theme.css?v=__THEME_CSS_HASH__" in html
        assert "/theme.js?v=__THEME_JS_HASH__" in html
    assert "paper-workspace-theme" in theme
    assert "prefers-color-scheme: dark" in theme
    assert 'data-color-scheme="dark"' in css
    assert ".pdf-page" in css and "background:#fff" in css
    assert "paper-workspace-theme" in gate
    assert "replace_hash index.html __THEME_CSS_HASH__" in dockerfile
    assert "/theme.css /theme.js" in caddy


def test_uploaded_binary_assets_are_shared_through_the_server_store() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")

    assert "function serverAssetUrl" in app
    assert "async function loadServerAssets" in app
    assert "async function uploadServerAsset" in app
    assert "async function deleteServerAsset" in app
    assert "sharedAssets=collaborationMap('assets')" in app
    assert "await uploadServerAsset(destination,file" in app
    assert "asset.server?serverAssetUrl(path)" in app
    assert "await loadServerAssets()" in app
    assert "await moveServerAsset" in app
    assert "serverPaths.map(deleteServerAsset)" in app
    assert "asset?.server&&!sharedPaths.has(path)" in app


def test_backup_health_uses_last_verified_time_not_only_new_snapshot_time() -> None:
    app = (ROOT / "apps/paper_workspace/static/app.js").read_text(encoding="utf-8")

    assert "items[0]?.checked_at" in app
    assert "최근 백업 확인" in app
