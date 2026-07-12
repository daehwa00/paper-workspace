[**English**](README.md) | [한국어](README.ko.md)

# Paper Workspace

A self-hosted research-paper workspace for editing LaTeX in the browser, building PDFs in an isolated TeX Live container, navigating from PDF content to source lines, seeing collaborators' locations, and reviewing Codex editing suggestions.

> **Current scope:** Text, the text-file tree, folders, comments, and tasks are collaboratively edited with the Yjs CRDT and persisted in browser IndexedDB and server LevelDB. Images and PDFs uploaded in the browser are stored in both the server asset store and IndexedDB, then appear immediately for collaborators through Yjs metadata. Changed projects receive compressed server-side SQLite recovery points every 10 minutes. In production, store the database/assets and snapshot exports on separate external or NFS paths.

The LaTeX editor provides CodeMirror line numbers, syntax highlighting, bracket matching, search, autocomplete, and undo/redo. A status control summarizes collaboration, browser persistence, PDF, and server-backup health. On mobile, users can switch among focused Files, Source, PDF, and Assistant views.

The interface defaults to English for international use. Korean is selected automatically only when the browser advertises Korean and no preference has been saved. The language control in the upper-right corner changes the interface immediately and remembers the choice in this browser. For a shareable override, append `?lang=en` or `?lang=ko` to a hub, login, or project URL.

## Demo

The following image was captured from a running Paper Workspace after opening the public Example Paper and completing a real LaTeX build and PDF.js render. No research manuscript, review material, experiment result, server address, or credential was used in the capture.

![Paper Workspace example project](docs/demo/workspace-overview.png)

This is a real view of two collaborators reading the same manuscript and composing an inline comment on selected text.

![Realtime collaboration and inline review](docs/demo/collaboration-review.png)

The animation below covers the complete flow: side-by-side source and PDF, selection-based comments and Codex requests, pre-submission checks, and save, collaboration, PDF, and backup status.

![Edit, save, and render workflow](docs/demo/edit-and-render-flow.gif)

These captures are not static mockups. Reproduce the same flow against a local or deployed instance with the following command. Omit the password variable in an unauthenticated local environment. ImageMagick's `convert` command is required.

```bash
cd apps/paper_workspace/collaboration
PAPER_DEMO_URL=https://localhost \
PAPER_DEMO_PROJECT=example-paper \
npm run capture:demo
```

## Quick start

You need Git, Docker Engine, and Docker Compose v2. The TeX Live image is large, so the first build may download several gigabytes.

```bash
cp infra/paper-workspace/.env.example infra/paper-workspace/.env
docker compose -f infra/paper-workspace/compose.yaml up --build -d
```

The default sample is `examples/paper-workspace-project`, and the service is exposed only on the local machine at `https://localhost`. Inspect its status and logs as follows.

```bash
docker compose -f infra/paper-workspace/compose.yaml ps
docker compose -f infra/paper-workspace/compose.yaml logs -f workspace compiler
docker compose -f infra/paper-workspace/compose.yaml down
```

Your browser may show a development-certificate warning if it does not trust the local Caddy certificate.

## Manage multiple papers on one server

The server root is a paper-list hub, and each paper opens at its own stable URL.

```text
https://paper.example.com/                 paper list
https://paper.example.com/p/aaai27         one paper workspace
https://paper.example.com/p/forecasting    another paper workspace
```

Use a slug containing letters, numbers, `-`, and `_` instead of placing the paper title directly in the URL. The title appears on its hub card and in the workspace header, so editing it does not break links. Create a slug directory under `PAPER_PROJECTS_DIR`, put `project.json` and `main.tex` inside it, and add a card to the `projects` array in the root `index.json`.

```json
{
  "projects": [
    {"slug":"aaai27", "display_name":"AAAI-27 Paper", "description":"Main submission"},
    {"slug":"forecasting", "display_name":"Forecasting Study", "description":"Time-series experiments"}
  ]
}
```

Browser drafts, collaboration cursors, and server backups are isolated by paper slug. You can keep an existing single-paper setup with only `PAPER_PROJECT_DIR`; set `PAPER_PROJECTS_DIR` to enable the paper-list hub.

## Connect your manuscript

1. Copy the example directory to a new directory outside Git.
2. Put `main.tex`, `.bib` files, conference-provided `.cls`, `.sty`, and `.bst` files, and figures in that directory.
3. List every file needed for compilation in `project.json` under `files`. Mark a figure as `{"path":"Figures/plot.pdf","type":"asset"}`. If the source and compilation locations differ, safely map a relative path such as `{"path":"venue.sty","source":"vendor/venue.sty"}`.
4. In single-paper mode, set `PAPER_PROJECT_DIR` in `.env` to that directory's absolute path. In multi-paper mode, place it in a slug directory under `PAPER_PROJECTS_DIR`, then restart Compose.

