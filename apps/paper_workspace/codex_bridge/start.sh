#!/bin/sh
set -eu
umask 077
export CODEX_HOME="${CODEX_HOME:-/tmp/codex-home}"
mkdir -p "$CODEX_HOME"
mkdir -p "${CODEX_WORKSPACE:-/tmp/codex-workspace}"
cp /run/secrets/codex-auth "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
exec node /app/server.mjs
