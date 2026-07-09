#!/usr/bin/env bash
# Remove the oo-widget LaunchAgent and stop the running widget.
set -euo pipefail
LABEL="com.owner-operator.widget"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DAEMON_LABEL="com.owner-operator.daemon"
DAEMON_PLIST="$HOME/Library/LaunchAgents/$DAEMON_LABEL.plist"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl unload "$DAEMON_PLIST" 2>/dev/null || true
rm -f "$PLIST" "$DAEMON_PLIST"
pkill -f 'release/oo-widget' 2>/dev/null || true
pkill -f 'oo daemon' 2>/dev/null || true
echo "removed $LABEL and $DAEMON_LABEL"
