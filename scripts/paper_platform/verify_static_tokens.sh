#!/bin/sh
# grep status 1 means no tokens; matches and read errors must both fail the build.
set -eu
if [ "$#" -eq 0 ]; then
    echo 'Static token verification requires input files' >&2
    exit 2
fi
for pattern in '__[A-Z_]*_HASH__' '__FAVICON_DATA__'; do
    if grep -n "$pattern" "$@"; then
        echo 'Unresolved static build token' >&2
        exit 1
    else
        status=$?
        if [ "$status" -ne 1 ]; then
            echo 'Static token verification could not read its inputs' >&2
            exit "$status"
        fi
    fi
done
