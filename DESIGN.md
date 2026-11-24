# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-11-12
- Primary surfaces: login, project hub, source/PDF/assistant workspace, Rebuttal, profile/appearance, rules and backup/export dialogs.
- Evidence: user-provided `linear-ui-reference-20.zip`, the 2026 Linear app refresh and component crops, `docs/paper-platform/linear-reference-2026.md`, current HTML/CSS/JavaScript and browser regressions. Screenshot measurements and implementation estimates are distinguished below.

## Brand
- A quiet research workspace with the Folio brand mark, indigo primary actions, and restrained neutral surfaces. The desk character may be used as an illustration, not as the app logo.
- Show trustworthy save, collaboration, and render status without crowding the manuscript.
- Preserve product identity; the 2026 Linear reference below replaces prior appearance constraints.

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
- Response English/Korean switches retain the reading passage and screen position in both source and OpenReview views. Use current translation pairs, preserve the anchor through delayed paragraph arrival, and cancel late restoration when the user moves or changes response/view. Unaligned manual drafts use approximate reading progress; never rewrite a draft to align its viewport.
- Remember review and response language choices independently per project in browser preferences, restoring them before initial rendering. Restoring Korean must wait for collaboration readiness, and a hidden Rebuttal must not start translation until the user opens its review view.
- Paper's sidebar drag target stays transparent over the shared frame seam. Preserve its pointer/keyboard hit area, and paint only a one-pixel line on hover, focus or drag so the header and content borders remain aligned like Rebuttal.

## Visual language
- Color: use `--theme-*` tokens for application surfaces and text; rendered paper stays white.
- Source syntax: `--theme-syntax-*` supplies a restrained, readable light/dark palette without changing CodeMirror document or undo state.
- Typography: retain the UI font stack and monospace source font. Truncate long metadata within a bounded region, not action buttons.
- The bundled Inter file is byte-identical to the current public Linear CDN Inter asset (`docs/paper-platform/design-refresh/frame-ownership/inter-asset-equivalence.json`). This proves asset equivalence only; source screenshot font settings, source build and Korean fallback remain separate verification items.
- Spacing: use the established 4/8px rhythm and explicit gaps between labels and controls.
- Shape: compact rounded controls, restrained borders, and elevation only for overlays.
- Motion: 120–200ms for ordinary state feedback. Pointer-driven resizing and assistant grid-width changes are immediate so controls do not compress during opening. Reduced-motion removes spatial transitions while preserving status feedback.
- The desktop review header stays transparent over the sidebar heading so its title and collapse/expand arrow are not painted over; preserve the opaque mobile header.
- Icons: reuse the current SVG vocabulary; every icon-only action has an accessible name and a centered, bounded hit target.

