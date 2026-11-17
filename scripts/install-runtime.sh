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

# One install at a time, so the services and the global oo always land on the same commit. The
# kernel releases the lock if a run dies.
if [ -z "${OO_RUNTIME_INSTALL_LOCKED:-}" ]; then
  mkdir -p "$OO_HOME/runtime"
  OO_RUNTIME_INSTALL_LOCKED=1 exec lockf -k "$OO_HOME/runtime/.install.lock" "$0" "$@"
fi

if [ "$(git -C "$SRC" rev-parse --show-toplevel 2>/dev/null)" = "$SRC" ]; then
  COMMIT="$(git -C "$SRC" rev-parse --verify "${1:-HEAD}^{commit}")"
  RUNTIME="$OO_HOME/runtime/$COMMIT"
  if [ ! -d "$RUNTIME" ]; then
    STAGE="$OO_HOME/runtime/.partial-$COMMIT"
    rm -rf "$STAGE" && mkdir "$STAGE"
    git -C "$SRC" archive "$COMMIT" | tar -x -C "$STAGE"
    (cd "$STAGE" && npm ci --no-audit --no-fund)
    mv "$STAGE" "$RUNTIME"
  fi
else
  [ "$#" -eq 0 ] || { echo "install-runtime: <git-ref> needs a Git checkout; $SRC is an installed runtime" >&2; exit 2; }
  RUNTIME="$SRC"
fi

OO_HOME="$OO_HOME" "$RUNTIME/apps/widget/dev/install.sh"
npm install -g --ignore-scripts --no-audit --no-fund "$RUNTIME"
OO_HOME="$OO_HOME" node --import "$RUNTIME/node_modules/tsx/dist/loader.mjs" "$RUNTIME/scripts/take-over-daemon.ts"
echo "Owner Operator now runs from $RUNTIME"
