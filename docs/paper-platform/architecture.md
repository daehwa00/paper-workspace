# Paper Workspace architecture

## Implemented components

```text
Browser
  ├─ static editor + IndexedDB manuscript state and uploaded assets
  ├─ PDF.js preview + SyncTeX click mapping
  ├─ /api/compile ──> isolated TeX Live compiler
  ├─ /api/backups ──> SQLite snapshot service
  ├─ /collab ───────> presence/cursor WebSocket
  └─ /api/codex ────> read-only ephemeral Codex bridge
                         (optional host auth mount)
```

The nginx workspace serves the custom HTML/CSS/JavaScript client and a read-only, manifest-staged project runtime. A separate networkless process reads `PAPER_PROJECT_DIR`/`PAPER_PROJECTS_DIR`, validates each `project.json`, rejects links and unsafe paths, and atomically publishes only catalogued files. The web and backup services never mount the raw manuscript library. `project.json` is the only project discovery contract. Venue templates are user-supplied project files; the image does not contain a conference author kit or manuscript.

The browser sends the current project sources and compile assets in each compile request. The compiler has no project-library mount: it creates a fresh temporary directory, writes only validated request paths, and runs `pdflatex` with `-no-shell-escape`, `openin_any=p`, and `openout_any=p` on an internal network without Internet egress. After a successful build, a bounded server-issued token may restore only generated reference artifacts such as `.aux`, `.bbl`, and `.toc` into the next fresh directory; source files, assets, logs, and PDFs are never retained in that incremental state. A stable prose edit therefore needs one LaTeX pass, while changed references or bibliography inputs automatically run the additional passes needed to converge. Source-package builds force the existing clean multi-pass path. Exact requests are cached briefly; simultaneous identical requests share one in-flight build; cache memory, expanded SyncTeX, logs, workers, and processes are bounded. Compiled SyncTeX is referenced by an expiring compile ID instead of being retransmitted on every PDF click. A newer request from the same browser tab terminates only that tab's superseded TeX process. Containers run read-only with dropped capabilities and resource limits. This is editing infrastructure, not a venue compliance oracle.

The Codex bridge receives an explicitly selected passage and current file context, runs Codex in ephemeral read-only mode, validates structured output, and returns a proposal. The browser applies it only after a user action. Host credentials are mounted read-only and are never copied into the image or browser bundle.

## Persistence and collaboration boundary

Text files, comments, layout, and drafts are saved transactionally in IndexedDB. `localStorage` contains only lightweight preferences and a bounded current-file recovery copy, so a large manuscript or generated data file cannot exhaust its small synchronous quota. A legacy `localStorage` manuscript is deleted only after the equivalent IndexedDB transaction commits. Locally uploaded binary assets use a separate IndexedDB store. Manifest-managed server assets are fetched lazily for preview and embedded only when a compile needs them; passive data assets such as JSON are never copied into editable manuscript state. Shared uploads accept a small passive allowlist (PDF, PNG, JPEG, and EPS), verify file signatures, enforce per-file and per-project quotas, and always download as attachments. When the project state changes, the browser also sends a complete recovery snapshot to the backup service at ten-minute intervals. The service stores zlib-compressed JSON in SQLite in the `backup_data` named volume and retains the most recent configured number of snapshots per project (50 by default). Generated PDF and SyncTeX output are excluded.

The collaboration service hosts one Yjs document per allowlisted project room. Text files, folders, comments, tasks, and character-level edits merge as CRDT updates; awareness carries presence and relative cursor positions. A fresh browser waits for authoritative Yjs synchronization before it may coordinate a manifest upgrade, so an empty local store cannot reset an existing manuscript. The WebSocket edge bounds message size, ingress, connection age/count, rooms, document growth, and persistence growth before forwarding updates to Yjs. It also waits for the room's LevelDB state before accepting protocol messages. The collaboration service mounts only the sanitized project-runtime volume read-only. Browsers poll its content-derived revision and send only a revision signal; the server re-reads and hashes managed staged sources, serializes updates per room, preserves divergent connected edits as drafts, preflights the Yjs size, and flushes LevelDB before acknowledging. Browser-supplied text is never accepted as canonical server source, duplicate signals are idempotent, and only explicit `retired_paths` delete collaborative files. Browser IndexedDB supports offline recovery, while server LevelDB persists shared updates across service restarts. Binary assets use the backup service's asset store rather than the Yjs document. SQLite snapshots remain periodic disaster-recovery points, not a Git replacement or a user-attributed revision log. The volumes survive normal container replacement and `docker compose down`, but not `docker compose down -v`, disk loss, or host compromise; operators must replicate primary data and snapshot exports to separate storage.

## Public deployment boundary

Compose binds to loopback by default. Caddy routes `/api/backups/*` before the general compiler API and strips that prefix before proxying. The password gate applies bounded per-IP exponential cooldowns; OAuth deployments inject the authenticated identity server-side for activity records. Browser-provided display names remain collaboration UI metadata, not audit identity. Caddy applies CSP, clickjacking, HSTS, MIME-sniffing, and referrer protections.

Caddy's bridge token authenticates proxy-to-bridge traffic, not people. The Codex bridge receives only the selected manuscript context, starts the CLI with model-visible shell, unified-exec, app, and multi-agent tools disabled, passes a minimal environment, and rejects credential-like output. Its authentication file remains server-only. Backup project identifiers are not authorization credentials, so operators should keep the complete site behind the supplied password or OAuth layer and replicate the backup database off-host.

For hosts without a managed domain, the repository includes an optional Google OAuth proxy override (`compose.auth.yaml`). It is disabled in the base Compose file until a Google OAuth client's credentials, cookie secret, and private allowed-email file are supplied. The override protects the static app and all API/WebSocket routes through one session. Email invitations are currently represented by the private allowlist; SMTP delivery can be added without changing the login provider.

For a small trusted lab, `compose.password.yaml` is a simpler alternative. It rejects placeholder/short credentials, issues a signed secure session cookie after the shared password is entered, and supports explicit `POST /logout`. This is intentionally not an individual identity system: use it only when shared accountability and shared-password rotation are acceptable.

Operational preflight, backup, release, and rollback procedures are documented in [operations.md](operations.md).