`entrypoint` is the default document to compile and defaults to `main.tex`. File paths cannot be absolute or contain `..`. You can request a PDF preview for any selected `.tex` file. Standalone documents compile directly; fragments such as an appendix or section compile through a temporary wrapper that reuses the main document's preamble. `preview_entrypoints` is optional metadata for explicitly listing standalone documents and is not required for fragment previews. Automatic compilation runs one second after the last edit, and identical results are reused for 10 minutes. The compile API accepts at most 120 files, a 48 MB request, and 32 MB of binary assets. Browser uploads are limited to 8 MB per file.

```json
{
  "entrypoint": "main.tex",
  "preview_entrypoints": ["main.tex", "supplement.tex"],
  "page_limit": 7
}
```

Select an auxiliary document and refresh the PDF to compile it as `preview.pdf`. The PDF-panel status shows the active render target, and the resulting SyncTeX mapping resolves source positions relative to the selected document.

Server project files are startup seeds. If the browser already has edits, the workspace may create an automatic recovery draft. To start from a completely fresh project, clear the site's `paper-workspace` browser storage or use a new browser profile.

## Everyday workflow

- Automatic save and PDF refresh after editing
- `Cmd/Ctrl+S`, `Cmd/Ctrl+Z`, and `Cmd/Ctrl+Shift+Z`
- Click PDF content to navigate to its SyncTeX source line
- `Cmd/Ctrl+click` in the LaTeX editor to navigate to the corresponding PDF position
- `Cmd/Ctrl+wheel` over the editor or PDF to zoom only that panel
- Create a comment or Codex editing request from selected text
- Drag and drop files and folders; download the PDF
- Click figures under `Figures/` to preview, zoom, and download them in place of the editor
- Collapse the sidebar and assistant; resize panels and zoom the editor/PDF

## Submission tools

The assistant's **Checks** tab examines the current browser draft for citation keys, labels/references, possible anonymity violations, TODO/FIXME markers, missing figures, PDF page count, and embedded fonts. Selecting a result navigates to the corresponding source line when possible. It also summarizes used, unused, duplicated, and missing Figure/Table assets and BibTeX entries. These checks do not replace a conference's official submission checker; always run the official checker before submission.

**Build source ZIP** first verifies that the current source compiles in the isolated compiler. Only after a successful build does it package the source and required assets with `SHA256SUMS`. Large remote assets supplied by the server are included, while shell escape and external network access remain disabled.

The assistant's **Tasks** tab attaches tasks to the current cursor's file and line and tracks completion. Tasks are included in automatic persistence and server snapshots. A Codex suggestion shows both a LaTeX preview and the original/replacement diff before applying it; it will not be applied automatically if the source has changed since the request.

## Ten-minute server backups

In addition to immediate browser persistence, changed projects are snapshotted to the server every 10 minutes. A snapshot contains the project files, comments, title, and other editing state required for recovery. Regenerable output such as PDFs and SyncTeX data is excluded. The default retention is the latest 50 snapshots per project.

By default, the backup database and uploaded assets use the Docker named volume `backup_data`. Compressed JSON copies of each snapshot are also written to a separate `backup_exports` volume. In production, place these sources on separate disks or NFS paths.

```dotenv
BACKUP_RETENTION=50
BACKUP_DATA_SOURCE=/mnt/paper-primary
BACKUP_EXPORT_SOURCE=/mnt/offhost-paper-backups
BACKUP_MAX_ASSET_BYTES=16777216
BACKUP_MAX_PROJECT_ASSET_BYTES=134217728
```

`BACKUP_DATA_SOURCE` stores the SQLite database and shared assets. `BACKUP_EXPORT_SOURCE` stores per-project `*.json.zlib` snapshots. Container UID 10001 must be able to write both external paths. An unchanged automatic backup does not create a duplicate snapshot, but it updates `checked_at` so the last successful check remains visible.

You can compare or restore a backup against the current manuscript one file at a time; the workspace preserves the current state before restoring. Important states can be named as checkpoints such as `submission-v1`. This feature is not an account system or a per-user collaboration audit trail. It cannot distinguish visitors who know the same project identifier, so any public deployment must add site-wide authentication and project authorization. `docker compose down -v` deletes named volumes and every snapshot: use `down` for routine shutdowns, and back up the server itself independently.

## Codex integration

Codex reads the selected text, request, and current-file context and returns a **suggestion before application**. The bridge invokes Codex in read-only, ephemeral mode and does not directly modify manuscript files.

Configure the following values in `.env`.

```dotenv
CODEX_AUTH_FILE=/absolute/path/to/.codex/auth.json
CODEX_BRIDGE_TOKEN=a-long-random-string
HOST_UID=1000
HOST_GID=1000
```

Never commit `auth.json` or `.env`. Caddy injects the bridge token internally, so the browser does not receive the key; this is not visitor authentication. Exposing Codex without login protection lets anyone consume the operator account's usage.

## Public deployment

We recommend placing Paper Workspace behind a VPN or identity-aware proxy. Use these values only after adding an authentication layer.

