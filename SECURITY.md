# Security policy

Please report vulnerabilities privately to the repository maintainer instead of opening a public issue containing credentials or unpublished manuscript text.

The default Compose configuration binds ports to `127.0.0.1`. Do not set `PAPER_BIND_ADDRESS=0.0.0.0` until the complete workspace is protected by the supplied password or OAuth overlay, an identity-aware proxy, or a VPN. The built-in bridge token authenticates Caddy to the Codex bridge; it does **not** authenticate end users.

Keep Caddy as the only published service. Direct access to the password gate, compiler, collaboration, backup, or Codex bridge bypasses the trusted-proxy assumptions used for client IP and authenticated actor headers. The provided Compose networks keep those services internal. OAuth deployments should use `compose.auth.yaml`, which records the proxy-authenticated email. The shared-password deployment records the browser profile name as display metadata only; it is user-editable and must not be treated as an authenticated audit identity.

Uploaded shared assets are restricted to signature-validated PDF, PNG, JPEG, and EPS files and are served as attachments. The compiler receives request-scoped sources only, has no manuscript-library mount, uses restrictive TeX file access, and has no Internet egress. The collaboration edge applies origin, room, message, connection, and disk quotas. The Codex bridge disables model-visible execution and app tools and filters credential-like output. Preserve these controls when changing deployment topology.

Never commit `.env`, `auth.json`, `.codex/`, manuscripts under review, datasets, experiment outputs, or generated PDFs. If a secret was committed once, removing the file later is insufficient: rotate the secret and clean the Git history.

The exporter scans every exported file in bounded-memory chunks. Public CI runs the platform unit/browser suites, dependency audit, Compose validation, and Gitleaks across Git history. These are guardrails, not proof that a manuscript or arbitrary binary is publishable; review the clean export before pushing it.

The password gate requires a non-placeholder access password of at least 12 characters and an independent session secret of at least 32 characters. The shared-password mode is still a single security principal: it cannot enforce per-user or per-project authorization. Use OAuth or an identity-aware proxy for individual revocation and attributable access.

Follow [the operations runbook](https://github.com/daehwa00/paper-workspace/blob/main/docs/paper-platform/operations.md) for releases and recovery. Preserve collaboration, backup/assets, and export storage separately; never use `docker compose down -v` as a normal deployment or rollback step.
