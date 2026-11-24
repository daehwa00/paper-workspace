# Expanded calendar wheel navigation — 2026-11-13

Vertical wheel input on a fitting expanded month grid moves to the previous/next month. Accumulate a 40px threshold and lock until 240ms without events to prevent trackpad momentum skipping months. Preserve native scrolling in overflowing grid/layouts, conference detail scrolling, horizontal gestures and pinch zoom. Existing shared month navigation retains selected conference details.

Adjacent-month numerals use 55% of the faint token blended with the surface in both calendars. Selected dates retain full inverse contrast. Today underline is preserved.

Validation: 60 checks across Chromium, Firefox and WebKit against exact release static files, including gesture accumulation, momentum lock, reverse direction, pinch zoom, retained details and native scrolling in a short viewport. Authenticated production interaction was not exercised.

Evidence: `/home/qlab/daehwa/paper-workspace/.omx/artifacts/calendar-scroll-20261113-dwomqofx`
Release: `/home/qlab/.local/state/paper-workspace/releases/20261113-calendar-scroll-v2hkh7wn`
Rollback: `/home/qlab/.local/state/paper-workspace/releases/20261113-calendar-scroll-v2hkh7wn/runtime-previous/runtime.compose.json`

Firefox included the weekday header in percentage row sizing, causing a 30px overflow even in a full-height grid. Row sizing now reserves the 30px weekday header before distributing the six weeks; verified full-height and short/narrow layouts.
