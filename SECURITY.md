# Security policy

Please report vulnerabilities privately to the repository maintainer instead of opening a public issue containing credentials or unpublished manuscript text.

The default Compose configuration binds ports to `127.0.0.1`. Do not set `PAPER_BIND_ADDRESS=0.0.0.0` until the complete workspace is protected by the supplied password or OAuth overlay, an identity-aware proxy, or a VPN. The built-in bridge token authenticates Caddy to the Codex bridge; it does **not** authenticate end users.

Keep Caddy as the only published service. Direct access to the password gate, compiler, collaboration, backup, or Codex bridge bypasses the trusted-proxy assumptions used for client IP and authenticated actor headers. The provided Compose networks keep those services internal. OAuth deployments should use `compose.auth.yaml`, which records the proxy-authenticated email; the shared-password deployment intentionally records the non-attributable actor `Shared user`.

Uploaded shared assets are restricted to signature-validated PDF, PNG, JPEG, and EPS files and are served as attachments. The compiler receives request-scoped sources only, has no manuscript-library mount, uses restrictive TeX file access, and has no Internet egress. The collaboration edge applies origin, room, message, connection, and disk quotas. The Codex bridge disables model-visible execution and app tools and filters credential-like output. Preserve these controls when changing deployment topology.

Never commit `.env`, `auth.json`, `.codex/`, manuscripts under review, datasets, experiment outputs, or generated PDFs. If a secret was committed once, removing the file later is insufficient: rotate the secret and clean the Git history.

The exporter scans every exported file in bounded-memory chunks and the public repository runs Gitleaks across Git history in CI. These are guardrails, not proof that a manuscript or arbitrary binary is publishable; review the clean export before pushing it.
