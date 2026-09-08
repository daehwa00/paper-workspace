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
- Source syntax: preserve CodeMirror's light palette; `--theme-syntax-*` supplies readable dark colors without changing document state.
- Typography: retain the UI font stack and monospace source font. Truncate long metadata within a bounded region, not action buttons.
- Spacing: use the established 4/8px rhythm and explicit gaps between labels and controls.
- Shape: compact rounded controls, restrained borders, and elevation only for overlays.
- Motion: 120–200ms for ordinary state feedback. Pointer-driven resizing follows the pointer immediately. Reduced-motion removes spatial transitions while preserving status feedback.
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
