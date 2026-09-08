# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-09-08
- Primary surfaces: project hub, source/PDF/assistant workspace, profile and appearance dialogs.
- Evidence: `README.md`, `apps/paper_workspace/static/{index,hub}.html`, existing CSS and theme tokens, browser regression tests, and the user's collapsed-sidebar screenshot.

## Brand
- A quiet research workspace with the existing desk character, blue primary actions, and restrained neutral surfaces.
- Show trustworthy save, collaboration, and render status without crowding the manuscript.
- Preserve the established identity and typography during corrections.

## Product goals
- Keep writing, reviewing, and navigating PDFs predictable across screen sizes.
- Make state changes, failures, and recovery actions understandable.
- Success: readable controls, no overlapping hit targets, retained editing context, and reproducible interaction tests.
- Non-goals: a new brand, framework migration, or decorative animation unrelated to an action.

## Personas and jobs
- Researchers write LaTeX, collaborators review selections, and maintainers operate the shared service.
- Work includes long editing sessions, narrow windows, touch devices, and intermittent connections.

## Information architecture
- Hub selects projects; the workspace contains files, source, PDF, and assistant tools.
- The assistant retains distinct revision, comments, sources, checks, and tasks tabs.
- Primary document actions take precedence over secondary settings and status detail.

## Design principles
- Derive presentation from the existing shared state; hidden surfaces must not interrupt editing or initialization.
- Keep controls anchored to their owning panel. Collapsing a surface must remove its inactive controls from view and keyboard navigation.
- Preserve cursor, scroll, focus, and document identity through layout and asynchronous changes.

## Visual language
- Color: use `--theme-*` tokens for application surfaces and text; rendered paper stays white.
- Source syntax: `--theme-syntax-*` supplies a restrained, readable light/dark palette without changing CodeMirror document or undo state.
- Typography: retain the UI font stack and monospace source font. Truncate long metadata within a bounded region, not action buttons.
- Spacing: use the established 4/8px rhythm and explicit gaps between labels and controls.
- Shape: compact rounded controls, restrained borders, and elevation only for overlays.
- Motion: 120–200ms for ordinary state feedback. Pointer-driven resizing and assistant grid-width changes are immediate so controls do not compress during opening. Reduced-motion removes spatial transitions while preserving status feedback.
- Icons: reuse the current SVG vocabulary; every icon-only action has an accessible name and a centered, bounded hit target.

## Components
- Reuse panel headers, tool buttons, resizers, tabs, file rows, cards, dialogs, toasts, and theme controls.
- Keep hover, focus-visible, active, disabled, expanded, loading, and selected states coherent.
- Shared styling belongs in the existing CSS layers; theme colors remain owned by `theme.css` rather than another token system.

## Accessibility
- Maintain keyboard reachability, visible focus, descriptive names, and accurate expanded/selected/disabled semantics.
- Use readable theme-specific secondary text. Do not use color or animation as the only status cue.
- Aim for at least 36px desktop utility targets and 44px touch targets where the existing layout permits.
- Return focus from overlays to their trigger; do not leave focus in collapsed content.

