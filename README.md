[**English**](README.md) | [한국어](README.ko.md)

<div align="center">

# Paper Workspace

### Write, review, and ship LaTeX papers together.

A self-hosted workspace that keeps source, PDF, collaborators, review,<br />
and optional Codex editing assistance in one focused place.

[Quick start](#quick-start) · [Features](#everything-your-paper-needs) · [Architecture](docs/paper-platform/architecture.md) · [한국어](README.ko.md)

![License](https://img.shields.io/badge/license-MIT-2457D6?style=flat-square)
![LaTeX](https://img.shields.io/badge/LaTeX-TeX%20Live-2457D6?style=flat-square)
![Collaboration](https://img.shields.io/badge/collaboration-Yjs-2457D6?style=flat-square)
![Languages](https://img.shields.io/badge/UI-English%20%7C%20한국어-2457D6?style=flat-square)

<img src="apps/paper_workspace/static/assets/share-preview-v2.png" alt="Paper Workspace character writing at a laptop" width="100%" />

<em>Your manuscript, rendered paper, and research conversation—kept in sync.</em>

</div>

<br />

<div align="center">
  <img src="docs/demo/edit-and-render-flow.gif" alt="LaTeX editing and live PDF rendering in Paper Workspace" width="100%" />
</div>

This demo uses the public Example Paper and a real LaTeX build. It contains no research manuscript, review material, server address, or credential.

## Everything your paper needs

| | |
| --- | --- |
| **Write with a real LaTeX editor**<br />Syntax highlighting, search, autocomplete, file discovery, and reliable undo/redo. | **See every change in the PDF**<br />Compile inside an isolated TeX Live container and move between PDF and source with SyncTeX. |
| **Collaborate without losing context**<br />Shared cursors, selected-text comments, review tasks, and Yjs realtime editing stay attached to the manuscript. | **Review before you rewrite**<br />Optional Codex assistance returns inspectable suggestions and never edits manuscript files without approval. |
| **Prepare the actual submission**<br />Preview figures, check references and fonts, enforce page limits, and build a source ZIP with checksums. | **Recover with confidence**<br />Automatic server snapshots, named versions, file comparison, and restore keep important drafts within reach. |

## Complete feature tour

### Projects and files

- Manage multiple papers from a searchable project hub with stable URLs, recent-activity sorting, the latest editor, and server-recorded modification time.
- Search the project tree by full path; archival `drafts` start collapsed without overriding later personal choices.
- Create, rename, move, and delete files or folders; drag in individual files or complete directory trees.
- Keep text files and binary assets shared with the project instead of trapping them in one browser.
- Preview images and multi-page PDFs with zoom controls, or download assets that need an external application.
- Open any standalone `.tex` document directly; preview fragments with the main manuscript preamble.

### LaTeX authoring

- Edit with CodeMirror syntax highlighting, bracket-aware editing, autocomplete, search, selection, and line numbers.
- Use per-file undo/redo, `Cmd/Ctrl+S`, and cursor-preserving history without waiting for the server.
- Autosave edits and start a fresh PDF build after the manuscript settles.
- Search large projects without horizontally compressing long source lines or text prompts.
- Keep browser drafts separate from deployed server source, detect server changes, and open preserved drafts on demand.
- Recover safely from malformed or quota-limited local browser state instead of blocking the manuscript.

### PDF preview and SyncTeX

- Compile in an isolated TeX Live service with cache-aware status and actionable diagnostics.
- Render long PDFs lazily, zoom under the pointer, and keep the current/total page indicator visible.
- Preserve the visible page and scroll position when a new PDF replaces the previous render.
- Click the PDF to jump to LaTeX source; `Cmd/Ctrl+click` source to locate the matching PDF position.
- Highlight the complete wrapped source line when navigating from PDF to LaTeX.
- Keep the last successful PDF visible after a failed build and jump from the normalized error directly to the best source line.
- Preview standalone documents or fragments while keeping the primary manuscript entrypoint explicit.

### Realtime collaboration and review

- Merge concurrent text changes with Yjs and show collaborator presence, names, colors, cursors, and active-file locations.
- Keep local edits available while collaboration reconnects, then merge queued work before claiming it is shared.
- Attach comments to a selected passage and revision, show inline comment anchors, jump back to context, and resolve completed threads.
- Turn selected text into shared tasks with completion state, assignee context, file location, and direct source navigation.
- Track the latest editor and activity time at project level so “recently active” reflects server activity rather than one browser's history.
- Inspect collaboration, save, PDF, and backup freshness together in the workspace health center.

### Codex revision workflow

- Send a selected passage, instruction, current-file context, and task-oriented model profile to the optional Codex bridge.
- Submit with Enter, keep Shift+Enter for new lines, and avoid accidental submission during Korean IME composition.
- Keep previous requests and proposals visible as one conversation; ask follow-ups that remember the current selection and earlier suggestions.
- Start a new conversation explicitly without reloading the workspace.
- Review the proposed LaTeX, explanation, and before/after diff before applying anything.
- Refuse automatic application if the selected source changed while Codex was working.
- Keep the assistant collapsible and preserve its conversation while PDF builds or compile errors happen elsewhere.

### Submission checks and research assets

- Check page limits, embedded fonts, missing figures, anonymity candidates, and other submission risks against the latest manuscript and PDF.
- Inventory used and unused figures/tables and jump from an asset result to its source reference.
- Detect missing, duplicate, used, and uncited bibliography entries across project files.
- Import BibTeX while preventing duplicate citation keys.
- Open compiler diagnostics at the relevant file and line.
- Build a submission-ready source ZIP containing required text files, binary assets, and `SHA256SUMS`.

### Versions, resilience, and workspace experience

- Create automatic ten-minute server recovery points, named checkpoints, file comparisons, and one-action restores.
- Separate primary data, project assets, and compressed backup exports so deployments can use independent storage.
- Resize source, PDF, and assistant panes; collapse the assistant, reset widths, and preserve personal layout preferences.
- Switch compact screens to focused Source, PDF, and Assistant surfaces, with Files available from mobile bottom navigation.
- Choose light, dark, or system appearance while rendered paper pages remain publication-white.
- Use English or Korean with browser detection, explicit persisted preference, and shareable `?lang=` links.
- Navigate assistant tabs and resizing controls by keyboard, retain visible focus, honor reduced motion, and use touch-sized mobile controls.
- Monitor loading, offline, queued, stale-PDF, conflict, success, and error states with persistent status, inline feedback, and toasts where context matters.

English is the default interface. Korean browsers select Korean automatically unless a preference already exists; the language picker remembers explicit choices. Add `?lang=en` or `?lang=ko` to share a language-specific link.

## Quick start

Requirements: Git, Docker Engine, and Docker Compose v2. The first TeX Live build may download several gigabytes.

```bash
cp infra/paper-workspace/.env.example infra/paper-workspace/.env
docker compose -f infra/paper-workspace/compose.yaml up --build -d
```

Open `https://localhost`. A browser warning is expected until the local Caddy certificate is trusted.

```bash
docker compose -f infra/paper-workspace/compose.yaml ps
docker compose -f infra/paper-workspace/compose.yaml logs -f workspace compiler
docker compose -f infra/paper-workspace/compose.yaml down
```

## Manage multiple papers on one server

The server root lists projects; each project has a stable slug URL.

```text
https://paper.example.com/
https://paper.example.com/p/aaai27
https://paper.example.com/p/forecasting
```

Create one directory per slug under `PAPER_PROJECTS_DIR`, then list its card in the root `index.json`.

```json
{
  "projects": [
    {"slug":"aaai27", "display_name":"AAAI-27 Paper", "description":"Main submission"},
    {"slug":"forecasting", "display_name":"Forecasting Study", "description":"Time-series experiments"}
  ]
}
```

Use only letters, numbers, `-`, and `_` in slugs. Titles may change without changing project URLs. Keep `PAPER_PROJECT_DIR` for a single project, or set `PAPER_PROJECTS_DIR` to enable the hub.

## Connect your manuscript

1. Copy the example project to a directory outside this repository.
2. Add `main.tex`, bibliography files, conference `.cls`/`.sty`/`.bst` files, and figures.
3. List compilation inputs in `project.json`.
4. Point `PAPER_PROJECT_DIR` at the directory, or place it under `PAPER_PROJECTS_DIR`, then restart Compose.

```json
{
  "entrypoint": "main.tex",
  "preview_entrypoints": ["main.tex", "supplement.tex"],
  "page_limit": 7,
  "files": [
    {"path":"main.tex", "type":"text"},
    {"path":"Figures/plot.pdf", "type":"asset"}
  ]
}
```

Paths must be relative and cannot contain `..`. Any selected `.tex` file can be previewed: standalone documents compile directly, while fragments reuse the main preamble. The compiler accepts up to 120 files, a 48 MB request, and 32 MB of binary assets; browser uploads are limited to 8 MB per file.

Server files seed the browser workspace. Increment `version` in `project.json` when a deployed manuscript should replace an older browser seed.

## Everyday workflow

- Edits save automatically and trigger a PDF refresh.
- `Cmd/Ctrl+S`, `Cmd/Ctrl+Z`, and `Cmd/Ctrl+Shift+Z` work in the editor.
- Click the PDF to open the source; `Cmd/Ctrl+click` source to locate it in the PDF.
- `Cmd/Ctrl+wheel` zooms the editor or PDF under the pointer.
- Select text to add a comment or request a Codex revision.
- Drag files or folders into the project tree; click figures to preview them.
- Use **Checks** for references, anonymity candidates, missing figures, page count, and embedded fonts.
- Use **Build source ZIP** to compile and package submission files with `SHA256SUMS`.

Always run the conference's official checker before submission.

## Ten-minute server backups

Changed projects receive a server recovery point every 10 minutes; the latest 50 are retained by default. Name important versions, compare files, or restore a snapshot from the **Sources** tab.

For production, keep the primary database/assets and compressed snapshot exports on separate disks or NFS paths.

```dotenv
BACKUP_RETENTION=50
BACKUP_DATA_SOURCE=/mnt/paper-primary
BACKUP_EXPORT_SOURCE=/mnt/offhost-paper-backups
```

Both paths must be writable by container UID 10001. `docker compose down -v` deletes named volumes and snapshots; use `down` for routine shutdowns.

## Codex integration

Codex receives the selected text, request, and current-file context, then returns a reviewable suggestion. It does not directly edit manuscript files.

```dotenv
CODEX_AUTH_FILE=/absolute/path/to/.codex/auth.json
CODEX_BRIDGE_TOKEN=a-long-random-string
HOST_UID=1000
HOST_GID=1000
```

Never commit `auth.json` or `.env`. The bridge token protects the internal service, not the website; visitor authentication is still required.

## Public deployment

Put Paper Workspace behind a VPN, identity-aware proxy, Google OAuth, or the included small-lab password gate. Do not expose an anonymous compiler or Codex bridge.

```dotenv
PAPER_DOMAIN=paper.example.com
PAPER_BIND_ADDRESS=0.0.0.0
```

With DNS pointed at the server and ports 80/443 open, Caddy manages TLS. For Google OAuth, configure `.env.auth` and `.auth/allowed-emails`, then use `compose.auth.yaml`.

For a trusted small lab, copy the password example, set a unique password and a long random session secret, and start the password override.

```bash
cp infra/paper-workspace/.env.password.example infra/paper-workspace/.env.password
docker compose -f infra/paper-workspace/compose.yaml \
  -f infra/paper-workspace/compose.password.yaml up --build -d
```

A shared password has no per-user roles, revocation, or audit history. Rotate it immediately if exposed.

## Repository layout

```text
apps/paper_workspace/              application services and UI
infra/paper-workspace/             Docker Compose, Caddy, nginx
examples/paper-workspace-project/  minimal public example
docs/paper-platform/               architecture and security notes
scripts/paper_platform/            public export tooling
tests/paper_platform/              regression tests
```

Research manuscripts are mounted at runtime and are not part of the public platform repository.

## Publish to GitHub

Export the allowlisted platform instead of pushing a research repository directly.

```bash
python scripts/paper_platform/export_public_workspace.py /tmp/paper-workspace-public
cd /tmp/paper-workspace-public
pytest -q tests/paper_platform
git status --short
```

The exporter excludes manuscripts, experiments, data, and results. `.gitignore` cannot remove secrets already committed to Git history, so scan history and revoke any exposed credential before publishing.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| PDF compilation error | Missing `.sty`/`.bst` files, figure path case, and `project.json` entries |
| Citations show `??` | BibTeX keys, bibliography path, and the compiler log |
| Server edits do not appear | Browser draft state and `project.json` version |
| Codex 401/429/timeout | Token, auth-file permissions, UID/GID, and request limits |
| Collaborator appears offline | Caddy `/collab` proxy and browser WebSocket errors |
| Backup history is empty | `backup` logs and the backup volume; the first snapshot may take 10 minutes |
| Blank or stale UI | Hard refresh, then clear damaged site storage if needed |

## Development and verification

```bash
pytest -q tests/paper_platform
node --check apps/paper_workspace/static/app.js
node --check apps/paper_workspace/collaboration/client.js
python -m py_compile apps/paper_workspace/compiler/server.py apps/paper_workspace/backup/server.py
docker compose -f infra/paper-workspace/compose.yaml config --quiet
```

Regenerate the real demo against a local or deployed Example Paper with `npm run capture:demo` from `apps/paper_workspace/collaboration`. ImageMagick is required for the GIF.
