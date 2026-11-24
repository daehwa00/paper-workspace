# Property picker integration contract — 2026-10-27

Observed before patch (`before.json`, `before-modal.png`): a picker trigger inside an actual `showModal()` dialog created its popover under BODY. The menu remained outside the modal's inert boundary: focus stayed on the trigger and an ordinary pointer click on the Beta option timed out. On the hub sort picker, ArrowUp from the search field focused the penultimate Name row instead of the final row.

Scoped integration changes to `static/bootstrap.js`:
- Popup host is the trigger's nearest dialog, or BODY when there is no dialog. Closing the owner hides the popup; disposal removes the owner's close listener.
- Reused the concurrent change's native forced-colors and active-property lifecycle mechanisms. Native tabindex and aria-hidden now restore their original attributes, entering forced colors closes the custom menu and moves focus to the native select, and leaving moves focus back to the enhanced trigger when needed.
- Removed controls disconnect their select MutationObserver, media-query listener, input/change/reset listeners, remove their popup, delete their WeakMap entry and restore native attributes. Removal does not reinsert a removed select. A subsequently reused native select can be enhanced again.
- Explicit and implicit label clicks open the displayed trigger rather than focusing the visually hidden select. Label names exclude the wrapped control text.
- ArrowUp from search focuses the last enabled property option. The separately authorized identical workspace-menu calculation is corrected too.
- Existing select values/options, option-group disabled state, bubbled native input/change, FormData and reset semantics are retained. Open menus update after option changes. Disabled controls close their menu.
- Popover capability is detected before enhancement; unsupported engines retain the original selects and workspace links. No DOM prototype is patched.

`theme.css` change is confined to the property native forced-colors block: use CanvasText and Canvas for the restored system control.

Validation from `tests/property-picker-contract.spec.js`:
- Modal selection in light/dark at 320px and 1600px: 4 passed (4.0s). Actual clicks and keyboard selection change native.value, emit exactly one input/change pair each, preserve FormData/reset, disabled/options behavior, implicit/explicit labels, Escape focus return and dialog closure. JavaScript page errors and LLM requests: 0 in all four cases.
- Forced-colors transition, initial forced-colors access, and five modal rerenders including stale-menu disposal and native select reuse: 3 passed in the initial scoped run. That run's four other failures were a strict test locator resolving both the label text span and wrapper span; only the selector was corrected and the affected four tests rerun.
- Workspace search ArrowUp -> last project, ArrowDown -> first project, Escape -> trigger focus: 1 passed (1.3s) after its final one-line runtime patch.
- Changed JavaScript syntax and changed-file `git diff --check`: passed.

Visual evidence: `modal-{light,dark}-{320,1600}.png` are browser captures of the shared real component inside a small contract fixture modal on the running app. `forced-colors-native.png` shows the actual browser-native picker. This is component and interaction evidence, not a production page design-parity screenshot. `lifecycle.json` retains all five iteration results.

Limits: Chromium supplies popovers in this environment. Attempts to disable the feature with Chromium flags left the API available, so the unsupported-engine capability branch was reviewed but not exercised on a genuinely unsupported engine. No production deployment or external LLM request was performed by this worker. Runtime files were frozen for the parent's integrated snapshot after the final workspace scenario.
