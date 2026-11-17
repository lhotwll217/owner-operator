#!/usr/bin/env bash
# Install Owner Operator as a pinned runtime and point the always-on services and the global `oo`
# at it. Run from a checkout to install or upgrade:
#   scripts/install-runtime.sh [<git-ref>]   # default HEAD; uncommitted changes are not installed
# Each commit installs once into $OO_HOME/runtime/<commit>. The daemon LaunchAgent and `oo` run that
# copy, so editing or switching branches in a checkout never changes or restarts the live daemon.
# Run from an installed runtime (no Git), it reinstalls the services for that runtime.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
OO_HOME="${OO_HOME:-$HOME/.owner-operator}"

if [ "$(git -C "$SRC" rev-parse --show-toplevel 2>/dev/null)" = "$SRC" ]; then
  COMMIT="$(git -C "$SRC" rev-parse --verify "${1:-HEAD}^{commit}")"
  RUNTIME="$OO_HOME/runtime/$COMMIT"
  if [ ! -d "$RUNTIME" ]; then
    mkdir -p "$OO_HOME/runtime"
    STAGE="$(mktemp -d "$OO_HOME/runtime/.partial-$COMMIT.XXXXXX")"
    git -C "$SRC" archive "$COMMIT" | tar -x -C "$STAGE"
    (cd "$STAGE" && npm ci --no-audit --no-fund)
    if [ -d "$RUNTIME" ]; then rm -rf "$STAGE"; else mv "$STAGE" "$RUNTIME"; fi
  fi
else
  [ "$#" -eq 0 ] || { echo "install-runtime: <git-ref> needs a Git checkout; $SRC is an installed runtime" >&2; exit 2; }
  RUNTIME="$SRC"
fi

OO_HOME="$OO_HOME" "$RUNTIME/apps/widget/dev/install.sh"
npm install -g --ignore-scripts --no-audit --no-fund "$RUNTIME"
echo "Owner Operator now runs from $RUNTIME"
