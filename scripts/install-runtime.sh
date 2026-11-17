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

# One install at a time per user, whatever OO_HOME, because every install rewrites the same
# LaunchAgents and global oo. The lock lives on this shell's fd 9, which its commands inherit, so it
# holds until this run and anything it started have exited, even if the run is killed.
exec 9>"/tmp/owner-operator-install-$(id -u).lock"
perl -MFcntl=:flock -e 'open(my $lock, ">&=9") or die "install-runtime: $!\n"; flock($lock, LOCK_EX) or die "install-runtime: $!\n"'

if [ "$(dirname "$SRC")" = "$(cd "$OO_HOME/runtime" 2>/dev/null && pwd -P)" ]; then
  [ "$#" -eq 0 ] || { echo "install-runtime: <git-ref> needs a Git checkout; $SRC is an installed runtime" >&2; exit 2; }
  RUNTIME="$SRC"
elif [ "$(git -C "$SRC" rev-parse --show-toplevel)" = "$SRC" ]; then
  COMMIT="$(git -C "$SRC" rev-parse --verify "${1:-HEAD}^{commit}")"
  RUNTIME="$OO_HOME/runtime/$COMMIT"
  if [ ! -d "$RUNTIME" ]; then
    # A fresh staging folder per run: a killed run's npm children can outlive the lock and keep
    # writing into theirs.
    rm -rf "$OO_HOME/runtime"/.partial-* || true
    mkdir -p "$OO_HOME/runtime"
    STAGE="$(mktemp -d "$OO_HOME/runtime/.partial-$COMMIT.XXXXXX")"
    git -C "$SRC" archive "$COMMIT" | tar -x -C "$STAGE"
    (cd "$STAGE" && npm ci --no-audit --no-fund)
    mv "$STAGE" "$RUNTIME"
  fi
else
  echo "install-runtime: $SRC is neither a Git checkout nor an installed runtime" >&2
  exit 2
fi

# Link the global oo, then point the LaunchAgents at the runtime. The daemon LaunchAgent is the
# commit point: launchd and every oo client start the daemon from it. If the helper fails before
# writing it, put the previous global oo back; once it names this runtime, finish the switch.
GLOBAL="$(npm root -g)/owner-operator"
if [ -L "$GLOBAL" ]; then PREVIOUS="$(cd "$GLOBAL" 2>/dev/null && pwd -P || echo none)"
elif [ -e "$GLOBAL" ]; then PREVIOUS=unknown; else PREVIOUS=none; fi
npm install -g --ignore-scripts --no-audit --no-fund "$RUNTIME"
ACTIVATED=1
OO_HOME="$OO_HOME" "$RUNTIME/apps/widget/dev/install.sh" || ACTIVATED=0
if [ "$ACTIVATED" = 0 ] && ! grep -qF "<string>$RUNTIME/oo</string>" "$HOME/Library/LaunchAgents/com.owner-operator.daemon.plist" 2>/dev/null; then
  case "$PREVIOUS" in
    none) npm uninstall -g owner-operator ;;
    unknown) echo "install-runtime: global oo now points at $RUNTIME; rerun to finish" >&2 ;;
    *) npm install -g --ignore-scripts --no-audit --no-fund "$PREVIOUS" ;;
  esac
  exit 1
fi
OO_HOME="$OO_HOME" node --import "$RUNTIME/node_modules/tsx/dist/loader.mjs" "$RUNTIME/scripts/take-over-daemon.ts"
[ "$ACTIVATED" = 1 ] || { echo "install-runtime: the LaunchAgents did not all load; the daemon runs from $RUNTIME, rerun to finish" >&2; exit 1; }
echo "Owner Operator now runs from $RUNTIME"
