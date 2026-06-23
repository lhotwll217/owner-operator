#!/usr/bin/env bash
# Remove the oo-widget LaunchAgent and stop the running widget.
set -euo pipefail
LABEL="com.owner-operator.widget"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
pkill -f 'release/oo-widget' 2>/dev/null || true
echo "removed $LABEL"