```dotenv
PAPER_DOMAIN=paper.example.com
PAPER_BIND_ADDRESS=0.0.0.0
```

After DNS points to the server and ports 80/443 are allowed, Caddy manages TLS certificates. The compiler and collaboration socket also need user authentication, project permissions, and request quotas. Running the current implementation as an anonymous public service is not recommended.

### No domain: Google OAuth

Cloudflare Access requires a domain managed through Cloudflare. Without one, use the optional Google OAuth proxy, which also works with a `nip.io` address.

1. Create an OAuth Web application in Google Cloud Console and register `https://YOUR_PAPER_DOMAIN/oauth2/callback` as its callback URL.
2. Copy `infra/paper-workspace/.env.auth.example` to `.env.auth`, then enter the Client ID, client secret, and cookie secret.
3. Copy `allowed-emails.example` to `.auth/allowed-emails` and leave only the Google-account emails that should have access.
4. Use the same host for `PAPER_DOMAIN` and the callback URL.
5. Start Compose with the authentication override.

```bash
docker compose -f infra/paper-workspace/compose.yaml \
  -f infra/paper-workspace/compose.auth.yaml up --build -d
```

Only Google accounts listed in `.auth/allowed-emails` are accepted. With authentication enabled, the workspace, compiler, backup, Codex, and WebSocket all share the same login boundary. If the machine directly exposes origin ports 80/443, configure its firewall so the authentication proxy cannot be bypassed. Invitations currently use the allowlist file; automatic invitation email can be connected later with SMTP credentials.

### Shared password for a small lab

If Google login is too burdensome, use the optional password gate. After a successful entry it issues an `HttpOnly`, `Secure`, `SameSite` session cookie and does not ask again until the configured session expires.

```bash
cp infra/paper-workspace/.env.password.example infra/paper-workspace/.env.password
```

Set a lab password in `PAPER_ACCESS_PASSWORD` and a long random `PAPER_SESSION_SECRET` in `.env.password`, then start the password-gated configuration.

```bash
docker compose -f infra/paper-workspace/compose.yaml \
  -f infra/paper-workspace/compose.password.yaml up --build -d
```

Because every user shares one password, this mode provides no per-user audit, revocation, or role separation. Use it only in a trusted small lab and rotate the password immediately if it is exposed.

## Repository layout

```text
apps/paper_workspace/        UI, compiler, backup, collaboration, Codex bridge
infra/paper-workspace/       Docker Compose, Caddy, nginx
examples/paper-workspace-project/  minimal public example
docs/paper-platform/         implementation and security boundaries
scripts/paper_platform/      public-repository export/preflight
tests/paper_platform/        regression and publication-boundary tests
```

Research manuscripts are not part of this layout. They are connected only at runtime through `PAPER_PROJECT_DIR`.

## Publish to GitHub

Do not push the entire research repository. Use the allowlist exporter.

```bash
python scripts/paper_platform/export_public_workspace.py /tmp/paper-workspace-public
cd /tmp/paper-workspace-public
git init
git status --short
pytest -q tests/paper_platform
```

The exporter copies only platform paths and excludes manuscripts, experiments, data, and results. `.gitignore` prevents new files from being added; it does not remove secrets that are already tracked or present in Git history. Before pushing, scan the complete Git history and revoke/reissue any exposed credential.

The MIT license applies only to the exported platform code. It does not automatically cover the research monorepo or user-mounted manuscripts. PDF.js Apache-2.0 notices remain in `THIRD_PARTY_NOTICES.md` and the vendored LICENSE.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| PDF compilation error | Inspect the right-side log for missing `.sty`/`.bst` files and figure paths or case mismatches; add every dependency to the manifest. |
| Citations show `??` | Check the BibTeX key, `references.bib`, and `\\bibliography{...}`. BibTeX runs only when the aux file contains a bibliography. |
| Server file changes do not appear | Check the browser-local draft and project version, then increment `version` in `project.json`. |
| Codex 401/429/timeout | Check the token, auth-file permissions, UID/GID, 10-minute request limit, and 120-second timeout. |
| Collaborator appears offline | Check the Caddy `/collab` reverse proxy and browser WebSocket errors. |
| Backup history is empty | The first snapshot may take up to 10 minutes after a change. Check the `backup` container logs and `backup_data` volume. |
| Backup restore fails | Confirm that the snapshot project identifier matches the current project and inspect the `/api/backups/...` response. |
| Blank screen or stale UI | Hard-refresh, then inspect the site cache and localStorage. Corrupted JSON is reset automatically. |

## Development and verification

```bash
pytest -q tests/paper_platform
node --check apps/paper_workspace/static/app.js
python -m py_compile apps/paper_workspace/compiler/server.py apps/paper_workspace/backup/server.py
node --check apps/paper_workspace/collaboration/client.js
docker compose -f infra/paper-workspace/compose.yaml config --quiet
```

Feature claims are documented only when supported by code and tests. Future work includes project-level authentication/ACLs, per-user audit history, external object-storage replication, and more advanced compiler-job priority.
