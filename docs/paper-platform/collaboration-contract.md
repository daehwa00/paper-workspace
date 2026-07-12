# Collaboration contract

This document describes the durable Yjs collaboration behavior implemented by the workspace.

## Shared document

- Each project slug maps to an authenticated Yjs room.
- LaTeX and bibliography files are `Y.Text` values inside a project `Y.Map`.
- Comments, tasks, and folders are shared Yjs maps keyed by stable IDs or project paths.
- Character-level edits merge as CRDT operations instead of replacing a whole browser draft.
- Browser IndexedDB keeps offline Yjs updates; the server stores updates in a persistent LevelDB volume.
- Awareness carries the actor profile, active file, and Yjs relative cursor positions.

Names and colors persist in each browser. Clicking a collaborator avatar resolves the relative cursor against the current shared document and moves to that position.

## Boundaries

- Source text, text-file tree operations, comments, tasks, and folders are synchronized. Binary assets and Codex proposals remain project/browser metadata and use the backup service.
- Authentication and project routing are enforced by the existing Caddy/password or OAuth layer before WebSocket upgrade.
- Presence remains advisory. The UI claims “동기화됨” only after the Yjs provider reports sync.
- Server project files remain the canonical bootstrap source; divergent browser drafts are preserved visibly under `paper/drafts/`.

Future work is to move binary assets to a content-addressed shared object store and add per-project membership rather than a laboratory-wide credential.