## Components
- Cross-surface consistency audit: retain the already aligned 13px location titles and 48px panel headers. Paper and Rebuttal editor footers share 32px height, 12px text, centered content and 6px/18px padding, without changing their counters. Mode tabs retain 34px desktop height and use the 44px control token on touch. Review language, preview and notes controls follow the same 28px/44px token; quiet hover uses theme-hover and active state theme-selected. Light-mode faint text must retain at least 4.5:1 contrast on the sidebar background; use the existing faint token rather than page-specific color overrides.
- The retained Rebuttal iframe and its document canvas have opaque theme backgrounds. While Rebuttal is active, the underlying mounted Paper shell has zero opacity; switching back restores it without remounting or losing edits. Contain root overscroll so notices, dialogs and viewport changes cannot expose the underlying manuscript.
- The main library heading contains a paper-document icon, localized All papers label and total count. Omit the duplicate Projects breadcrumb, separator, calendar icon and paper search field. Keep sorting aligned to the right, including on narrow screens; the sidebar calendar remains independent.
- Hub background refreshes reconcile rows by project slug and preserve decoded thumbnail nodes when their source URL is unchanged. Update only changed text/metadata regions and move retained rows for sorting. Keep an existing missing-image fallback through background refreshes; a changed thumbnail URL may replace that project's preview. Parse prospective rows in an inert template to avoid duplicate image requests.
- Direct Rebuttal refreshes retain a cached confirmed paper title, then resolve the manuscript title from synchronized shared text or a read-only manifest/main-source lookup. Never copy a loading placeholder into the Rebuttal title. This lookup must not bootstrap manuscript files, write shared content or start PDF compilation; late lookup results cannot overwrite a title already confirmed by the Paper editor.
- Desktop hub rows group secondary metadata at the right in shared compact columns: author 32px, date 88px, venue 108px and page count 32px, with 8px inside each pair and 20px between pairs (12px on tablet). Sort ends at the page-count edge. Keep the responsive stacked layout on narrow lists and truncate long labels within their columns.
- Hub activity timestamps use compact KST labels: just now, minutes/hours for today, yesterday and days ago through seven calendar days, then month/day; include the year for previous years. Keep the precise KST date/time in a tooltip and accessible label. Refresh relative labels every minute without replacing active metadata inputs.
- Reuse panel headers, tool buttons, resizers, tabs, file rows, cards, dialogs, toasts, and theme controls.
- Keep hover, focus-visible, active, disabled, expanded, loading, and selected states coherent.
- Shared styling belongs in the existing CSS layers; theme colors remain owned by `theme.css` rather than another token system.
- Hub venue tags open small anchored editors, separate from the row's project link. Venue selection supports existing labels, a custom name/year, arXiv and unspecified. Selecting a suggestion saves immediately; custom venue edits save with Enter or Save and cancel with Escape/outside click. Subtitles use quieter 11px text and a text cursor on hover; clicking replaces the text with an inline field, without a dialog. Enter or leaving the field saves, Escape cancels, and failed/conflicting saves retain the draft for an explicit Enter retry. IME composition must not submit. Empty fields show an Add affordance.
- Project metadata is shared server state. Save success offers Undo; a stale revision must not overwrite another person's edit. Failures preserve input and show a local error. Viewers see metadata without edit actions. The editor retains draft input during background refresh and returns focus on closing. Target venue changes link to reviewing Rebuttal rules, which require separate application.
- The desktop hub sidebar uses a minimal monthly deadline calendar: localized month/year, Today/previous/next controls, Sunday-first weekdays, six stable weeks and muted adjacent-month dates. Calendar dates, today, D-day and times use Asia/Seoul (KST), including when the browser is elsewhere. Today has a short 10px underline below its numeral in both calendar sizes, using the current text color so selected dates and dark mode retain contrast; selected dates use a solid black background with white numerals/markers in light mode and an inverse light background with dark numerals/markers in dark mode. Abstract uses a hollow neutral dot, Full paper a filled dot, and Commitment a hollow diamond. Calendar markers and imminent-deadline emphasis are black in light mode and light neutral in dark mode; no colored conference accents. Use the same button anatomy and fixed numeric baseline for all 42 dates, including empty and adjacent-month days. Render indicators in a separate absolute slot above the date, inset 4px from the cell top for a compact gap, never shifting its number. Empty dates remain selectable without opening a popover; selecting one also dismisses an open detail card. Pointer activation never moves focus to the close button; keyboard activation focuses the popover container, with Tab reaching its close button and links. Show at most two dots plus an overflow count. Only confirmed ICORE 2026 A*/A deadlines appear; never guess missing timezones or dates. Show the next two confirmed deadlines below the grid regardless of the viewed month. Keep the heading “Upcoming deadlines” in English in both languages, at 12px semibold in the strong text color; omit the visible KST label while retaining KST in accessible deadline times. Emphasize only today/tomorrow countdowns at 10px/650 while retaining the neutral palette. Align countdowns in a fixed right-hand column spanning both text lines; use a consistent left inset and tabular numerals for deadline dates. Date and upcoming-row buttons open a 368px-wide (viewport-clamped), light-dismiss, keyboard-accessible detail popover with 16px padding and readable 12px body/15px conference titles; it opens with conference year, research focus, verified location and local event dates, all known submission milestones in KST, and separate official website/schedule links; distinguish ARR submission and reviewed-paper commitment. Anchor detail cards 12px beyond the entire sidebar right edge, never over the calendar; retain the trigger’s vertical position subject to viewport bounds. Constrain card width to the space on the right when necessary. Keep detail typography relaxed (1.7 line-height, .015em tracking) with clear gaps between facts, milestone rows, notes and links. Omit the visible submission-deadline/KST section heading; retain KST in accessible milestone labels. Do not repeat the selected calendar date in the popover header or display ICORE rank badges; the calendar selection background identifies the date and rank is only an internal eligibility filter. Preserve month and focus during project refreshes and language changes. Project navigation stays in the main list. Source ledger: `docs/paper-platform/conference-deadlines-2026-2027.md`. A month-header expand control opens a large modal month view using the same KST data and viewed month. Show every confirmed conference and submission stage directly inside its date cell, with hollow/filled/diamond markers and no rank badges. Month navigation and Today synchronize with the mini calendar. Vertical wheel gestures over the expanded month grid navigate one month per gesture when the grid fits; preserve native scrolling for overflowing layouts and detail content, and ignore pinch zoom. Adjacent-month numerals blend the faint token at 55% with the surface in both calendars; selected-date contrast takes precedence. Both calendars use one date Tab stop, arrow-key date movement with month/year rollover, and Enter activation; expanded date activation opens its first known conference without changing pointer selection behavior. Detail close buttons align vertically with the first conference title while retaining 28px desktop/44px touch targets. Clicking a conference reveals the existing detail content in a separate in-dialog panel, never covering the month grid. Open/close its reserved width with a reversible 220ms ease-out transition; slide live content into place without fading and keep the content width fixed to prevent text reflow. Respect reduced motion. Preserve the selected conference, detail DOM and scroll position across month/Today navigation. Unselected conference items have transparent backgrounds; only the active item is filled. Keep Escape/close focus restoration, localize controls, and support narrow/short viewports with scrolling.

## Accessibility
- Maintain keyboard reachability, visible focus, descriptive names, and accurate expanded/selected/disabled semantics.
- Use readable theme-specific secondary text. Do not use color or animation as the only status cue.
- Compact desktop controls use the shared 28px height; mobile and coarse-pointer targets use 44px. Login uses the observed 44px targets. These dimensions are product implementation choices, not measured Linear CSS tokens.
- Assistant tabs have one initial Tab entry, arrow/Home/End navigation, and a named panel associated with each tab. Dialogs and editable profile names are labelled by their visible translated titles.
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
- The project hub retains the shared app rail and saved width, with brand, calendar and account controls on the left and the project list in the main pane. Below 768px, keep the compact mobile header and hide the sidebar calendar.
- Hub previews are compact 24×30px document thumbnails. Titles and recent activity take priority over decorative cover area.
- Hub titles wrap, descriptions use at most two lines, and metadata shares stable columns. Mobile collapses metadata beneath the title.
- The hub heading uses the same thumbnail/title start and horizontal padding as project rows. The sort control stays aligned to the right with no paper search field; the compact toolbar adapts to the available list width, including with a saved wide sidebar. Below 520px of list space, metadata stacks under the title and thumbnails align with its first line.
- The hub uses plain selectable rows without decorative moving arrows.

## Interaction states
- Loading: bound work and preserve the last usable content.
- Empty: distinguish an empty result from data that could not be loaded.
- Error: keep failures within their owning surface and offer a relevant recovery action.
- Success: confirm the completed action without resetting selection or conversation.
- Disabled: retain legible labels and avoid misleading hover feedback.
- Offline/slow network: distinguish local persistence from shared synchronization and source-file writeback.

## Content voice
- Omit the routine “Changes save automatically” footer label in Rebuttal. Preserve actual autosave, read-only and connecting/error status. Show only the character count at the right of the response footer (e.g. “123자” / “123 characters”); omit the routine word count.
- Concise, concrete English and Korean UI copy; the selected locale applies to generated status and units too.
- Use existing product terminology consistently. Do not expose internal exceptions or implementation details in ordinary user flows.

