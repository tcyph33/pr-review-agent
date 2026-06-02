#!/bin/bash
set -e

echo "🚀  Setting up PR Review Agent..."

# ── Dependencies ──────────────────────────────────────────────────────────────

echo "📦  Installing dependencies..."
npm install
mkdir -p logs results logs/orchestration logs/reviews

# ── .env ──────────────────────────────────────────────────────────────────────

if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝  Created .env from .env.example."
  echo "    Fill in your keys there, or set them as environment variables directly."
  echo "    Either works — the script checks both."
else
  echo "📝  .env already exists, skipping."
fi

# ── Resolve binary paths ──────────────────────────────────────────────────────
# launchd runs with a minimal PATH — we resolve full paths now so the plist
# has absolute paths that work regardless of shell environment.

echo "🔎  Resolving binary paths..."

REPO_PATH=$(pwd)
NPX_PATH=$(which npx)
TSX_PATH=$(which tsx 2>/dev/null || echo "$REPO_PATH/node_modules/.bin/tsx")
CLAUDE_PATH=$(which claude 2>/dev/null || echo "")
GH_PATH=$(which gh 2>/dev/null || echo "")
NODE_PATH=$(which node)

# Derive PATH that includes all needed binaries for the plist EnvironmentVariables
BIN_DIRS=$(echo "$NPX_PATH:$NODE_PATH:$CLAUDE_PATH:$GH_PATH" \
  | tr ':' '\n' | xargs -I{} dirname {} | sort -u | tr '\n' ':' | sed 's/:$//')
LAUNCHD_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$BIN_DIRS"

echo "    npx:    $NPX_PATH"
echo "    tsx:    $TSX_PATH"
echo "    claude: ${CLAUDE_PATH:-not found — install with: npm install -g @anthropic-ai/claude-code}"
echo "    gh:     ${GH_PATH:-not found — install with: brew install gh}"
echo "    node:   $NODE_PATH"

if [ -z "$CLAUDE_PATH" ]; then
  echo ""
  echo "⚠️   claude CLI not found. Install it before running reviews:"
  echo "    npm install -g @anthropic-ai/claude-code"
  echo ""
fi

if [ -z "$GH_PATH" ]; then
  echo ""
  echo "⚠️   gh CLI not found. Install it before running reviews:"
  echo "    brew install gh && gh auth login"
  echo ""
fi

# ── Claude Code permissions ───────────────────────────────────────────────────

echo "🔐  Configuring Claude Code permissions for autonomous PR review..."

CLAUDE_SETTINGS_DIR="$HOME/.claude"
CLAUDE_SETTINGS_FILE="$CLAUDE_SETTINGS_DIR/settings.json"

mkdir -p "$CLAUDE_SETTINGS_DIR"

if [ -f "$CLAUDE_SETTINGS_FILE" ]; then
  echo "    ~/.claude/settings.json already exists — merging allowedTools..."
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$LAUNCHD_PATH</string>
    <key>NODE_USE_SYSTEM_CA</key>
    <string>1</string>
  </dict>
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
  <key>StandardErrorPath</key>
  <string>$REPO_PATH/logs/launchd-err.log</string>
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$LAUNCHD_PATH</string>
    <key>NODE_USE_SYSTEM_CA</key>
    <string>1</string>
  </dict>
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
if [ -z "$CLAUDE_PATH" ]; then
echo "   2. Install Claude Code: npm install -g @anthropic-ai/claude-code"
echo "   3. Authenticate GitHub CLI: gh auth login"
echo "   4. Test manually: npm run review"
echo "   5. Dashboard: http://localhost:3000/dashboard/"
else
echo "   2. Authenticate GitHub CLI: gh auth login"
echo "   3. Test manually: npm run review"
echo "   4. Dashboard: http://localhost:3000/dashboard/"
fi
echo ""
echo "   The review script will run at 2am and 2pm daily."
echo "   The dashboard server is running now in the background."
echo "   Claude Code is configured to run PR reviews autonomously."
