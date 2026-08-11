#!/bin/bash
# Build Darbar Buddy.app into dist/ and (optionally) launch it: ./scripts/build-app.sh [--run]
# Recipe from ~/all-things-saturn/coplanner-buddy: hand-assembled bundle, LSUIElement so there is
# no dock icon, ad-hoc signature. Simpler than the original because this copy has no resources:
# every avatar is SwiftUI vector art, so the executable is the whole app.
set -euo pipefail
cd "$(dirname "$0")/.."

# No port is hardcoded in Swift. The repo .env is the single source of config (root CLAUDE.md),
# so the resolved API base is read from it here and stamped into the bundle. DARBAR_API in the
# environment still wins at runtime.
ENV_FILE="../../.env"
PORT="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' \r' || true)"
API_BASE="${DARBAR_API:-http://127.0.0.1:${PORT:-4899}/api}"
echo "API base: $API_BASE"

swift build -c release

APP="dist/Darbar Buddy.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cp .build/release/DarbarBuddy "$APP/Contents/MacOS/DarbarBuddy"

# The identifier is deliberately NOT com.heysaturn.coplanner-buddy. That one ships to colleagues as
# a DMG; this is Raj's own tool. A shared identifier would mean one preferences domain (so the two
# pets would fight over avatar, size and window position), one Launch Services registration, and
# one login item. Different id, different name, different autosave key: they install side by side.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>DarbarBuddy</string>
    <key>CFBundleIdentifier</key><string>com.rajvarsani.darbar-buddy</string>
    <key>CFBundleName</key><string>Darbar Buddy</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>DarbarAPIBase</key><string>${API_BASE}</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP"
echo "Built $APP"

if [[ "${1:-}" == "--run" ]]; then
    pkill -x DarbarBuddy 2>/dev/null || true
    sleep 0.3
    open "$APP"
    echo "Launched."
fi
