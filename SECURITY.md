# Security policy

Please report vulnerabilities privately to the repository maintainer instead of opening a public issue containing credentials or unpublished manuscript text.

The default Compose configuration binds ports to `127.0.0.1`. Do not set `PAPER_BIND_ADDRESS=0.0.0.0` until the complete workspace is protected by an identity-aware proxy or VPN. The built-in bridge token authenticates Caddy to the Codex bridge; it does **not** authenticate end users. An unauthenticated public deployment could consume the operator's Codex quota and compiler resources.

Never commit `.env`, `auth.json`, `.codex/`, manuscripts under review, datasets, experiment outputs, or generated PDFs. If a secret was committed once, removing the file later is insufficient: rotate the secret and clean the Git history.