## Implementation constraints
- Preserve vanilla JavaScript, CodeMirror, Yjs, PDF.js, existing public APIs, and stored data compatibility.
- Keep the current runtime; consolidate styles for this authorized full redesign.
- Validate real browser geometry and interaction states, including reduced motion, alongside relevant regressions.

## Open questions
- [ ] Broader browser/device support beyond the verified matrix remains a product decision; report untested environments explicitly.

## Previous design context (superseded visually by the 2026 reference)
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

- PDF toolbar: an explicit project-local “Pin main document” toggle fixes compilation to the manifest entrypoint while other files remain editable. The browser remembers the choice per project; unpinning restores current-file preview. A target change invalidates in-flight output and marks the prior PDF stale until rebuilt.

## Personal spaces and access
- Personal space URLs (`/<username>`) retain the existing hub appearance and show the signed-in space name plus a sign-out action.
- Login uses the space name and an individually issued password; display names never confer authority.
- Catalogs and every project data endpoint enforce server membership. A hidden card is not an access boundary.
- Viewers see a read-only source indicator; server collaboration rejects document updates and backup/asset mutations.
- Existing `/p/<slug>` routes and collaboration room identities survive account migration.

## Rebuttal workspace
- Primary route: `/p/<slug>/rebuttal`, with a shareable selected round. The manuscript and rebuttal share branding, locale, theme and project access.
- The default workspace is reviewer selection in the left rail, original review in the center, and the response editor on the right. Overview/rules, evidence/work and submission remain secondary tools. Optional common responses must never appear as required empty work.
- Reuse the existing neutral surfaces, indigo actions, typography, panel headers and focus treatments. Avoid another token or component system.
- Wide screens prioritize the original/translated review and response editor with a resizable split. Reviewer navigation shows required-concern progress. Concern details, manual links and individual analysis jobs are disclosed on demand. Compact screens stack readable panels and retain an accessible relationship list.
- A concern may refer to discontiguous review passages, and a mapping may reference several passages across response documents. Selection highlights all related passages; line hover/focus reveals source quotes, reason, missing requirements and analysis version. Click pins the explanation. Do not depend on hover or color alone.
- Editing immediately marks dependent analysis and human confirmations as needing review. It never starts an LLM request. Counts update mechanically from the assembled submission text.
- The original review remains available beside the Korean translation. Translation uncertainty and extraction corrections remain visible and attributable.
- Analysis sufficiency and human work status are distinct. Progress counts required concerns rather than connection edges, and includes explicit partial/missing/uncertain states.
- Concessions and uncertainty are contextual review annotations, not errors to delete. Rewrites require explicit selection and preserve undo.
- Rules created manually, imported from forms or researched by AI remain drafts until an owner/editor applies a version. Show original sources, year, unresolved conflicts and differences before applying.
- Submission preview excludes internal review text, translation, comments and analysis. Display per-target and aggregate budgets and a distinct stale-PDF state.
- Validation matrix: 320/390px touch, 1024/1600px desktop, both themes, keyboard-only mapping selection, long reviews, empty and disconnected states, two-browser edits, and reduced motion.

## Linear reference contract — 2026-10-26

This section supersedes earlier visual dimensions, gallery/card layout, blue palette and “preserve current appearance” guidance. Functional contracts above remain active.

### Evidence and version
- Primary: https://linear.app/now/behind-the-latest-design-refresh (March 12, 2026), actual product detail images. Local originals: `.omx/artifacts/linear-refresh/{sidebar,frame,header,palette}.png`.
- `sidebar.png`: RIGHT is the new sidebar. `frame.png`: LEFT is the new rounded surface / pill control treatment (the article explicitly labels new borders on the left). `header.png`: location and view bars. `palette.png`: internal theme editor, not a complete public token specification.
- https://linear.app/now/how-we-redesigned-the-linear-ui (March 28, 2024) was inspected for chronology only. Its palette and component geometry are NOT mixed into the baseline.
- Historical note: the earlier pass had no attachment. The user has now supplied `linear-ui-reference-20.zip` (20 official product UI images). The 2026 attachment audit below supersedes that absence statement. No authenticated Linear screen was accessed; source viewport, browser zoom and DPR remain unknown.

### Extraction before implementation
| Element | Observed reference | Paper Workspace token / implementation estimate |
| --- | --- | --- |
| Surface hierarchy | darker navigation; slightly lighter work surface; elevated menu | dark bg #080808, surface #0f0f11, raised #191a1c; light bg #f5f5f5, surface #fff, raised #fff |
| Exact visible color labels | palette editor explicitly shows bgBase #0e1012, bgBaseHover #141517, bgSub #060708 | these three values transcribed; they are evidence from an internal example, not a claim of universal official tokens |
| Text hierarchy | near white body, muted inactive navigation | dark #e6e6e7 / #999a9e / #85858b; light #27272a / #626269 / #71717a; estimates adjusted for readable contrast |
| Accent | internal palette shows periwinkle accent | #5e6ad2 estimated, only primary action/focus, neutral navigation selection |
| Typography | compact sans-serif; regular body and medium labels | system sans stack, 13px/1.5 body, 12px metadata, 500 labels, 600 headings; family and CSS sizes not recoverable from editorial crops |
| Button hierarchy | quiet icon actions, filled rounded selected pills; no box around every action | 28px desktop height, 8px horizontal padding, 6px radius; icon controls 28px, icons16px/1.6 stroke; 44px touch targets |
| Navigation | dim inactive text; softly filled selected row; smaller icons | 224px resizable rail, 30px rows, 8px inset, 8px icon gap; estimates |
| Headers | distinct location and local view bars; controls align vertically | 48px app/location bar, 48px local panel toolbar; estimates |
| Tabs | compact rounded selection, neutral fill | 28px pills with 6px radius; selected text remains high contrast |
| Menus/dialogs | full end-user examples absent | shared 8px menu / 12px dialog radius, subtle border, overlay shadow; explicit extrapolation |
| Boundaries | low contrast, fewer separators, rounded main surface | 1px #292a2e dark / #e5e5e5 light, 10px frame corner; resizer hit zone retained |
| States | static examples show selected state only | hover #141517 dark / #ededee light; focus 2px accent; disabled opacity .5; busy cursor + existing status/spinners; these interaction choices are estimates |
| Motion | not measurable from static images | 120ms color/opacity; reduced-motion removes animations and spatial transitions |

