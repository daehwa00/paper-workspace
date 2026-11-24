# Component reconstruction cleanup

Scope: only reconstruction edits against `before-source`; existing auth, persistence, compiler, review behavior and reference tokens are excluded. Work alone and preserve concurrent edits.

Behavior lock: supplied component composition 6 passing, result actions 4 passing, header 5 passing; worker review logs retained. No new tests required for this structural pass.

Plan (before edits):
1. Remove demonstrably unused bindings in tests changed for the new component structure.
2. Inspect current-session CSS for exact redundancies; preserve cascade-sensitive rules.
3. Expand the shared property picker keyboard index selection from nested ternaries into explicit branches, preserving every existing index result and key behavior. Avoid changing unrelated compact legacy code.
4. Run syntax/diff checks and only focused affected browser tests against port 18340. Main owns final full-suite verification.

Fallback inventory:
- Popover API capability guard: grounded browser compatibility boundary; retains native controls when unavailable. Preserve.
- Forced-colors native control restoration: grounded accessibility boundary; preserves original tabindex/aria-hidden and native semantics, covered by reviewer tests. Preserve.
- Project catalog fetch failure: visible error plus explicit retry, not silent failure. Preserve existing fetch boundary; empty successful catalog is valid.
- Empty property search/project search: explicit empty states, not masking fallback. Preserve.
- Selected option label fallback: placeholder for genuinely empty selection. Preserve.
- Auth/storage/watchdog fallbacks: outside assigned scope and untouched.
No ambiguous architectural fallback requiring escalation found.

Visual constraints: dense typography, flat surfaces and existing palette are deliberate reference decisions. No token or layout redesign during cleanup.

## Result

- `static/bootstrap.js`: replaced the new property picker keyboard handler's nested ternary with explicit Home, End, initial focus and wrapped arrow-navigation branches. No event, ordering, focus target, return value or source select behavior changed.
- `collaboration/tests/interface-polish.spec.js`: removed an unused border-color binding and its temporary DOM probe after the component assertions moved to the composer surface. Existing assertions remain unchanged.
- Other assigned markup, styles, render markup, translations and tests were inspected against the reconstruction baseline. No safe high-signal simplification justified touching them; cascade-dependent selectors, intentional structural wrappers and native accessibility paths were preserved.
- No added abstractions, dependencies, source features, tests or documentation.

Verification after final edit:
- `node --check` on both changed JavaScript files: passed, no syntax errors.
- `git diff --check`: passed, no whitespace errors.
- Focused Playwright against `http://127.0.0.1:18340`: 2 passed (searchable property menu updates native sort and restores focus; dark composer/header surface assertions), `/tmp/component-cleanup.log`.
- Exhaustive comparison of actual new keyboard index block against original expression: 360 cases passed (1–12 enabled rows, absent/each current focus position, all 4 handled keys).
- No new errors. This pass does not claim full-suite verification; main owns the final suite.

Stop condition: assigned changed code inspected, exact behavior retained, focused checks green, no further meaningful safe cleanup found. No fallback escalations or new risks.
