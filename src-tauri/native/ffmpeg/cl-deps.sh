#!/bin/sh
set -o pipefail
# FFmpeg parses English /showIncludes output. Normalize only include lines
# with an absolute Windows path; this also works without an English VS pack.
cl.exe "$@" 2>&1 | sed -E 's@^[^:]+:[^:]+:([[:space:]]+)([A-Za-z]:[\\/].*)$@Note: including file:\1\2@'
