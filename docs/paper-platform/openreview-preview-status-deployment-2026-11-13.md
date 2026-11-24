# OpenReview preview status isolation — 2026-11-13

Hide the Korean editing surface while response preview is active, both during initial mount and when toggling. Translation/connection status stays available in editing mode; preview contains only rendered response content. Draft text, translation and connection validation remain unchanged.

Validation: 12 relevant cases passed across Chromium, Firefox and WebKit (nine existing Markdown/math/draft checks plus three updated Korean connection/preview checks). Returning to editing restores the alignment status and preserves changed Korean text. Initial added assertion incorrectly expected Markdown table trailing text to render; corrected it to assert actual rendered table content and preserved raw text separately. Authenticated production interaction was not exercised.

Evidence: `/home/qlab/daehwa/paper-workspace/.omx/artifacts/preview-clean-20261113-m6nx38tb`
Release: `/home/qlab/.local/state/paper-workspace/releases/20261113-preview-clean-pf25nhg2`
Rollback: `/home/qlab/.local/state/paper-workspace/releases/20261113-preview-clean-pf25nhg2/runtime-previous/runtime.compose.json`
