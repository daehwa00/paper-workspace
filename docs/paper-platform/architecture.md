# Paper Workspace architecture

## Implemented components

```text
Browser
  ├─ static editor + localStorage
  ├─ PDF.js preview + SyncTeX click mapping
  ├─ /api/compile ──> isolated TeX Live compiler
  ├─ /api/backups ──> SQLite snapshot service
  ├─ /collab ───────> presence/cursor WebSocket
  └─ /api/codex ────> read-only ephemeral Codex bridge
                         (optional host auth mount)
```

The nginx workspace serves the custom HTML/CSS/JavaScript client and a read-only project seed mounted from `PAPER_PROJECT_DIR`. `project.json` is the only project discovery contract. Venue templates are user-supplied project files; the image does not contain a conference author kit or manuscript.

The compiler creates a fresh temporary directory per request, writes only validated project paths, runs `pdflatex` with `-no-shell-escape`, conditionally runs BibTeX, and returns PDF and SyncTeX bytes. Containers run read-only with dropped capabilities and resource limits. This is editing infrastructure, not a venue compliance oracle.

The Codex bridge receives an explicitly selected passage and current file context, runs Codex in ephemeral read-only mode, validates structured output, and returns a proposal. The browser applies it only after a user action. Host credentials are mounted read-only and are never copied into the image or browser bundle.

## Persistence and collaboration boundary

Files, comments, layout, and drafts are saved immediately in browser storage. When the project state changes, the browser also sends a complete recovery snapshot to the backup service at ten-minute intervals. The service stores SQLite in the `backup_data` named volume and retains the most recent configured number of snapshots per project (50 by default). Generated PDF and SyncTeX output are excluded.

The collaboration server broadcasts only presence and cursor selection. It does not merge text or assign authoritative revisions. Server snapshots are periodic disaster-recovery points, not a CRDT/OT log, a Git replacement, or a concurrent-edit conflict resolver. The volume survives normal container replacement and `docker compose down`, but not `docker compose down -v`, disk loss, or host compromise; operators must replicate it to separate storage.

## Public deployment boundary

Compose binds to loopback by default. Caddy routes `/api/backups/*` before the general compiler API and strips that prefix before proxying. Caddy's bridge token authenticates proxy-to-bridge traffic, not people, and backup project identifiers are not authorization credentials. Before Internet exposure, put the complete site behind user authentication and project authorization, add compile/collaboration/backup quotas, and replicate the backup database off-host. Anonymous public exposure can read or fill snapshots if left unprotected, consume host compute, and consume the operator's Codex quota.
