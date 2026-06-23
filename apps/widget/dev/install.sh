#!/usr/bin/env bash
# Install oo-widget as a macOS LaunchAgent so the menu bar glance is ALWAYS there —
# relaunched at login and if it ever crashes. Re-run anytime to pick up a rebuild.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.owner-operator.widget"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$DIR/.build/release/oo-widget"

echo "building release…"
( cd "$DIR" && swift build -c release >/dev/null )

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

# Drop any session-launched copy so launchd owns the single instance.
pkill -f 'release/oo-widget' 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "loaded $LABEL — the widget is now always there (menu bar), across logout/reboot."
echo "remove it with: dev/uninstall.sh"
