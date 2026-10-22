#!/usr/bin/env npx tsx

import "dotenv/config";
import { execFileSync, spawn } from "child_process";
import https from "https";
import os from "os";
import fs from "fs";
import path from "path";
import {
  createOctokit,
  getAuthenticatedUsername,
  getPRsNeedingReview,
  getPRDetails,
  getPRFiles,
  getMyReviewState,
  getReviewRequestedAt,
  refreshPRStatuses,
  parsePRLocation,
  parsePRUrl,
  decideWhetherToReview,
  resolveTriggerType,
} from "./lib/github.ts";
import type { SearchPRItem, RepoConfig, TriggerType, PRLocation } from "./lib/github.ts";
import {
  loadReviews,
  saveReviews,
  mergeReviews,
  applyStatusUpdates,
  createOrchestrationLog,
  cleanupOldLogs,
  PR_LOGS_PATH,
  RESULTS_PATH,
} from "./lib/storage.ts";
import type { PRReview } from "./lib/storage.ts";
import { notify, notifyFailure, buildNotificationSummary } from "./lib/notify.ts";

// ── Config ────────────────────────────────────────────────────────────────────

const GITHUB_API_TOKEN        = process.env.GITHUB_API_TOKEN;
const REVIEW_SKILL_URL        = process.env.REVIEW_SKILL_URL;
const REVIEW_REQUESTED_REPOS  = process.env.REVIEW_REQUESTED_REPOS ?? "";
const REVIEW_ASSIGNEE_REPOS   = process.env.REVIEW_ASSIGNEE_REPOS ?? "";

const missing = (
  [
    ["GITHUB_API_TOKEN",  GITHUB_API_TOKEN],
    ["REVIEW_SKILL_URL",  REVIEW_SKILL_URL],
  ] as [string, string | undefined][]
)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  console.error(`❌  Missing required variables: ${missing.join(", ")}`);
  console.error("    Set them in the environment directly, or add them to a .env file in the repo root.");
  console.error("    See .env.example for reference.");
  process.exit(1);
}

const githubToken    = GITHUB_API_TOKEN!;
const reviewSkillUrl = REVIEW_SKILL_URL!;

// ── Clients ───────────────────────────────────────────────────────────────────

const octokit = createOctokit(githubToken);

// ── Pre-flight checks ─────────────────────────────────────────────────────────

function preflight(tee: (msg: string) => void): void {
  tee("\n🔍  Running pre-flight checks...");

  // Check claude CLI is available
  try {
    execFileSync("which", ["claude"], { stdio: "pipe" });
    tee("    ✅  claude CLI found.");
  } catch {
    throw new Error(
      "claude CLI not found. Make sure Claude Code is installed and available on PATH.\n" +
      "    Install with: npm install -g @anthropic-ai/claude-code"
    );
  }

  // Check gh CLI is available
  try {
    execFileSync("which", ["gh"], { stdio: "pipe" });
    tee("    ✅  gh CLI found.");
  } catch {
    throw new Error(
      "gh CLI not found. Make sure GitHub CLI is installed.\n" +
      "    Install with: brew install gh"
    );
  }

  // Check gh auth status
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "pipe" });
    tee("    ✅  gh auth valid.");
  } catch {
    throw new Error(
      "gh auth check failed — your GitHub CLI session may have expired.\n" +
      "    Re-authenticate with: gh auth login"
    );
  }

  tee("    All checks passed.\n");
}

// ── Skill fetcher with retry ──────────────────────────────────────────────────

