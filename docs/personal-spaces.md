# Personal paper spaces

The accounts profile adds individual issued passwords, `/<username>` hubs and project membership to the existing password gate. Existing `/p/<slug>` URLs, source files, backups and Yjs room names are preserved. The shared password is **not accepted** in accounts mode; existing sessions must sign in again. Keep credentials outside the repository and outside all project source roots.

## Provisioning

Run the CLI from the repository root. Use a private directory owned by the configured `HOST_UID`/`HOST_GID` (directory 0700, registry and issued credentials 0600). The gate runs as that same UID in this profile. `issue-user` generates a random password and writes it only to a new secret-output file; the registry stores a salted scrypt hash. Use `--rotate` to deliberately replace a password, invalidating its old sessions.

```bash
python3 scripts/paper_platform/manage_accounts.py --registry /private/paper-accounts/accounts.json issue-user --user researcher --secret-output /private/credentials/researcher.txt
python3 scripts/paper_platform/manage_accounts.py --registry /private/paper-accounts/accounts.json grant --user researcher --project example-paper --backup-id example-paper --role owner
```

These are operator commands, not a public signup endpoint. `backup-id` must match the existing manifest/backup identity, which may differ from its route slug. A project can have multiple members. Owner/editor can edit; viewer can read source, PDF and backups but cannot publish shared document updates, change assets or create/restore backups. Owners are managed by the operator in this initial release; a self-service invitation UI is not included. `revoke` removes one membership, `disable-user` disables an account. Registry updates are atomic; do not run provisioning commands concurrently.

Set `default_project` in the registry to the slug behind the legacy `/project/` source alias, if that route is needed. Never assign a project just because someone knows its URL. With no project grants the new space has an empty catalog.

Set `PAPER_ACCOUNTS_DIR` in the deployment `.env` and apply all three compose files:

```bash
docker compose -f infra/paper-workspace/compose.yaml -f infra/paper-workspace/compose.password.yaml -f infra/paper-workspace/compose.accounts.yaml up -d --build
```

For subsequent service updates, continue using all three files. Dropping the accounts overlay re-enables shared-password mode and is not a routine rollback. The CLI registry location must not be served by nginx. The project catalog mount is read-only and responses are filtered on the server. Proxy headers carrying identity/permissions are stripped from incoming requests and replaced after authentication. Backup activity is also filtered. Compiler state and SyncTeX cache tokens are scoped to the authenticated actor. HTTP permissions reload each request; existing WebSockets reconnect for authorization at least once per minute.

## Paper intake

Keep one directory per paper under the researcher's `papers/` folder. Unpack an Overleaf source ZIP, preserving relative paths and case. Include the main `.tex`, bibliography, figures and required styles. Exclude credentials, repositories, datasets, checkpoints and experiment logs.

Ask for the title, main TeX path and the intended viewers/editors. The upload directory does not publish automatically. Before registration:

1. Validate the main file and required inputs. Classify UTF-8 source as managed text and binary figures as assets; never classify archives or `.npz` as text.
2. Assign a globally unique project slug and stable backup ID. Create a manifest with explicit compile inputs.
3. Map the same canonical source directory to the runtime and collaboration services (with an explicit per-project bind mount if outside `PAPER_PROJECTS_DIR`). Runtime reads it; collaboration writes managed text back. Do not use symlinks, which runtime validation rejects.
4. Register its catalog entry and membership, then verify compile, authorized read/write and unauthorized denial before sharing the URL.

A shared Unix account can read that account's files regardless of web membership. Web access separation does not provide isolation between shell users sharing the same Unix identity.
