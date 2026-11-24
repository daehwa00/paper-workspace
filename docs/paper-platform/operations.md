# Paper Workspace operations

This runbook is for a production host that keeps Caddy as its only published service. It deliberately avoids destructive volume operations.

## Release preflight

1. Export the allowlisted platform into a clean directory and review the resulting diff. Never deploy directly from a research worktree.
2. Run `pytest -q tests/paper_platform`, collaboration server tests, Playwright, JavaScript syntax checks, `npm audit`, Compose validation, and the history secret scan.
3. Generate a random access password of at least 12 characters and an independent random session secret of at least 32 characters. Rotating the session secret signs every user out.
4. Confirm the project catalog and each `project.json` include every required source, bibliography, style, class, and passive asset. Manifest-unlisted files are intentionally unavailable.
5. Record the current image/source revision and export the backup database before changing containers. Copy the export to storage outside the Docker host.
6. Use `docker compose config --quiet` on the exact base and authentication override files that will be deployed. Review volume sources, domain, bind address, and user IDs without printing secret values.

## Safe rollout

Build the complete release once, then replace the stack as one logical unit. Do not rebuild or restart after each individual source edit. Use `docker compose up -d --build`, never `down -v`.

After replacement, require every service to be healthy. The compiler health endpoint verifies its TeX/SyncTeX/PDF tools and writable temporary workspace; collaboration health reflects its persistence quota; password-gate health rejects unsafe credential configuration.

Smoke-test through Caddy, not by publishing internal service ports:

- unauthenticated catalog, thumbnails, manuscript files, APIs, and WebSocket upgrades are denied;
- login, explicit logout, session reuse, and session expiry behave as configured;
- open an existing paper without changing it, then edit a disposable line, observe shared save, compile, PDF replacement, and both SyncTeX directions;
- refresh and reconnect from a second browser profile; verify the text merges and the previous PDF remains available during an induced compile error;
- create a named backup, compare it, restore it only after taking a fresh pre-restore checkpoint, and confirm the activity card changes;
- upload and delete a disposable passive asset, checking that active HTML/SVG and oversized files are rejected.

## Single-file runtime release

Freeze the exact deployment after resolving all its override files with the default
`docker compose config --format json`. Store that JSON privately: it contains
resolved environment values. Do not use `--no-interpolate` or `--no-env-resolution`
for this input. Separately prepare `images.json` containing every service and its
already inspected local immutable image ID, for example
`{"workspace": "sha256:<64 lowercase hexadecimal digits>"}`. Extra or missing
services and mutable tags are rejected.

```sh
python scripts/paper_platform/freeze_runtime_release.py \
  --compose /private/resolved.compose.json \
  --images /private/images.json \
  --output /private/releases/release-20261028
```

The output parent must already exist; the release directory must be new and no
input or output path component may be a symlink. The tool runs no Docker commands,
starts no containers, and accesses no application data. It writes a mode `0700`
directory with `runtime.compose.json` (mode `0600`) and `manifest.json` (mode
`0644`). The manifest contains only service image IDs and the Compose file's SHA-256
hash. The runtime file contains secrets and must remain private. Terminal output
contains only the two generated paths and the service count.

The runtime file removes builds, pins all images to their IDs, preserves resolved
runtime settings, and makes every explicitly named volume external. Anonymous
volumes and relative bind sources are rejected. Existing Compose `$$` escapes are
preserved; lone `$` characters are escaped for one subsequent Compose parse. Bind
mounts still require the same absolute host paths. Provision the recorded existing
volumes separately during disaster recovery; Compose will fail if an external
volume is absent rather than silently creating an empty replacement.

Validate the generated file with `docker compose -f
/private/releases/release-20261028/runtime.compose.json config --quiet`. For the
approved rollout, use that single file with `docker compose -f
/private/releases/release-20261028/runtime.compose.json up -d --no-build
--pull never`; the previous override chain is no longer required. The images must
already exist on the host, or be loaded from a separately retained image archive.
The tool does not export images, source archives, bind contents, or volume backups.
Retain those artifacts with the release and complete the health and recovery checks
in this runbook. Never use `down -v`.

For an offline integrity check, import
`scripts.paper_platform.freeze_runtime_release.verify_release` and call it with a
`pathlib.Path` to the release directory. It verifies the file hash, image mapping,
and frozen settings without printing configuration values. This detects accidental
changes; the manifest is not a signature or an authenticity guarantee.

## Backup and disaster recovery

Primary collaboration LevelDB, SQLite snapshots/assets, and snapshot exports are different failure domains. Replicate all three outside the host. A source snapshot does not version binary assets, so retain the asset tree alongside database/export generations.

Before a restore, stop writes at the edge or establish a maintenance window, export current state, and record volume ownership. Restore into new volumes first and run consistency/health checks before switching Compose volume sources. Never overwrite the only copy of a volume and never run `docker compose down -v` during routine operations.

Test recovery periodically with an isolated Compose project and copied data. A backup that has not been restored is not verified.

## Rollback

Keep the previous source revision and image tags until the smoke test passes. Application rollback is normally a code/image rollback while reusing the forward-compatible data volumes. This release performs no database migration.

If a rollback is required:

1. block new traffic or announce a short maintenance window;
2. export the current database and preserve all current volumes;
3. select the prior source/image revision and run Compose without `-v`;
4. wait for health checks, then repeat login, paper open, edit/save, compile/PDF, SyncTeX, collaboration, and backup read checks;
5. reopen traffic only after the previous version has read the preserved state successfully.

Do not restore an older database merely to roll back application code unless an independently preserved, verified recovery point and a documented incompatibility require it.

## Known trust boundary

The shared-password mode has no per-user project ACL or attributable audit identity. Use OAuth or an identity-aware proxy when individual revocation, project-level authorization, or trustworthy editor attribution is required. Browser display names are presence metadata, not security identities.
