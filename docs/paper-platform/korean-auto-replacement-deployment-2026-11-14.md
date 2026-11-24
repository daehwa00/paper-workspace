# Korean translation automatic replacement — 2026-11-14

Completed response translations now apply without the existing-Korean comparison dialog, including manually edited or metadata-free Korean text present before translation. Retain source/glossary checks, concurrent-edit checks and atomic expected-value replacement. When the initiated translation becomes stale during processing, force the latest source/glossary refresh so existing Korean without translation metadata does not prevent completion.

Validation: 30 translation lifecycle checks passed in Chromium, Firefox and WebKit against the final image assets. Covers metadata-free existing Korean replacement without a dialog, glossary changes mid-flight, English changes, progress, retry failures, cross-reviewer results and another-tab completion. Initial broader run also exercised the long Korean UI workflow: Chromium/Firefox passed, WebKit timed out at an unrelated export download before reaching replacement. No authenticated production interaction was exercised.

Evidence: `/home/qlab/daehwa/paper-workspace/.omx/artifacts/ko-auto-20261114-_2cmr0np`
Release: `/home/qlab/.local/state/paper-workspace/releases/20261114-ko-auto-qoo6rnis`
Rollback: `/home/qlab/.local/state/paper-workspace/releases/20261114-ko-auto-qoo6rnis/runtime-previous/runtime.compose.json`
