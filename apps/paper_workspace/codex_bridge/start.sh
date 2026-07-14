#!/bin/sh
set -eu
mkdir -p /home/node/.codex
mkdir -p "${CODEX_WORKSPACE:-/tmp/codex-workspace}"
cp /run/secrets/codex-auth /home/node/.codex/auth.json
chmod 600 /home/node/.codex/auth.json
exec node /app/server.mjs