async function fetchSkillWithRetry(
  maxAttempts = 3,
  delayMs = 2000
): Promise<string> {
  let lastError: Error | null = null;

  console.log(`    URL: ${reviewSkillUrl}`);
  console.log(`    Token prefix: ${githubToken?.slice(0, 8)}...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`    Attempt ${attempt}/${maxAttempts}...`);
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const req = https.get(reviewSkillUrl, {
          headers: {
            Authorization: `token ${githubToken}`,
            Accept: "application/vnd.github.json",
            "User-Agent": "pr-review-agent",
          },
        }, (res) => {
          console.log(`    Response status: ${res.statusCode} ${res.statusMessage}`);
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        req.on("error", reject);
        req.end();
      });
      const json = JSON.parse(text) as { content?: string; message?: string; status?: string };
      if (json.message || json.status) {
        console.log(`    Response body: ${text.slice(0, 200)}`);
        throw new Error(`GitHub API error: ${json.message ?? json.status}`);
      }
      if (!json.content) {
        throw new Error(`Unexpected response — no content field: ${text.slice(0, 200)}`);
      }
      // GitHub API returns base64-encoded content with newlines — strip them before decoding
      return Buffer.from(json.content.replace(/\n/g, ""), "base64").toString("utf8");
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.log(`    Error: ${lastError.message}`);
      if (attempt < maxAttempts) {
        console.log(`    Retrying in ${delayMs * attempt}ms...`);
        await new Promise(r => setTimeout(r, delayMs * attempt));
      }
    }
  }

  throw new Error(`Failed to fetch skill after ${maxAttempts} attempts: ${lastError?.message}`);
}

// ── Claude Code runner ────────────────────────────────────────────────────────

async function runWithClaudeCode(
  skill: string,
  prUrl: string,
  logPath: string,
  orchLog: (msg: string) => void
): Promise<string> {
  // Skill file is identical for all PRs — safe to share across parallel agents
  // Message file is unique per PR to avoid parallel agents overwriting each other
  const prMatch     = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  const prSlug      = prMatch ? `${prMatch[1]}-${prMatch[2]}-${prMatch[3]}` : Date.now().toString();
  const skillPath   = path.join(os.tmpdir(), "pr-review-skill.md");
  const messagePath = path.join(os.tmpdir(), `pr-review-message-${prSlug}.txt`);
  fs.writeFileSync(skillPath, skill, "utf8");
  fs.writeFileSync(messagePath, `Please review this PR: ${prUrl}`, "utf8");

  const header = `=== PR Review: ${prUrl}\n=== Started: ${new Date().toISOString()}\n\n`;
  if (!fs.existsSync(path.dirname(logPath))) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  }
  fs.writeFileSync(logPath, header, "utf8");

  return new Promise<string>((resolve, reject) => {
    const proc = spawn("bash", [
      "-c",
      `claude --print --system-prompt "$(cat '${skillPath}')" "$(cat '${messagePath}')"`
    ]);

    // spawn() takes no encoding option — that belongs to the *Sync variants — so
    // decode on the streams instead. Node's decoder holds back partial multi-byte
    // sequences, which stringifying each raw chunk would corrupt; review text is
    // full of em dashes and arrows, so boundary splits do happen.
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    const chunks: string[] = [];
    const errChunks: string[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, 30 * 60 * 1000); // 30 minute timeout per PR

    proc.stdout.on("data", (d: string) => chunks.push(d));
    proc.stderr.on("data", (d: string) => errChunks.push(d));

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      try { fs.unlinkSync(messagePath); } catch { /* best effort */ }

      if (timedOut) {
        const msg = `Timed out after 30 minutes`;
        fs.appendFileSync(logPath, `\n=== FAILED: ${new Date().toISOString()}\n${msg}\n`);
        orchLog(`  ❌  Timed out: ${prUrl}`);
        reject(new Error(`Claude Code timed out: ${msg}`));
        return;
      }

      if (code !== 0) {
        const msg = errChunks.join("").trim() || `exited with code ${code}`;
        fs.appendFileSync(logPath, `\n=== FAILED: ${new Date().toISOString()}\n${msg}\n`);
        orchLog(`  ❌  Failed: ${prUrl} — ${msg}`);
        reject(new Error(`Claude Code failed: ${msg}`));
        return;
      }

      const fullOutput = chunks.join("").trim();
      fs.appendFileSync(logPath, fullOutput + `\n\n=== Completed: ${new Date().toISOString()}\n`);
      orchLog(`  ✅  Completed: ${prUrl}`);

      // Extract just the structured review report from the full Claude Code output.
      // The skill produces a report starting with "# PR Review:" — everything before
      // that is Claude Code's internal output (tool calls, thinking, status messages).
      const reportMatch = fullOutput.match(/(# PR Review:[\s\S]+)/);
      const feedback = reportMatch ? reportMatch[1].trim() : fullOutput;

      resolve(feedback);
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      try { fs.unlinkSync(messagePath); } catch { /* best effort */ }
      fs.appendFileSync(logPath, `\n=== FAILED: ${new Date().toISOString()}\n${err.message}\n`);
      orchLog(`  ❌  Failed: ${prUrl} — ${err.message}`);
      reject(new Error(`Claude Code failed: ${err.message}`));
    });
  });
}

// ── Per-PR review ─────────────────────────────────────────────────────────────

/**
 * Builds a failed record for a PR whose API url could not be parsed, so it still
 * appears on the dashboard instead of vanishing from the run without trace.
 *
 * @param item - The PR as the search API returned it
 * @param orchLog - Appends a line to the orchestration log
 * @returns A record marked failed, with the reason written to its own log file
 */
function buildUnreviewableRecord(item: SearchPRItem, orchLog: (msg: string) => void): PRReview {
  const id      = `unknown#${item.number}`;
  const slug    = id.replace(/\//g, "-").replace("#", "-");
  const logFile = `logs/reviews/${slug}.log`;
  const message = `Could not parse the PR API url: ${item.pull_request?.url ?? "undefined"}`;

  fs.mkdirSync(PR_LOGS_PATH, { recursive: true });
  fs.writeFileSync(path.join(PR_LOGS_PATH, `${slug}.log`), message + "\n", "utf8");
  orchLog(`  ⚠️  ${message}`);

  return {
    id, title: item.title ?? "Unknown PR", url: item.html_url,
    repo: "unknown", pull_number: item.number, author: "unknown", branch: "",
    filesChanged: 0, additions: 0, deletions: 0, feedback: "",
    reviewState: "PENDING", reviewStatus: "failed", prStatus: "open",
    prCreatedAt: new Date().toISOString(), reviewRequestedAt: null, triggerType: "commenter",
    lastReviewSubmittedAt: null, newCommits: [], commitsSeenAt: null,
    reviewedHeadSha: null, currentHeadSha: null, commitsSeenSha: null,
    reviewedAt: new Date().toISOString(), logFile,
  };
}

/**
 * Reviews one pull request with the agent and builds its stored record.
 *
 * @param location - Repo coordinates of the PR
 * @param title - PR title, for logs and the dashboard card
 * @param htmlUrl - The PR's web url, handed to the agent and stored
 * @param skill - The review skill, used as the agent's system prompt
 * @param username - Login whose review state and responsibility date to read
 * @param triggerType - Why this PR is the user's responsibility
 * @param orchLog - Appends a line to the orchestration log
 * @returns The review record, with reviewStatus "failed" if anything went wrong
 */
async function reviewPR(
  location: PRLocation,
  title: string,
  htmlUrl: string,
  skill: string,
  username: string,
  triggerType: TriggerType,
  orchLog: (msg: string) => void
): Promise<PRReview> {
  const { owner, repo, pullNumber } = location;
  const id          = `${owner}/${repo}#${pullNumber}`;
  const logFilename = `${owner}-${repo}-${pullNumber}.log`;
  const logPath     = path.join(PR_LOGS_PATH, logFilename);
  const logFile     = `logs/reviews/${logFilename}`; // relative path stored in reviews.json

  orchLog(`  🤖  Reviewing PR #${pullNumber} in ${owner}/${repo}: "${title}"`);
  console.log(`  🤖  Reviewing PR #${pullNumber} in ${owner}/${repo}: "${title}"`);

  try {
    const [files, details, reviewState, reviewRequestedAt] = await Promise.all([
      getPRFiles(octokit, owner, repo, pullNumber),
      getPRDetails(octokit, owner, repo, pullNumber),
      getMyReviewState(octokit, owner, repo, pullNumber, username),
      getReviewRequestedAt(octokit, owner, repo, pullNumber, username, triggerType),
    ]);

    const feedback = await runWithClaudeCode(skill, htmlUrl, logPath, orchLog);
    console.log(`  ✅  PR #${pullNumber} review complete.`);

    return {
      id, title, url: htmlUrl,
      repo: `${owner}/${repo}`, pull_number: pullNumber,
      author: details.user?.login ?? "unknown",
      branch: `${details.head.ref} → ${details.base.ref}`,
      filesChanged: files.length,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      feedback, reviewState, reviewStatus: "success", prStatus: "open",
      lastReviewSubmittedAt: null, newCommits: [], commitsSeenAt: null,
      // A freshly generated review is by definition current, so both SHAs match
      reviewedHeadSha: details.head.sha, currentHeadSha: details.head.sha, commitsSeenSha: null,
      prCreatedAt: details.created_at, reviewRequestedAt, triggerType, reviewedAt: new Date().toISOString(), logFile,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ❌  Failed to review PR #${pullNumber}: ${message}`);

    let author = "unknown", branch = "", filesChanged = 0, additions = 0, deletions = 0;
    let prCreatedAt = new Date().toISOString();
    let reviewedHeadSha: string | null = null;
    try {
      const [files, details] = await Promise.all([
        getPRFiles(octokit, owner, repo, pullNumber),
        getPRDetails(octokit, owner, repo, pullNumber),
      ]);
      author       = details.user?.login ?? "unknown";
      branch       = `${details.head.ref} → ${details.base.ref}`;
      filesChanged = files.length;
      additions    = files.reduce((s, f) => s + f.additions, 0);
      deletions    = files.reduce((s, f) => s + f.deletions, 0);
      prCreatedAt  = details.created_at;
      reviewedHeadSha = details.head.sha;
    } catch { /* best effort */ }

    return {
      id, title, url: htmlUrl,
      repo: `${owner}/${repo}`, pull_number: pullNumber,
      author, branch, filesChanged, additions, deletions,
      feedback: "", reviewState: "PENDING", reviewStatus: "failed", prStatus: "open",
      lastReviewSubmittedAt: null, newCommits: [], commitsSeenAt: null,
      reviewedHeadSha, currentHeadSha: reviewedHeadSha, commitsSeenSha: null,
      prCreatedAt, reviewRequestedAt: null, triggerType, reviewedAt: new Date().toISOString(), logFile,
    };
  }
}

// ── Single-PR mode ────────────────────────────────────────────────────────────

/**
 * Reviews one pull request named on the command line.
 *
 * Bypasses both the tier search and the unchanged-head skip. The skip bypass is
 * deliberate: naming a PR by url is an explicit request for fresh findings,
 * which may be wanted because the review skill changed rather than because the
 * PR itself moved.
 *
 * @param prUrl - A github.com pull request url
 * @param skill - The review skill, used as the agent's system prompt
 * @param username - Authenticated login
 * @param orchLogPath - Path to this run's orchestration log, for failure notices
 * @param orchLog - Appends a line to the orchestration log
 * @param tee - Writes to both the console and the orchestration log
 */
async function reviewSinglePR(
  prUrl: string,
  skill: string,
  username: string,
  orchLogPath: string,
  orchLog: (msg: string) => void,
  tee: (msg: string) => void
): Promise<void> {
  // Validate the argument before spending anything on it
  const location = parsePRUrl(prUrl);
  const isPRUrl = location !== null;
  if (!isPRUrl) {
    tee(`❌  Not a GitHub pull request url: ${prUrl}`);
    tee(`    Expected: https://github.com/<owner>/<repo>/pull/<number>`);
    process.exit(1);
  }

  const id = `${location.owner}/${location.repo}#${location.pullNumber}`;
  const prior = loadReviews().find((review) => review.id === id) ?? null;

  // Classification can only strengthen, so an already-reviewed PR does not get
  // demoted just because GitHub cleared its review request
  const triggerType = await resolveTriggerType(octokit, location, username, prior?.triggerType ?? null);

  tee(`\n📋  Reviewing ${id} only — skipping the tier search and the unchanged-head check.`);
  tee(`    Tier: ${triggerType}${prior === null ? " (new to the dashboard)" : ""}\n`);

  const details = await getPRDetails(octokit, location.owner, location.repo, location.pullNumber);
  const result = await reviewPR(location, details.title, details.html_url, skill, username, triggerType, orchLog);

  const { merged } = mergeReviews(loadReviews(), [result]);
  saveReviews(merged);
  tee(`💾  Result saved.`);

  const didSucceed = result.reviewStatus === "success";
  if (didSucceed) {
    notify("PR Review Agent", `Re-reviewed ${id}`);
    tee(`\n=== Run complete: ${new Date().toISOString()}`);
    console.log("\nDone! Open http://localhost:3000/dashboard/ to view the dashboard.");
    return;
  }

  notifyFailure(1, orchLogPath);
  tee(`\n❌  Review failed for ${id} — see ${result.logFile}`);
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { logPath: orchLogPath, log: orchLog } = createOrchestrationLog();
  cleanupOldLogs();

  // Clean up any orphaned .tmp file left by a previous run killed mid-write
  const tmpPath = RESULTS_PATH + ".tmp";
  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  const tee = (msg: string) => { console.log(msg); orchLog(msg); };

  tee("🚀  PR Review Agent starting...");
  tee(`📋  Log: ${orchLogPath}\n`);

  // ── Pre-flight checks ──────────────────────────────────────────────────────
  try {
    preflight(tee);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tee(`❌  Pre-flight failed: ${message}`);
    notify("PR Review Agent — Pre-flight Failed", message.split("\n")[0]);
    process.exit(1);
  }

  // ── Fetch skill with retry ─────────────────────────────────────────────────
  tee(`📥  Fetching review skill from ${reviewSkillUrl} ...`);
  let skill: string;
  try {
    skill = await fetchSkillWithRetry();
    tee(`    Loaded ${skill.length} characters.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tee(`❌  ${message}`);
    notify("PR Review Agent — Skill Fetch Failed", message.split("\n")[0]);
    process.exit(1);
  }

  const username = await getAuthenticatedUsername(octokit);
  tee(`👤  Authenticated as ${username}`);

  // A PR url as the first argument narrows the whole run to that one PR
  const requestedPRUrl = process.argv[2] ?? null;
  const isSinglePRRun = requestedPRUrl !== null;
  if (isSinglePRRun) {
    await reviewSinglePR(requestedPRUrl, skill, username, orchLogPath, orchLog, tee);
    return;
  }

  const repoConfig = {
    reviewRequestedRepos: REVIEW_REQUESTED_REPOS.split(",").map(r => r.trim()).filter(Boolean),
    assigneeRepos: REVIEW_ASSIGNEE_REPOS.split(",").map(r => r.trim()).filter(Boolean),
  };
  tee(`📦  Review-requested repos: ${repoConfig.reviewRequestedRepos.join(", ") || "none"}`);
  tee(`📦  Assignee repos: ${repoConfig.assigneeRepos.join(", ") || "none"}`);

  // ── Step 1: refresh status of all existing reviews ────────────────────────
  const existing = loadReviews();
  if (existing.length > 0) {
    tee(`\n🔄  Refreshing status of ${existing.length} existing review(s)...`);
    const statusMap    = await refreshPRStatuses(octokit, existing);
    const refreshed    = applyStatusUpdates(existing, statusMap);
    const mergedClosed = refreshed.filter(r => r.prStatus !== "open").length;
    if (mergedClosed > 0) tee(`    ${mergedClosed} PR(s) are now merged or closed.`);
    saveReviews(refreshed);
  }

  // ── Step 2: find PRs needing review ───────────────────────────────────────
  tee(`\n🔍  Searching for PRs that are ${username}'s responsibility...`);
  const candidates = await getPRsNeedingReview(octokit, username, repoConfig);
  tee(`    Found ${candidates.length} PR(s) across all tiers.`);

  // Record why each PR was picked up, since the tier decides which date counts
  // as "since when" and that is otherwise invisible after the fact
  for (const candidate of candidates) {
    orchLog(`    [${candidate.triggerType}] ${candidate.item.html_url}`);
  }

  if (candidates.length === 0) {
    tee("\n✅  No new PRs to review.");
    tee("Done! Open http://localhost:3000/dashboard/ to view the dashboard.");
    process.exit(0);
  }

  // ── Step 3: drop PRs that have not moved since their last successful review ──
  tee(`\n🔎  Checking which of those actually need another run...`);
  const priorById = new Map(loadReviews().map((review) => [review.id, review]));

  const assessed = await Promise.all(candidates.map(async (candidate) => {
    const location = parsePRLocation(candidate.item);

    // An unparseable url cannot be checked, so let reviewPR record it as failed
    const hasLocation = location !== null;
    if (!hasLocation) {
      return { candidate, location: null, decision: { shouldReview: true, reason: "could not parse the PR url" } };
    }

    const id = `${location.owner}/${location.repo}#${location.pullNumber}`;
    const decision = await decideWhetherToReview(octokit, location, priorById.get(id) ?? null);
    return { candidate, location, decision };
  }));

  for (const { candidate, decision } of assessed) {
    orchLog(`    ${decision.shouldReview ? "review" : "skip  "} ${candidate.item.html_url} — ${decision.reason}`);
  }

  const toReview = assessed.filter((entry) => entry.decision.shouldReview);
  const skippedCount = assessed.length - toReview.length;
  if (skippedCount > 0) {
    tee(`    Skipping ${skippedCount} PR(s) unchanged since their last review.`);
  }

  if (toReview.length === 0) {
    tee("\n✅  Every PR is already reviewed at its current head — nothing to run.");
    tee("Done! Open http://localhost:3000/dashboard/ to view the dashboard.");
    process.exit(0);
  }

  // ── Step 4: review each remaining PR in parallel via Claude Code ──────────
  tee(`\n📋  Reviewing ${toReview.length} PR(s) in parallel via Claude Code...\n`);

  // A PR whose url would not parse cannot be reviewed, but still gets a record
  const reviewable  = toReview.filter((entry) => entry.location !== null);
  const unreviewable = toReview.filter((entry) => entry.location === null);

  const reviewed = await Promise.all(reviewable.map((entry) => reviewPR(
    entry.location!,
    entry.candidate.item.title ?? "",
    entry.candidate.item.html_url,
    skill, username, entry.candidate.triggerType, orchLog
  )));

  const results = [
    ...reviewed,
    ...unreviewable.map((entry) => buildUnreviewableRecord(entry.candidate.item, orchLog)),
  ];
  const succeeded = results.filter(r => r.reviewStatus === "success").length;
  const failed    = results.filter(r => r.reviewStatus === "failed").length;

  tee(`\n✅  Completed: ${succeeded} succeeded, ${failed} failed.`);

  // ── Step 5: merge and save ─────────────────────────────────────────────────
  const currentReviews = loadReviews();
  const { merged, newCount, updatedCount } = mergeReviews(currentReviews, results);
  saveReviews(merged);
  tee(`💾  Results saved.`);

  // ── Step 6: notify ─────────────────────────────────────────────────────────
  const summary = buildNotificationSummary(newCount, updatedCount);
  if (summary) {
    notify("PR Review Agent", summary);
    tee(`🔔  Notification sent: ${summary}`);
  }

  if (failed > 0) {
    notifyFailure(failed, orchLogPath);
    tee(`🔔  Failure notification sent: ${failed} failed.`);
  }

  tee(`\n=== Run complete: ${new Date().toISOString()}`);
  console.log("\nDone! Open http://localhost:3000/dashboard/ to view the dashboard.");
}

main().catch((err: unknown) => {
  console.error("💥  Unexpected error:", err);
  process.exit(1);
});
