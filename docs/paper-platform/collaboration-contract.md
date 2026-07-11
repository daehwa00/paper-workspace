# Collaboration contract

This document describes the behavior implemented today, not a future CRDT design.

## Realtime events

| Event | Fields | Behavior |
| --- | --- | --- |
| `join` | project, actor(id/name/color) | joins an in-memory room and receives current presence |
| `presence` | actors | lists other live sockets in the room |
| `cursor` | file, selection | broadcasts a collaborator's current source position |
| `leave` | actor | removes an avatar when the socket closes or heartbeat expires |

Names and colors persist in each browser. Clicking a collaborator avatar moves the local editor to the last reported file and cursor position.

## Explicit limitations

- Source text, tree operations, comments, and Codex proposals are not synchronized.
- There is no server-authoritative revision, merge algorithm, durable history, account, or project ACL.
- Rooms are process memory and disappear on restart.
- Presence is advisory and must never be treated as proof that a draft was saved.

The next safe collaboration milestone is authenticated project rooms plus a server revision log, followed by OT/CRDT document operations and revision-anchored comments.
