#!/bin/bash
set -e

echo "🚀  Setting up PR Review Agent..."

# ── Dependencies ──────────────────────────────────────────────────────────────

echo "📦  Installing dependencies..."
npm install
mkdir -p logs results

# ── .env ──────────────────────────────────────────────────────────────────────

if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝  Created .env from .env.example."
  echo "    Fill in your keys there, or set them as environment variables directly."
  echo "    Either works — the script checks both."
else
  echo "📝  .env already exists, skipping."
fi

# ── launchd ───────────────────────────────────────────────────────────────────

REPO_PATH=$(pwd)
NPX_PATH=$(which npx)

echo "⚙️   Writing launchd plists..."

cat > ~/Library/LaunchAgents/com.pr-review-agent.plist << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pr-review-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NPX_PATH</string>
    <string>tsx</string>
    <string>$REPO_PATH/run-reviews.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_PATH</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Hour</key>
      <integer>2</integer>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
    <dict>
      <key>Hour</key>
      <integer>14</integer>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
  </array>
  <key>StandardOutPath</key>
  <string>$REPO_PATH/logs/out.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO_PATH/logs/err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLIST

cat > ~/Library/LaunchAgents/com.pr-review-dashboard.plist << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pr-review-dashboard</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NPX_PATH</string>
    <string>tsx</string>
    <string>$REPO_PATH/server.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_PATH</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$REPO_PATH/logs/dashboard.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO_PATH/logs/dashboard-err.log</string>
</dict>
</plist>
PLIST

echo "⚙️   Loading launchd jobs..."
launchctl load ~/Library/LaunchAgents/com.pr-review-agent.plist
launchctl load ~/Library/LaunchAgents/com.pr-review-dashboard.plist

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "✅  Setup complete."
echo ""
echo "   Next steps:"
echo "   1. Set your keys in .env, or export them as environment variables"
echo "   2. Test manually: npm run review"
echo "   3. Dashboard: http://localhost:3000/dashboard/"
echo ""
echo "   The review script will run at 2am and 2pm daily."
echo "   The dashboard server is running now in the background."
