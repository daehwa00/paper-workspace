# Paper Workspace architecture

## Implemented components

```text
Browser
  ├─ static editor + localStorage
  ├─ PDF.js preview + SyncTeX click mapping
  ├─ /api/compile ──> isolated TeX Live compiler
  ├─ /collab ───────> presence/cursor WebSocket
  └─ /api/codex ────> read-only ephemeral Codex bridge
                         (optional host auth mount)
```

The nginx workspace serves the custom HTML/CSS/JavaScript client and a read-only project seed mounted from `PAPER_PROJECT_DIR`. `project.json` is the only project discovery contract. Venue templates are user-supplied project files; the image does not contain a conference author kit or manuscript.

The compiler creates a fresh temporary directory per request, writes only validated project paths, runs `pdflatex` with `-no-shell-escape`, conditionally runs BibTeX, and returns PDF and SyncTeX bytes. Containers run read-only with dropped capabilities and resource limits. This is editing infrastructure, not a venue compliance oracle.

The Codex bridge receives an explicitly selected passage and current file context, runs Codex in ephemeral read-only mode, validates structured output, and returns a proposal. The browser applies it only after a user action. Host credentials are mounted read-only and are never copied into the image or browser bundle.

## Persistence and collaboration boundary

Files, comments, layout, and drafts are currently browser-local. The collaboration server broadcasts only presence and cursor selection. It does not merge text, assign revisions, store projects, or persist comments. Simultaneous editing therefore needs external coordination and source-control backups.

## Public deployment boundary

Compose binds to loopback by default. Caddy's bridge token authenticates proxy-to-bridge traffic, not people. Before Internet exposure, put the complete site behind user authentication and project authorization, add compile/collaboration quotas, and establish durable backup. Anonymous public exposure can consume host compute and the operator's Codex quota.
