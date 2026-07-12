# Paper Workspace architecture

## Implemented components

```text
Browser
  ├─ static editor + localStorage text drafts + IndexedDB uploaded assets
  ├─ PDF.js preview + SyncTeX click mapping
  ├─ /api/compile ──> isolated TeX Live compiler
  ├─ /api/backups ──> SQLite snapshot service
  ├─ /collab ───────> presence/cursor WebSocket
  └─ /api/codex ────> read-only ephemeral Codex bridge
                         (optional host auth mount)
```

The nginx workspace serves the custom HTML/CSS/JavaScript client and a read-only project seed mounted from `PAPER_PROJECT_DIR`. `project.json` is the only project discovery contract. Venue templates are user-supplied project files; the image does not contain a conference author kit or manuscript.

The compiler creates a fresh temporary directory per request, writes only validated project paths, reads manifest-managed assets directly from the read-only project library, and runs `pdflatex` with `-no-shell-escape`. Ordinary documents use two LaTeX passes; BibTeX or an explicit rerun warning permits a third pass. Exact requests are cached briefly, and compiled SyncTeX is referenced by an expiring compile ID instead of being retransmitted on every PDF click. A newer request from the same browser terminates its superseded TeX process. Containers run read-only with dropped capabilities and resource limits. This is editing infrastructure, not a venue compliance oracle.

The Codex bridge receives an explicitly selected passage and current file context, runs Codex in ephemeral read-only mode, validates structured output, and returns a proposal. The browser applies it only after a user action. Host credentials are mounted read-only and are never copied into the image or browser bundle.

## Persistence and collaboration boundary

Text files, comments, layout, and drafts are saved in localStorage; locally uploaded binary assets use IndexedDB so browser localStorage quotas are not consumed by Base64 files. Manifest-managed server assets are fetched lazily for preview and are read directly by the compiler. When the project state changes, the browser also sends a complete recovery snapshot to the backup service at ten-minute intervals. The service stores zlib-compressed JSON in SQLite in the `backup_data` named volume and retains the most recent configured number of snapshots per project (50 by default). Generated PDF and SyncTeX output are excluded.

The collaboration service hosts one Yjs document per authenticated project room. Text files, folders, comments, tasks, and character-level edits merge as CRDT updates; awareness carries presence and relative cursor positions. Browser IndexedDB supports offline recovery, while server LevelDB persists shared updates across service restarts. Binary assets use the backup service's asset store rather than the Yjs document. SQLite snapshots remain periodic disaster-recovery points, not a Git replacement or a user-attributed revision log. The volumes survive normal container replacement and `docker compose down`, but not `docker compose down -v`, disk loss, or host compromise; operators must replicate primary data and snapshot exports to separate storage.

## Public deployment boundary

Compose binds to loopback by default. Caddy routes `/api/backups/*` before the general compiler API and strips that prefix before proxying. Caddy's bridge token authenticates proxy-to-bridge traffic, not people, and backup project identifiers are not authorization credentials. Before Internet exposure, put the complete site behind user authentication and project authorization, add compile/collaboration/backup quotas, and replicate the backup database off-host. Anonymous public exposure can read or fill snapshots if left unprotected, consume host compute, and consume the operator's Codex quota.

For hosts without a managed domain, the repository includes an optional Google OAuth proxy override (`compose.auth.yaml`). It is disabled in the base Compose file until a Google OAuth client's credentials, cookie secret, and private allowed-email file are supplied. The override protects the static app and all API/WebSocket routes through one session. Email invitations are currently represented by the private allowlist; SMTP delivery can be added without changing the login provider.

For a small trusted lab, `compose.password.yaml` is a simpler alternative. It issues a signed, secure session cookie after the shared password is entered. This is intentionally not an individual identity system: use it only when shared accountability and shared-password rotation are acceptable.