## Responsive behavior
- Preserve the current breakpoints: mobile below 768px, focused compact workspace, and full desktop panels where space permits.
- Test 320px and 390px mobile widths plus 1024px and 1600px desktop layouts.
- Mobile headers may stack file and status text while keeping all actions within the viewport.
- A collapsed sidebar is a deliberate rail with a discoverable expand control; hidden search and file controls must not shrink into the rail.
- The workspace reserves more width for source and PDF: sidebar widths remain resizable between 180px and 320px, with a 224px default. Existing wider settings are constrained to the new maximum without resetting unrelated preferences.
- Desktop file rows use a compact 30px rhythm with 13px labels and full-path tooltips; touch rows retain 44px targets.
- Show shortcuts only for real project entries (manifest entrypoint, available body folder, bibliography). Revealing the current file clears filtering and expands only its ancestors; startup preserves the user's folder choices.
- Zoom shortcuts are explicit actions: restore the source to 100% or the PDF to its existing fit-width baseline. Loading, switching documents, and resizing must not reset a stored custom zoom.
- Let the project title use available header width. A named topbar assistant control opens the desktop panel; mobile keeps its named bottom navigation. Collapsing the assistant removes its panel and resizer. Preserve keyboard focus, editing selection, and document state.
- The project hub uses a 1440px maximum content width with responsive grid tracks of at least 300px where space permits. Incomplete rows start at the left, and filtered results retain the same track widths.
- Keep full-page previews contained in a compact neutral well (144px maximum paper width; 128px on small screens). Titles and recent activity take priority over decorative cover area.
- Hub titles use a readable three-line desktop allocation, descriptions use at most two lines, and activity/page metadata remains at least 12px. Card rows and metadata align despite varied copy lengths.
- The hub's decorative arrow points right for internal workspace navigation and moves only horizontally on hover; reduced-motion disables that movement.

## Interaction states
- Loading: bound work and preserve the last usable content.
- Empty: distinguish an empty result from data that could not be loaded.
- Error: keep failures within their owning surface and offer a relevant recovery action.
- Success: confirm the completed action without resetting selection or conversation.
- Disabled: retain legible labels and avoid misleading hover feedback.
- Offline/slow network: distinguish local persistence from shared synchronization and source-file writeback.

## Content voice
- Concise, concrete English and Korean UI copy; the selected locale applies to generated status and units too.
- Use existing product terminology consistently. Do not expose internal exceptions or implementation details in ordinary user flows.

## Implementation constraints
- Preserve vanilla JavaScript, CodeMirror, Yjs, PDF.js, existing public APIs, and stored data compatibility.
- Avoid new dependencies and full stylesheet rewrites for targeted corrections.
- Validate real browser geometry and interaction states, including reduced motion, alongside relevant regressions.

## Open questions
- [ ] Broader browser/device support beyond the verified matrix remains a product decision; report untested environments explicitly.

## Professional finish
- Status: Approved for implementation on 2026-09-08; this section refines the earlier visual language requirements.
- User objective: make the workspace feel like a professional manuscript tool, with a coherent hierarchy across file navigation, source editing, PDF review, and assistant tools.
- Evidence: deployed 2048px light and 1600px dark workspace screenshots, current component/theme styles, and the user's request for a more professional appearance.
- Approved direction: quiet document editor, using the reviewed interactive mockup as the visual reference.
- Unify application chrome: a compact neutral header, a stable brand slot for the existing desk mark, and a document title that reveals its input border only when editing. Light and dark themes share the same component hierarchy.
- Unify panel headers: one height, common icon stroke and target sizes, and explicit groups for zoom, page context, and file actions. Reserve emphasis for the current file and actions that need attention.
- Make quick navigation visibly different from the file tree. Use concise labeled destinations, file-type icons, and a compact current-file locator instead of a full-width input-like button.
- Keep the existing resizable panels and saved preferences. The demonstration starts with a modest sidebar; screenshots of a saved maximum-width sidebar are not evidence that resizing is absent.
- The named desktop assistant control lives in the main toolbar, removing the empty right rail when collapsed. Where the workspace cannot fit the two 390px document panes plus a 240px assistant and dividers, the assistant opens as a side drawer. Mobile retains its bottom Assistant navigation. Closing returns to the previous source/PDF view and restores keyboard focus.
- Make the rendered sheet the primary reading surface with restrained stage contrast and one subtle shadow. Apply a coordinated syntax palette in a later implementation only after checking existing contrast expectations.
- The local interactive visual uses fictional manuscript text. Theme, file navigation, source zoom, and the assistant control demonstrate presentation states only.
- Acceptance: 56px desktop app header, aligned 48px panel headers, neutral title surface with a border when focused, file-type icons, no empty collapsed assistant rail, and all existing mobile/focus/undo/PDF-anchor/collaboration behavior verified.
