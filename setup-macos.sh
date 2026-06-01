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

# ── Claude Code permissions ───────────────────────────────────────────────────

echo "🔐  Configuring Claude Code permissions for autonomous PR review..."

CLAUDE_SETTINGS_DIR="$HOME/.claude"
CLAUDE_SETTINGS_FILE="$CLAUDE_SETTINGS_DIR/settings.json"

mkdir -p "$CLAUDE_SETTINGS_DIR"

if [ -f "$CLAUDE_SETTINGS_FILE" ]; then
  echo "    ~/.claude/settings.json already exists — merging allowedTools..."
  # Use node to safely merge allowedTools into existing settings
  node -e "
    const fs = require('fs');
    const path = '$CLAUDE_SETTINGS_FILE';
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
    const required = [
      'read',
      'bash(gh pr view*)',
      'bash(gh pr diff*)',
      'bash(gh repo clone*)',
      'bash(mkdir*)',
      'bash(grep*)'
    ];
    const existing = settings.allowedTools || [];
    const merged = Array.from(new Set([...existing, ...required]));
    settings.allowedTools = merged;
    fs.writeFileSync(path, JSON.stringify(settings, null, 2));
    console.log('    Merged. allowedTools:', merged.join(', '));
  "
else
  echo "    Creating ~/.claude/settings.json..."
  cat > "$CLAUDE_SETTINGS_FILE" << 'CLAUDE_SETTINGS'
{
  "allowedTools": [
    "read",
    "bash(gh pr view*)",
    "bash(gh pr diff*)",
    "bash(gh repo clone*)",
    "bash(mkdir*)",
    "bash(grep*)"
  ]
}
CLAUDE_SETTINGS
  echo "    Created with PR review permissions."
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
echo "   2. Ensure GitHub CLI is installed and authenticated: gh auth login"
echo "   3. Test manually: npm run review"
echo "   4. Dashboard: http://localhost:3000/dashboard/"
echo ""
echo "   The review script will run at 2am and 2pm daily."
echo "   The dashboard server is running now in the background."
echo "   Claude Code is configured to run PR reviews autonomously."
