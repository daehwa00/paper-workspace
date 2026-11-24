# Calendar today underline — 2026-11-13

Replaced today's circular outline with a short 10×2px underline in both the sidebar and expanded calendars. Background decoration preserves numeral geometry, deadline markers and hit targets. The line uses currentColor to follow selected-date and theme contrast. Retained aria-current semantics.

Validation: 54 existing calendar and expanded-calendar checks passed across Chromium, Firefox and WebKit against the exact release assets. Authenticated production interaction was not exercised. Runtime verification records health, all static asset hashes and ingress behavior.

Evidence: `/home/qlab/daehwa/paper-workspace/.omx/artifacts/today-underline-20261113-_qf2cmlc`
Release: `/home/qlab/.local/state/paper-workspace/releases/20261113-today-underline-lxdw62zv`
Rollback: `/home/qlab/.local/state/paper-workspace/releases/20261113-today-underline-lxdw62zv/runtime-previous/runtime.compose.json`