### Ownership and application
- `theme.css`: the single shared color/typography/size token source and reusable control, field, selection, overlay, profile/appearance primitives. Both themes use identical geometry.
- `app.css`: manuscript frame/panel layout; `components.css`: manuscript-specific editor/PDF/assistant/file components; `ux.css`: responsive and interaction contracts. Old literal palette values are replaced at their source, not covered by an extra override stylesheet.
- `hub.css` / `hub-ux.css`: hub list and responsive layout; `rebuttal.css`: rebuttal layouts and domain-specific mapping states. They consume the same theme variables and controls.
- Authentication page is served independently before static assets are accessible: its scoped CSS mirrors the same tokens and controls without changing authentication.
- PDF canvas/document colors, collaboration identity colors and semantic diff/analysis colors retain their meaning. Text editing, Yjs, API calls, access control and persistence handlers are unchanged by presentation work.
- Preserve every existing action. Primary: submit/apply/send; secondary: explicit utility operations; quiet: navigation/toolbars/row actions; danger: destructive operation. Disabled/loading/readonly states stay backed by existing state.

### Validation and limits
- Capture before/after at DPR1, 1600×1000, with document.fonts.ready and reduced motion; also validate 320, 390 and 1024px, long Korean/English labels and both themes.
- Compare only corresponding chrome/control crops; published editorial crops have unknown scale, so normalized visual comparison is diagnostic, not an identical-viewport pixel equivalence claim. Never use whole-page pixel differences as a similarity percentage.
- Exact light-mode, login, end-user menu and modal parity cannot be established from the supplied public dark editorial crops. Those remain consistent extrapolations until same-version actual app screenshots (including hover/focus/open states and viewport/zoom) are supplied.

### Raster sampling refinement
After inspection of the original PNGs (no web compression query), dominant flat pixels in sidebar new/right crop are navigation #080808 and selected row #1b1b1e; frame new/left upper surface is #0f0f11 and selected pill #32343a. These sampled screenshot values now own dark navigation/surface/selection tokens instead of extrapolating the internal theme-editor example. Pixel coordinates: sidebar nav (1560,600)-(2330,680), selected (1560,710)-(2340,805); frame surface (100,600)-(1500,800), pill (170,1130)-(400,1200). Editorial fade areas are excluded. These are measured raster colors, not claims about the underlying official CSS. Typography/geometry and light theme remain estimates.

Typography reproducibility: bundle unmodified upstream Inter Variable (SIL OFL 1.1) as `/assets/inter-variable.woff2`; wait for `document.fonts.ready` before capture and verify the platform font via browser CDP. This removes the observed DejaVu Sans fallback for Latin UI text. Korean glyphs retain OS fallback. Authentication is standalone and retains the system stack. Exact Linear font-version equivalence remains unverified.

## Project workspace navigation (2026-10-26)
- Writing and reviews/responses share a two-link primary tab row above their screen tools. Active mode uses a neutral selected pill and aria-current. Source/PDF focus controls remain subordinate.
- The project hub links to projects only; writing/review mode switching belongs inside the project workspace.
- Returning retains the selected writing file and restores its cursor/scroll when it still exists; review navigation restores valid round, document, reviewer and screen identifiers. Positions live in project-scoped session storage, with no manuscript or response text.
- Keep the existing Linear-style rails and theme tokens; mobile tabs keep touch-size targets.

### Project presence and response cursors (2026-10-28)
- The shared upper-right presence control lists the current paper's connected
  people across both Paper and Rebuttal. It does not aggregate other projects.
- The closed control shows only other people's profile avatars, without an
  online count, label or enclosing chip. Omit the local profile from the list;
  hide the control when no other collaborator is connected.
- `project-presence.js` owns the shared markup, identity filtering, avatar stack,
  popup, focus handling and profile styling. Paper and Rebuttal only supply
  location descriptions and navigation callbacks.
- `project-presence.css` owns the geometry in both headers: 28px profile circles,
  4px overlap, and a 44px touch target without enlarging the circle. Both views
  mount the same slot immediately before their shared account controls.
- Do not show an overflow count; additional profiles are available in the same
  popup in either workspace.
- Keep the active response's collaborator avatars beside its editor. The global
  list identifies each person's file or response/round and editing/viewing/away
  state; selecting another person follows their current location.
- Response carets, names and selections use collaborator identity colors and Yjs
  relative positions. They coexist with review-response mapping highlights and
  never change response text, undo history or the local selection.
- A retained hidden editor does not announce an active cursor. Paper and its
  embedded Rebuttal share one connection and one active workspace location.
- The presence list remains keyboard accessible, closes on Escape/outside click,
  and fits narrow screens. Names and locations wrap or truncate inside the panel.
- Pending review imports stay inside Advanced tools; do not place their list
  above the writing workspace.
- Rebuttal's sidebar has no primary Reviews & responses/Submission menu rows. Reviewer entries and the top Rebuttal tab open the writing view; Submission is available in the existing Advanced group with Overview and Evidence.

Concurrent integration: preserve the newly added Paper writing / Reviews & responses project navigation. Manuscript chrome is now a 48px location row plus a 40px project-mode row (88px total; mobile 48+44=92px). Local panel toolbars remain 48px. The project-mode controls use the same selected-pill/focus system; mobile files start below the full chrome. This supersedes single-row header measurements captured earlier.

- Project lists have no separate project/activity/properties heading row. Recent activity shows the actor name and time without a profile avatar or edit verb. Actor/time and venue/page metadata use stable columns across rows, with aligned compact metadata on mobile.

