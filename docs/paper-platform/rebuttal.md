# Rebuttal workspace

Each project can maintain rounds containing original reviews, Korean translations,
atomic concerns, optional common responses, reviewer responses, grounded mappings,
evidence, work items, versioned conference rules and frozen submission outputs.
The implementation interfaces are specified in [rebuttal-contract.md](rebuttal-contract.md).

## Enable and verify

Set `REBUTTAL_ENABLED=true` in the private deployment environment. For a pilot, set
`REBUTTAL_PROJECTS=example-paper,default`; an empty project filter enables the
feature for all runtime-registered projects. Existing project membership still
applies. Build the complete stack with the same authentication overlays already
used by the deployment, then smoke-test `/p/example-paper/rebuttal` before
enabling additional projects. The feature defaults to disabled.

The rebuttal service listens only on an internal container network. It keeps its
SQLite database in `rebuttal_data`, reads the staged project allowlist, calls the
existing isolated compiler and authenticated Codex bridge, and accesses the
OpenReview API for explicit imports. No source-library write mount is added.

## Workflow

1. Create a round and import reviews by pasting text, uploading TXT/Markdown/JSON
   or a text PDF, or connecting to OpenReview with a paper URL/forum ID.
2. Check reviewer names, fields and extracted pages before committing. Empty
   scanned PDFs require manual text; OCR is not part of this release.
   Printed OpenReview pages are organized by reviewer and named sections before
   confirmation. AI reviews and administrative comments are optional and unchecked
   by default. Refreshing does not lose a staged import: use **Advanced →
   Pending imports → Review import** to resume it. Pending sources do not occupy
   the top of the writing workspace. Review translation and analysis use their
   explicit actions; uploading alone never starts a model request.
3. Select a reviewer in the left rail (or the reviewer selector on mobile). Read
   the original review beside the response editor; **Start response** creates a
   reviewer document if needed. Choose **Original / Korean** beside the Review panel title
   to switch every section together. Missing translations offer an explicit
   whole-review translation action; bulk corrections live in Advanced.
   Common responses are optional. Text edits save
   automatically and synchronize through Yjs in the existing project room.
   Other authors' active cursors and selected passages appear in their identity
   colors. The upper-right people list includes this paper's Paper and Rebuttal
   users, including authors working in another response or round. Select a person
   to follow their location. Hidden tabs are marked away and do not display an
   editing cursor; the embedded Paper/Rebuttal views share one presence entry.
4. Choose **Review–response connections** to analyze the selected reviewer's
   review and active response. Wording and consistency checks are separate
   Advanced actions. Confirmed or rejected connections survive reruns; partial
   or uncertain results preserve earlier connections. Select a concern to highlight its original/response
   passages and show the connection with coverage, reason and missing requirements.
   **Show all connections** is optional. Confirm/reject model suggestions; use
   **Advanced** for manual passage corrections, split/merge and individual jobs.
5. Link claims to the submitted paper, revised paper or experiment results; track
   promised revisions as assigned work. Human confirmation is separate from the
   model's coverage assessment.
6. Enter conference rules or request research. Review the source/year/conflicts
   and apply a version. New research never replaces active rules automatically.
7. Assemble the target submission, check exact emitted text and compiled PDF,
   then freeze/export. The submission output excludes internal review analysis.

Review and connection analyses run only through their explicit actions. In the
response's Korean view, a missing or outdated translation starts automatically.
Translation reuses unchanged paragraphs and shows completed paragraphs first.
Old analysis results require review when their input changes, and repeated
analysis preserves author decisions. Simulated reviewer questions remain
separate from actual reviewer concerns and progress denominators.

Exports and frozen submissions require initialized shared response text. Korean
exports must match the current English and glossary; drafts without translation
provenance require explicit confirmation. Freezing captures the selected document
order, text and rules; changes while its confirmation dialog is open require
reviewing the submission again. Total limits still validate every response even
when only a subset is exported. Backups also require collaboration synchronization
and never substitute initial seed text for missing shared content.

## Rules and budgets

Rules belong to a conference/year/track/stage and are pinned to a round. Limits
can apply to individual documents, assembled targets or the total submission.
Codepoint characters including spaces/newlines are the default; other counting
conventions must be chosen explicitly. An unknown limit is unconfirmed, not a
default 2500-character allowance. Common content is counted wherever it is
actually emitted. Deadline displays preserve the original timezone.

Semantic constraints such as anonymity, permitted experiments and AI-use rules
remain visible checks; a model assessment is not a conference compliance
guarantee. Rule sources and the applied actor/time remain part of the archive.

## OpenReview connection

Connections are personal and session-bound. Passwords are transient, and tokens
are kept in server memory for at most one hour. Disconnect or sign out to clear
the connection. Tokens are never placed in browser storage, Yjs, exported data,
backups or model context. Supported OTP challenges are completed in the UI;
accounts that cannot connect can use PDF or exported review files instead.
Authenticated note retrieval uses the official Python SDK. Public retrieval uses
a bounded REST adapter to avoid ambient SDK credential discovery. Review import
is read-only; the service does not submit replies to OpenReview.

## PDF output

