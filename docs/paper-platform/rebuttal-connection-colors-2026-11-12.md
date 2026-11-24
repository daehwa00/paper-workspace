# Rebuttal connection highlight colors — 2026-11-12

Korean paragraph alignment can place several response mappings on the same text. Each mapping retains its own DOM wrapper for edge anchors, tooltips and keyboard access. Previously the wrappers used translucent backgrounds, so nested highlights accumulated opacity and mixed hues, unlike the single review highlight.

Review and response highlight rules now blend the connection color with the opaque theme surface, preserving the existing 19% / 9% light and 38% / 23% dark strengths. Nested mapping backgrounds no longer accumulate. Mapping identity, alignment and response content are unchanged.

Regression: the duplicate-mapping Korean workflow checks both source and OpenReview views in light and dark themes, equal review/response backgrounds, opaque paint, and focus for both mappings. The regression fails before the fix (alpha 48 instead of 255). Existing connection hover/focus and translated table-row checks also pass.

Production overlay changes only rebuttal.css and the rebuttal.html CSS cache hash. Release: `/home/qlab/.local/state/paper-workspace/releases/20261112-connection-tint-g91yyq_z`.