## Follow-up touch verification — 2026-10-26
- Project-mode link height is owned by the shared `--control-height`, including both manuscript and Rebuttal. Page layouts must not re-declare its interaction dimensions.
- Rebuttal screen tabs, round/document selectors, analysis actions, concern actions and navigation consume the same 28px desktop / 44px mobile control height. Navigation rows retain at least 30px on desktop.
- This mobile target enlargement is a Paper Workspace accessibility decision, not a measured Linear dimension. Layout remains scrollable for long reviews and actions.

- Review mode preserves the manuscript frame: a full-width 48px project header and 40px mode row, with section navigation below in the same left sidebar column. Reuse the saved sidebar width and project title when switching; mobile retains the header/modes and uses a 2×2 section-navigation dock.
- Coarse-pointer desktop/tablet mode also uses 44px controls. The shared `--frame-mode-height` drives header padding and chrome height so touch targets remain inside their row at 1024px. The manuscript's `--workspace-top-height` aliases the shared frame height.

## Frame alignment follow-up — 2026-10-26
- Goal remains close app-UI reproduction, not merely consistent colors. The 2026 frame/header crops show continuous dim navigation beside a separate rounded work surface.
- Desktop manuscript now places its mode navigation inside the work-surface column and begins the file rail below its brand row (48px). The surface starts 8px from the viewport top/right and shares the 10px corner token with hub and Rebuttal. Sizes are implementation estimates; the original editorial zoom is unknown.
- Sidebar resize/collapse drives the header surface and mode-row inset through the existing `--sidebar-width` state; collapse uses the established 44px rail. No editor DOM, state, event handler or collaboration protocol is replaced.
- Mobile retains its full-width product navigation. LaTeX/PDF split remains a product-specific layout difference.

- Project mode navigation uses ordinary same-origin navigation without browser document snapshots. Preserve editor state and keep the frame geometry stable; test paint, hit targets and focus on both directions.


## Attached Linear reference audit — 2026-10-26

The user-provided `linear-ui-reference-20.zip` is now the first evidence source. Detailed provenance, all 20 image dimensions/dates, original-pixel sampling coordinates, measured colors, geometry estimates, component state contracts, complete screen mapping and validation limits are recorded in [the attachment audit](docs/paper-platform/linear-reference-2026.md). Earlier “no attachment” notes describe the previous pass only.

- Baseline: the 2026-03-12 design family, 01 RIGHT sidebar and 02 BOTTOM tabs. Dated 04/13/18/19 supplement properties, assistant and inbox components; these are editorial product crops, not authenticated whole-window screenshots. 04/18 are panel compositions.
- Undated 03/05–12/14–17 supply component structure only; the source build is unverified. 20 is 2024 and is excluded from 2026 palette/geometry extraction.
- Original image hashes and dimensions match the manifest for all 20 files. Measured raster colors: 01 nav #080808 and selected row #1b1b1e; 02 surface #0f0f11, selected app tab #1e1f21, inactive tab #131416; 04/18 properties #1c1c1f. These are observed raster samples, not official CSS tokens.
- Keep app-tab selection distinct from ordinary selection: existing #32343a comes from another frame/pill crop and does not match 02's new tab. Typography, CSS heights, sidebar width, light palette and state transitions remain implementation estimates. The 2026 light frame and interactive states lack equivalent source captures.
- Existing functional/data/security/explicit-analysis contracts remain active. Use common shared tokens/components on login, hub, manuscript, Rebuttal, every auxiliary tool, settings and backup flows; product PDF rendering remains unchanged.
- Compare corresponding component crops; control font loading and motion and test 320/390/1024/1600px in both themes. Reference source scale is unknown, so normalized crop comparison must not be described as same-viewport pixel equivalence or a whole-page similarity percentage.