The compiler contains Pandoc and Poppler. Markdown is converted inside a bounded,
networkless temporary workspace and then compiled with the existing restricted
TeX toolchain. A user-supplied LaTeX template must put `%%REBUTTAL_BODY%%` in its
entrypoint where the response body belongs. Register all required styles and
passive assets. Arbitrary executable filters are not accepted. The neutral
default layout is an editing convenience, not a venue author kit.

## Recovery and operations

### Editing responses on the server

After a response has been opened by an editor, its server file is
`rebuttal/responses/<text_key>.md` relative to the same source project directory
used by Paper (`PAPER_PROJECT_DIR`, or the project's directory in
`PAPER_PROJECTS_DIR`). The connection-status dialog shows the selected response's
exact file path. Edit that UTF-8 Markdown file to work without the browser; do not
edit a downloaded export, SQLite seed text, version-history rows or LevelDB files
as a substitute for the live response.

While a project room is open, server file changes are checked every second
(`COLLAB_REBUTTAL_SOURCE_POLL_MS`). With all browsers closed, the file remains on
disk and is reconciled when the project is next opened. Web changes are written
back to this file. No manuscript text or project manifest entries are changed.

Independent web/server edits are merged against the last common version. When
the edits overlap, both full originals are saved under `rebuttal/conflicts/`
before the server version is displayed. The response shows a persistent notice
with both file locations; compare the saved originals and combine the intended
changes in the response file or editor. Preserved files are not automatically
deleted. Deleting a response file reports a missing file and keeps the web draft;
restore the file to resume synchronization. Keep `rebuttal/.sync/` with the source
folder: it contains the recovery baseline, not an editable response.

Recent common versions are retained so a server editor saving an older buffer
does not silently erase a newer web writeback. Ambiguous bases are treated as
conflicts. Before importing a server change into the shared response, the current
web text is also preserved in a content-addressed file under
`rebuttal/.sync/history/`; the connection-status dialog shows its recovery path.
These recovery files are not automatically pruned, including when a server
buffer is older than the recent merge history.

File writes use temporary files, fsync and a final content-hash check. As with
Paper, unrelated external writers do not participate in a shared file lock; use
atomic saves and avoid simultaneous processes overwriting the same file during
its replacement. A browser whose collaboration connection is offline retains
its existing shared draft and reconciles it after reconnecting. A brand-new
response waits for the server to allocate its shared text before editing starts.

Review metadata (translations, concerns, tasks and rules) is updated through the
revision-checked rebuttal API, including from server-side tooling. Direct SQL or
database-file replacement bypasses these checks and is not a supported editing
path. Forms preserve other authors' changes; if both authors changed the same
field, saving stops and the current form stays available for comparison.

Deploy the collaboration service and browser assets together, and reload old
browser tabs so they use server allocation. Include the project's `rebuttal/`
directory in operational backups alongside the data volumes below; it includes
server response files, preserved conflicts and synchronization baselines.

Project snapshots include rebuttal metadata and current Yjs response text.
Restoring creates new rounds and response IDs, preserving the active work.
Snapshots from before this feature do not clear existing rebuttal data. Preserve
the existing asset store alongside snapshots, including immutable imported PDFs.
Operational recovery must also copy `rebuttal_data` and the collaboration volume;
the database and asset references are different parts of the recovery set.

The worker persists queued jobs, stage progress, input versions and validated
results. An interrupted running job is shown as interrupted instead of silently
repeating a potentially charged request. Diagnostics include job state and
duration, not review bodies or authentication material.

Disable `REBUTTAL_ENABLED` to roll back availability while retaining data. Do not
remove its data volume. Production rollout is a separate operator action after
the example-project checks pass.

## Verification

Run the platform Python tests, collaboration and backup-adapter Node tests,
client bundle consistency checks and Playwright workflows. Golden synthetic
mapping cases and the evaluator distinguish deterministic contract validation
from live model quality; a mock result must never be presented as measured LLM
accuracy. The browser suite includes manual-only analysis, rule application,
staleness, many-to-many mapping, shared text and responsive geometry.


A fixed 32-case live mapping evaluation on 2026-10-26 is recorded in
[the evaluation report](rebuttal-evaluation-2026-10-26.md). It measures one
model/profile on synthetic mapping and sufficiency tasks, not general translation
or conference-rule accuracy.

## Model and Korean translation defaults

All writing-assistant and Rebuttal profiles use `gpt-6.1-sol`. Writing options are
Light (`low`), Medium and High; legacy saved profile identifiers resolve to the
corresponding Sol 6.1 option. Rebuttal defaults to Light for translation/style,
Medium for analysis/mapping/simulation/rewriting, and High for standalone
consistency checks and official-rule research.

Translation requests explicitly require academic Korean in Hangul, one output per
review field chunk, no appended original or alternative versions, and preserved
numbers/qualifiers. The service rejects non-Korean outputs, duplicate review/field
entries and unrelated fields. Ordered nonoverlapping source chunks are joined
once; extra translation output from boundary concern extraction is discarded.
`rebuttal-ko-v2` invalidates older analysis caches. Codex CLI is pinned to 0.164.0
for Sol 6.1 model support. These checks detect structural/language failures, not
complete semantic translation accuracy.
