# PR Review Agent

A nightly Node.js script that finds GitHub PRs requesting your review, runs each one through a Claude agent using your review skill (pulled live from a separate repo), and saves feedback locally. A self-hosted HTML dashboard lets you read all feedback and open every PR in a new tab.

---

## How It Works

1. **launchd** triggers `run-reviews.js` on a schedule
2. The script fetches your review skill `.md` live from your skills repo
3. It queries GitHub for open PRs where you are a requested reviewer
4. Each PR's diff, files, and description are sent to a Claude agent in parallel
5. Results are saved to `results/reviews.json`
6. A persistent local server serves the dashboard at `http://localhost:3000/dashboard/`
7. Open the dashboard to read feedback and open all PRs in new tabs

---

## Repo Structure

```
pr-review-agent/
├── .env.example          # API key template — copy to .env
├── .env                  # your keys — never committed
├── .gitignore
├── package.json
├── run-reviews.js        # the nightly agent script
├── dashboard/
│   └── index.html        # self-hosted review dashboard
├── logs/                 # launchd output (not committed)
└── results/              # review JSON output (not committed)
    └── reviews.json
```

Your review skill lives in its own separate repo and is fetched at runtime via `REVIEW_SKILL_URL`.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/<your_gh_username>/pr-review-agent.git
cd pr-review-agent
npm install
mkdir -p logs results
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Key | Description |
|---|---|
| `GITHUB_TOKEN` | Personal access token. Needs `pull_requests: read` and `contents: read`. Settings → Developer settings → Fine-grained tokens. |
| `ANTHROPIC_API_KEY` | From console.anthropic.com → API Keys |
| `REVIEW_SKILL_URL` | Raw GitHub URL to your review skill `.md` file, e.g. `https://raw.githubusercontent.com/you/skills-repo/main/pr-review.md` |

### 3. Test manually

```bash
npm run review
```

Expected output:
```
🚀  PR Review Agent starting...
📥  Fetching review skill from https://raw.githubusercontent.com/...
    Loaded 1842 characters.
🔍  Searching for PRs requesting review from yourname...
    Found 3 PR(s) needing review.
📋  Reviewing 3 PR(s) in parallel...
  🤖  Reviewing PR #42 in org/repo: "Add login flow"
  🤖  Reviewing PR #17 in org/repo2: "Fix null pointer"
✅  Completed 3/3 reviews.
💾  Results saved to results/reviews.json
```

### 4. Test the dashboard

```bash
npx serve .
# Open http://localhost:3000/dashboard/
```

---

## Scheduling on macOS (launchd)

You need two launchd jobs: one that runs the nightly review script, and one that keeps the dashboard server running persistently.

### Job 1 — Nightly review script

Create `~/Library/LaunchAgents/com.pr-review-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pr-review-agent</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/ABSOLUTE/PATH/TO/pr-review-agent/run-reviews.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/ABSOLUTE/PATH/TO/pr-review-agent</string>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>/ABSOLUTE/PATH/TO/pr-review-agent/logs/out.log</string>

  <key>StandardErrorPath</key>
  <string>/ABSOLUTE/PATH/TO/pr-review-agent/logs/err.log</string>

  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

### Job 2 — Dashboard server (always on)

Create `~/Library/LaunchAgents/com.pr-review-dashboard.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pr-review-dashboard</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/npx</string>
    <string>serve</string>
    <string>.</string>
    <string>--listen</string>
    <string>3000</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/ABSOLUTE/PATH/TO/pr-review-agent</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/ABSOLUTE/PATH/TO/pr-review-agent/logs/dashboard.log</string>

  <key>StandardErrorPath</key>
  <string>/ABSOLUTE/PATH/TO/pr-review-agent/logs/dashboard-err.log</string>
</dict>
</plist>
```

`KeepAlive: true` means launchd will restart the server if it ever crashes. `RunAtLoad: true` starts it immediately when you load the plist.

### Load both jobs

```bash
launchctl load ~/Library/LaunchAgents/com.pr-review-agent.plist
launchctl load ~/Library/LaunchAgents/com.pr-review-dashboard.plist
```

### Verify

```bash
launchctl list | grep pr-review
# Both jobs should appear
```

### Other useful commands

```bash
# Trigger the review script right now (without waiting for schedule)
launchctl start com.pr-review-agent

# Stop/disable a job
launchctl unload ~/Library/LaunchAgents/com.pr-review-agent.plist

# Watch live logs
tail -f logs/out.log
tail -f logs/err.log
```

> **Tip:** launchd skips runs while the laptop is asleep and does not catch up.
> If your laptop is usually closed at 2am, change the hour to something it's reliably awake,
> or enable **System Settings → Energy → Wake for network access**.

---

## Setting Up on a New Machine

```bash
git clone https://github.com/<your_gh_username>/pr-review-agent.git
cd pr-review-agent
npm install
mkdir -p logs results
cp .env.example .env
# fill in .env with your keys
# create both launchd plists as above
launchctl load ~/Library/LaunchAgents/com.pr-review-agent.plist
launchctl load ~/Library/LaunchAgents/com.pr-review-dashboard.plist
```

---

## Dashboard

Open **http://localhost:3000/dashboard/** in any browser.

- Shows all reviewed PRs with agent feedback
- Summary bar: total PRs, repos, lines added/removed
- **Expand/Collapse** each feedback block
- **Open PR** opens that single PR in a new tab
- **Open All PRs in Tabs** opens every PR at once
- Auto-refreshes every 60 seconds