## Attached-reference implementation verification — 2026-10-26
- Current implementation and evidence: `docs/paper-platform/linear-reference-implementation.md`.
- App tabs use `--theme-tab-selected` (#1e1f21 dark) and the shared 7.5px `--radius-tab`; local pills retain their separate selection role. Raised dark panels use the observed #1c1c1f. The CSS radius remains an estimate from the normalized reference contour.
- `project-frame.css` owns writing/review frame geometry; page CSS must not duplicate it. Review navigation uses 16px SVG masks. At narrow mobile widths its four destinations form a 44px 2×2 dock, with content bottom space.
- Login embeds the same `theme.css` plus layout-only `login.css` because assets require authentication; the packaged gate includes both. Authentication now uses the same bundled Inter font through one exact public font path; its observed 44px controls replace the earlier 48px estimate.
- Checkbox/radio/select states, primary pointer-active and text-button busy indicators belong to shared theme rules. Supporting engines style the native select picker with the common menu surface; other engines and forced-colors retain native behavior. Escape on file menus restores opener focus.
- Reference viewport/DPR/zoom are unknown; normalized component crops are diagnostics, not exact-scale or full-page similarity scores. Exact 1:1 acceptance remains unverified.

- Writing/review frame parity is verified at 1600, 1024, 390 and 320px, including both desktop sidebar states: header, brand, title, mode row and main/rail boundaries must agree within 1px.

## Frame ownership and selection accessibility — 2026-10-26
- `project-frame.css` owns the header surface, project-mode position, sidebar inset, collapsed rail and mobile frame. Legacy duplicate frame definitions have been removed from `ux.css`; manuscript-specific tools and panel arrangements stay there.
- The selection composer uses common inputs and primary buttons. Its hidden initial actions leave the keyboard order. Math and code previews consume theme text/surface tokens; rendered PDF content does not.
- Mobile notifications reserve space above the active selection composer, including their enter/exit translation; they must not obscure the input or its send/close controls.
- Evidence and reproduction: `docs/paper-platform/linear-goal-validation.md`, `tests/accessibility-contract.spec.js`, `tests/project-frame-parity.spec.js` under the collaboration app, and the selection-control capture script.

## Rebuttal writing flow — 2026-10-26
- Approved flow: import reviews → choose a reviewer → write a response → explicitly run “Check response”. Keep the shared manuscript frame, collaboration and autosave.
- One check runs concern extraction when needed, response mapping/sufficiency, wording and consistency in sequence. Editing never starts or repeats an LLM call; dependent results become outdated. Expose progress, failures and cancellation without requiring users to understand job types.
- Selecting a concern highlights its exact original and response passages and draws their connection. Default to the selected concern; “Show all connections” is optional. Preserve source quotes and accessible click/keyboard explanations when lines cannot be drawn.
- A related passage is distinct from an adequate answer. Show addressed/partial/missing/uncertain, reason and missing requirements separately from connection presence and human confirmation. Authors can confirm, reject or manually correct a mapping.
- Secondary tools preserve existing rules, evidence, work, import recovery and submission behavior. No new model requests on navigation, language changes, reload or typing.

- Rebuttal review language is selected once beside the Review panel title with compact neutral Original / Korean buttons, switching every review section together. Field-level translation edit links are removed; a single bulk translation editor lives in Advanced. Missing translations retain labeled original text and offer one explicit whole-review translation action. Pending import recovery lives in Advanced and at the end of Overview, never above the writing toolbar.


## Component precision contract — 2026-10-26

Latest evidence: [component precision report](docs/paper-platform/linear-precision-2026-10-26.md). This supersedes earlier presentation estimates where they differ, while preserving the functional contracts above.

- Observed dark roles: overlay #1c1d1f differs from raised properties #1c1c1f; primary fill #5e6ad3 and border #6d78e7; control fill #2a2c33 and border #393b42. Light menu text #1b1b1b, border #dcdcdc and selected row #f2f2f2 are separate from general body text. Floating selection toolbar border #d6d6d6 and icon #5d5d5f are independent roles. These are raster samples, not official Linear tokens.
- Desktop controls are 28px. App-tab radius is 7.5px from normalized silhouette comparison; select text is 14px, shared chevron is a 16px SVG. Boolean switches use 26×16px tracks and 12px thumbs. Geometry and font matching remain estimates because source viewport/DPR/zoom are unknown. Ordinary multiselect checkboxes keep square semantics.
- Common quiet controls share hover, pressed, selected and selected-hover rules; overlay-local hover uses its menu surface. Primary hover/pressed preserve readable contrast. Buttons expose loading and disabled states without changing action contracts. Codex send is intrinsic width and right aligned.
- Supporting engines use native customizable select pickers, with explicit selectedcontent clipping and scoped updates after option mutations/input/change. Future code setting a select value programmatically must preserve the native selected content or dispatch change. Unsupported engines and forced-colors use native fallback.
- Shared theme rules own menus, dialogs, tooltip colors, checkboxes/radios/switches and motion. Reduced-motion sets transition/animation duration to zero; page CSS must not reintroduce color transitions. Touch targets remain 44px and login targets 44px.
- Precision evidence covers 21 dark and 7 light role/state RGB samples, normalized component crops and real interaction checks. It is not a whole-page similarity percentage or proof of an unseen same-version light app frame.

## Public-demo frame refinement — 2026-10-27

- The public `https://linear.app/demo/my-issues/assigned` shell was rendered in both themes at 1600×1000 CSS px, DPR 1, scale 1, loaded fonts and reduced motion. Unmodified public CDN assets were transported in validated HTTP byte ranges after full-file transport failed. No account session, issue mutation or simulated Linear API was used. The initial demo remained in setup; the reproduced light view had an empty content area and the dark view still showed setup. Neither is an issue-list reference.
- Direct measurements: navigation row 28px, selected-row radius 8px, actual label 13px/500; work-surface inset 8px and corner 12px; location header 44px inside the inset. The demo's outer sidebar is 244px; its internal spacing cause is unverified. The attachment's sidebar remains the primary visual baseline and Paper keeps its resizable 224px default and saved widths.
- Attachment 01's selected row is 112 raster px high. A 28px row corresponds to a diagnostic 4× normalization, not proof of its original DPR/zoom. Attachment colors and selected app-tab treatment retain priority over the live demo's differing palette. The public build cannot be proven identical to the March build; its measured geometry refines previously estimated geometry only and is not relabelled as an official token or exact March-build value.
- Shared navigation consumes `--nav-row-height` (28px desktop / 44px touch), with 18px text line height and 1px gaps between navigation rows. The main frame consumes a 12px corner. The desktop location row occupies 8px inset + 44px header, positioning its content center at y=30px; Paper's separate 40px writing/review row remains below it. Mobile retains its existing 48px location + 44px mode rows.
- `theme.css` owns the shared dimensions; `project-frame.css` owns the location offset, sidebar start and writing/review alignment. Content toolbars, PDF appearance, saved panel sizes and product-specific screens retain their functional space. Evidence and limits are recorded in `docs/paper-platform/linear-live-frame-2026-10-27.md`.


## Deployment usability review — 2026-10-27
- Preserve keyboard focus on the replacement control after Rebuttal rerenders (connection switch, concern selection, reviewer/document selection and screen navigation). Editor selection/undo remain owned by the existing editor.
- Pending imports are unfinished user work: when any exist, show their count and resume action above the review workspace even while Advanced is collapsed. Other advanced tools remain secondary.
- Overflowing assistant tabs expose labeled previous/next scroll buttons plus a thin scrollbar so pointer users can discover Tasks. Buttons hide when all tabs fit; tab-size observation handles delayed font/translation updates. Keyboard users retain the existing single tab stop and arrow/Home/End navigation.
- Deployment and sanitized usage evidence: `docs/paper-platform/deployment-usability-2026-10-27.md`. Real paper screenshots and credentials remain in the private deployment release directory.

- The subsequent read-only New issue dialog capture confirms a different live variant: 28px primary buttons use 12px text and fully rounded corners, unlike attachment 05. Preserve the attachment hierarchy rather than importing that variant into the shared controls. Both actual dialog captures and their DOM measurements are retained in the live-frame report.

## Component reconstruction contract — 2026-10-27

The user's latest correction supersedes the earlier cosmetic-only execution approach. Preserve functional state, not previous component composition. Main reference family and colors above remain active.

| Linear component / reference | Paper function and composition |
| --- | --- |
| Sidebar / 01 new sidebar | Preserve the current Folio brand as a direct authorized project-hub link. Project navigation remains in the real catalog/sidebar; do not restore the earlier workspace popup over the newer user change. |
| Location + view bars / 2026 header | Location/title in the first row, product modes and contextual actions in the local bar. Account preferences belong to the rail footer; source/PDF controls belong to their panels. |
| Property value menu / 04, 07, 18 | Compact value trigger + searchable grouped option popover; native select remains the real data/form backing. Keyboard/disabled/focus/empty states are required. |
| Document agent / 13 | Context hint, scrollable conversation/result area and a bottom-anchored composer with inline model picker and explicit send. Preserve request histories, review-before-apply and cancellation. |
| Activity/comments / 14 | Author/avatar metadata, quoted source anchor, readable message, quiet resolve action and bottom composer. Real comments retain navigation and shared IDs. |
| Projects list / 15 | Contextual toolbar, list columns and metadata rows. No large landing-page introduction or decorative gallery cards. |
| Review issue/detail + properties / 04, 18 | Reviewer list, original/response document panes and grouped concern/property/activity rows; keep explicit check/import/rules/submission flows. |
| Preferences / 17 | Section navigation, grouped setting rows with descriptions and trailing value/switch controls; existing profile/theme dialogs retain their true controls and accessible names. |

`theme.css` owns reusable workspace picker, property trigger/menu, setting rows and overlay primitives. `bootstrap.js` wires those controls without backend/API changes. `project-frame.css` owns shared frame geometry/account placement. Writing, hub and review styles own only their domain composition. Use actual DOM and semantic controls, preserve existing handler IDs, and remove replaced style rules instead of piling contradictory overrides on them.

Acceptance requires visible structural change on each corresponding surface, real pointer/keyboard interactions, full current functional regression, four widths/both languages/themes, actual captured before/after and a component-correspondence verdict. Screenshot color samples and test counts alone do not establish completion. Login remains product-specific authentication; do not import authenticated workspace chrome into its form.


Component reconstruction evidence: [implementation and before/after report](docs/paper-platform/linear-components-rebuild-2026-10-27.md). The current 244px default rail uses the existing user-adjustable layout state; saved user widths are retained. Initial and follow-up agent composers stay outside the scrolling stream. New context actions use 44px touch targets. Workspace/project menus and property menus are functional, retain native backing and form events, clean up replaced nodes, and restore original native access in forced colors. The account rail and skip link remain reachable across collapsed/mobile states.

## Folio identity — 2026-10-27
- The approved Folio mark is used on login, the hub, manuscript and Rebuttal. The SVG light and dark variants follow the selected application theme, including manual overrides.
- Browser favicon, Apple touch icon, installed-app manifest and the share preview use the same mark; original character artwork remains available as illustration.
- `assets/paper-folio-{light,dark}.svg` are the canonical symbol assets; corresponding wordmark SVGs have outlined text. Rebuild raster assets with `node scripts/paper_platform/generate_brand_assets.mjs`.


## Remaining-screen reference implementation — 2026-10-27

Evidence and final deployment: [remaining-screen report](docs/paper-platform/linear-remaining-2026-10-27.md). These rules supersede earlier login/system-font/default-rail estimates.

- Authentication has its own observed roles from the actual public Linear login/email flow, captured in both themes at DPR 1. App screenshot tokens retain priority inside the app; authentication's pill button must not replace every app button. Its flat page is 288px wide, logo48px, logo/title gap32px, title18px/500, title/form gap24px, controls44px separated by16px, input radius10px and pill CTA. Placement is 48px top padding plus `max(0px,50svh - 240px)`. Light background #f8f8f9; dark gradient #111212 at0% to #09090a at50%.
- Login uses the existing bundled Inter asset. Caddy's authentication profiles expose only `/assets/inter-variable.woff2` alongside the existing public brand paths. Manuscripts, APIs and catalogs remain protected. Username/password POST fields, rate limiting, sessions and roles retain their contracts; no Google/SSO/passkey dummy actions are added. Paper's two-field account login and logo are explicit product differences. Readable placeholders and2px keyboard focus are deliberate accessibility differences from the source.
- The default rail is244px, measured in the public app. Existing stored user widths remain authoritative. Hub navigation, local toolbars, project groups and property menus share the same primitives. Source issue rows are44px; Paper's title/description and project metadata use56px rows, with wrapping at mobile widths.
- Appearance is one real setting row with a native select enhanced by the shared property menu; original theme values/system behavior/storage are preserved. Profile uses the same label/description/control group. Attachment17 supplies its measured dark settings surfaces; the authenticated Linear Profile page was not observed.
- Shared property menus preserve native select values/events/FormData/reset, use their owning dialog as portal, restore focus and dispose removed controls. Forced-colors and unsupported popover engines keep native controls. Project switching reads the authorized catalog and preserves project identity/language.
- Native file selector buttons, checkpoint/task fields and search controls use the28px/44px control token. Backup utility groups use neutral secondary emphasis, model labels expose hover/selected/focus, and source/PDF/comment highlights use shared accent roles. PDF document pixels and editor/Yjs state remain owned by their existing implementations.
- Current public app captures and undated document/attachment images have separate provenance. Same-build equality of every screen is not established. Observed property comparisons are not whole-page similarity percentages.


## Live component comparison — 2026-10-27

Evidence: [deployed comparison and final verification](docs/paper-platform/linear-live-comparison-2026-10-27.md). Attachment 01 RIGHT / 02 BOTTOM remains the primary 2026 family; 07 menus, 13 agent, 14 activity and 17 preferences supply component structure. Current Folio identity, direct brand navigation, bookmark mode tabs, review iframe/Markdown preview and connection controls are preserved.

- Overflowing assistant tools reserve both scroll controls, disable the endpoint control, and reveal the full selected label after programmatic selection, resize, font loading and locale changes. Manual scrolling and existing keyboard navigation retain their behavior. Both controls hide when the entire strip fits.
- Backup history uses flat connected activity rows with the full-width title, metadata and quiet Compare/Restore utilities in reading order. Long titles wrap; individual rows have no decorative card outline. Preserve visible labels, keyboard focus, 28px desktop / 44px touch targets, real compare/restore handlers and author/version text.
- A file-menu separator appears only when its following rename/delete action group is visible. Protected manuscript/root menus must not end in a separator.
- Backup headings, status and action labels follow the selected language. Translate the system reason before the actor suffix; preserve actor and user version names.
- This bounded comparison passes its qualitative component review and live 16-combination checks; it does not establish whole-page pixel identity or equivalence to an unseen same-build Linear screen.


## Regression refinements — 2026-10-27

Evidence: [full regression and fixes](docs/paper-platform/full-regression-2026-10-27.md).

- Bookmark mode links consume the 44px touch control token and stay within their header row; the desktop bookmark shape is retained.
- Mobile review navigation uses a compact horizontal row for reviewer and common-response controls. Each target is at least 44px. Selected items reveal their full label after navigation, rendering, resize and font loading. Reserve space above the bottom navigation for the workspace content.
- Retained Paper/Rebuttal views follow the active view's selected language on a round trip. Keep editor selection and draft state.
- Modal close restores focus to the original control or its current replacement after rendering, including native Escape and file selection.
- Pending review imports retain their visible resume entry while advanced tools are collapsed. Bulk review translation editing belongs to the advanced Review group; all AI work still requires an explicit action.


## Shared workspace controls — 2026-10-28

Paper and Rebuttal share the same account controls, profile form and appearance form in `sidebar-account.js`. The profile controller owns validation, persistence, avatar rendering and storage/focus synchronization; callers supply collaboration and save callbacks. `theme.js` owns appearance selection, theme application and translated labels on both screens. Retain the existing required-name onboarding in Paper.

`bootstrap.js` owns modal focus restoration and disclosure-menu dismissal. Mobile utilities and the Rebuttal Advanced menu close on outside interaction and Escape, and return focus to their visible summary after an action opens a modal. Property menus retain their own keyboard behavior inside modal boundaries. Domain forms and status details retain their content and actions.

`theme.css` owns shared controls, account buttons, utility menus and settings appearance; `project-frame.css` owns placement and responsive arrangement. Rebuttal form-specific rules are scoped to `#form-dialog` and never restyle the shared settings dialogs. Use 28px desktop and 44px touch targets and equal type, padding and spacing across Paper, embedded Rebuttal and standalone Rebuttal. Remove obsolete screen-specific rules when moving ownership.

Acceptance: profile save/cancel/validation, theme picker Escape followed by modal Escape, mobile menu dismissal and focus restoration, language/theme/profile synchronization across the preloaded screens, and measured control/dialog parity at 1600, 390 and 320px in both themes and languages. Preserve document text, editor state and existing service data.

Verification and deployment evidence: [shared controls report](docs/paper-platform/shared-controls-deployment-2026-10-28.md).


## Remaining common workspace elements — 2026-10-28

The follow-up audit found remaining differences in sidebar collapse icons, document panel headers, separator feedback, status details, and response-local collaborator avatars. Reuse the existing shared layers; do not add a second UI framework.

- `PaperUI.updateSidebarToggle` owns the same SVG, direction, translated name and expanded state. Each workspace still supplies its own sidebar content and saved layout adapter.
- `theme.css` owns document header type, spacing and 48px minimum desktop / 52px minimum touch height. Wrapped actions can increase height; filenames, PDF controls and response tools keep their own composition.
- `PaperUI.bindResizer` owns pointer capture, dragging/cancellation and keyboard navigation. Each caller supplies bounds, units and persistence. Home/End set the current divider to its minimum/maximum; the explicit layout reset button retains the global reset. Resizing must preserve unrelated layout preferences and document state.
- Both status buttons open the shared anchored status popover and retain the same Escape/outside-click/focus behavior. Paper retains compile/backup/reconnect actions; Rebuttal retains current source and preserved-file details, updating them while open.
- Response-local collaborators reuse `PaperProjectPresence` with a response scope and separate element IDs. Preserve the selected-document filter, exclusion of all own tabs, Unicode initials, 28px circles/4px overlap and 44px touch target. Shared positioning keeps both header and response menus within the viewport and above clipped panels.
- Persistent inline review notices and transient Paper toasts serve different purposes and retain their placement and lifetime. Source, PDF, review and response content retain their domain layouts.

Acceptance includes actual keyboard/drag behavior, storage synchronization without unrelated preference resets, status close/reopen races and current conflict paths, shared styles at desktop/mobile widths, and response peer filtering/following without editing content.

Audit and deployment evidence: [remaining shared shell report](docs/paper-platform/shared-shell-deployment-2026-10-28.md).

## Sidebar transition refinement · 2026-11-11
- Keep the original live content fully opaque throughout a 220ms local transition. Do not capture or crossfade old/new screens. Apply the final content layout once and animate element positions without scaling text or PDF pages; only the empty header background may scale.
- The fixed navigation column may interpolate its own width without resizing the manuscript/review content every frame. Keep the moving content visible outside its final container bounds until it reaches its destination.
- Keep the outer frame edge aligned and viewport-fixed notes stationary. Do not apply transforms to live content ancestors.
- Retain source selection and PDF reading position. Repeated clicks reverse immediately from the current visual position; newer external layout settings cancel local movement.
- Reduced motion, mobile and browsers without element animations apply layout immediately. App-tab navigation remains unchanged.

- OpenReview response preview shows only the rendered response; Korean translation/connection status remains in the editing surface and never appears above preview content. Returning to editing restores its current status without changing the draft.

- Completed Korean response translations replace pre-existing Korean content without a confirmation dialog. Retain in-flight source/glossary validation and concurrent-edit compare-and-swap checks.
