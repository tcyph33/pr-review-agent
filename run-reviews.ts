#!/usr/bin/env npx tsx

import "dotenv/config";
import { execSync, execFileSync } from "child_process";
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
  refreshPRStatuses,
} from "./lib/github.ts";
import type { SearchPRItem } from "./lib/github.ts";
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

const GITHUB_API_TOKEN     = process.env.GITHUB_API_TOKEN;
const REVIEW_SKILL_URL = process.env.REVIEW_SKILL_URL;

const missing = (
  [
    ["GITHUB_API_TOKEN",      GITHUB_API_TOKEN],
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
      const res = await fetch(reviewSkillUrl, {
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: "application/vnd.github.json",
        },
      });
      console.log(`    Response status: ${res.status} ${res.statusText}`);
      if (!res.ok) {
        const body = await res.text();
        console.log(`    Response body: ${body.slice(0, 200)}`);
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const json = await res.json() as { content?: string; message?: string };
      if (!json.content) {
        throw new Error(`Unexpected response — no content field: ${JSON.stringify(json).slice(0, 200)}`);
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

function runWithClaudeCode(
  skill: string,
  prUrl: string,
  logPath: string,
  orchLog: (msg: string) => void
): string {
  const skillPath = path.join(os.tmpdir(), "pr-review-skill.md");
  fs.writeFileSync(skillPath, skill, "utf8");

  const header = `=== PR Review: ${prUrl}\n=== Started: ${new Date().toISOString()}\n\n`;
  if (!fs.existsSync(path.dirname(logPath))) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  }
  fs.writeFileSync(logPath, header, "utf8");

  try {
    const output = execSync(
      `claude --print --system-prompt "$(cat '${skillPath}')" "/code-review ${prUrl}"`,
      {
        encoding: "utf8",
        timeout: 30 * 60 * 1000,     // 30 minute timeout per PR
        maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
      }
    );
    const result = output.trim();
    fs.appendFileSync(logPath, result + `\n\n=== Completed: ${new Date().toISOString()}\n`);
    orchLog(`  ✅  Completed: ${prUrl}`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fs.appendFileSync(logPath, `\n=== FAILED: ${new Date().toISOString()}\n${message}\n`);
    orchLog(`  ❌  Failed: ${prUrl} — ${message}`);
    throw new Error(`Claude Code failed: ${message}`);
  }
}

// ── Per-PR review ─────────────────────────────────────────────────────────────

async function reviewPR(
  pr: SearchPRItem,
  skill: string,
  username: string,
  orchLog: (msg: string) => void
): Promise<PRReview> {
  const prUrl = pr.pull_request?.url;
  const match = prUrl?.match(/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);

  if (!prUrl || !match) {
    const id      = `unknown#${pr.number}`;
    const logFile = `logs/reviews/${id.replace(/\//g, "-").replace("#", "-")}.log`;
    const msg     = `Could not parse PR URL: ${prUrl ?? "undefined"}`;
    fs.mkdirSync(PR_LOGS_PATH, { recursive: true });
    fs.writeFileSync(path.join(PR_LOGS_PATH, `${id.replace(/\//g, "-").replace("#", "-")}.log`), msg + "\n", "utf8");
    orchLog(`  ⚠️  Could not parse PR info: ${pr.html_url}`);
    return {
      id, title: pr.title ?? "Unknown PR", url: pr.html_url,
      repo: "unknown", pull_number: pr.number, author: "unknown", branch: "",
      filesChanged: 0, additions: 0, deletions: 0, feedback: "",
      reviewState: "PENDING", reviewStatus: "failed", prStatus: "open",
      prCreatedAt: new Date().toISOString(), reviewedAt: new Date().toISOString(), logFile,
    };
  }

  const owner       = match[1];
  const repo        = match[2];
  const pullNumber  = parseInt(match[3], 10);
  const id          = `${owner}/${repo}#${pullNumber}`;
  const logFilename = `${owner}-${repo}-${pullNumber}.log`;
  const logPath     = path.join(PR_LOGS_PATH, logFilename);
  const logFile     = `logs/reviews/${logFilename}`;

  orchLog(`  🤖  Reviewing PR #${pullNumber} in ${owner}/${repo}: "${pr.title}"`);
  console.log(`  🤖  Reviewing PR #${pullNumber} in ${owner}/${repo}: "${pr.title}"`);

  try {
    const [files, details, reviewState] = await Promise.all([
      getPRFiles(octokit, owner, repo, pullNumber),
      getPRDetails(octokit, owner, repo, pullNumber),
      getMyReviewState(octokit, owner, repo, pullNumber, username),
    ]);

    const feedback = runWithClaudeCode(skill, pr.html_url, logPath, orchLog);
    console.log(`  ✅  PR #${pullNumber} review complete.`);

    return {
      id, title: pr.title ?? "", url: pr.html_url,
      repo: `${owner}/${repo}`, pull_number: pullNumber,
      author: details.user?.login ?? "unknown",
      branch: `${details.head.ref} → ${details.base.ref}`,
      filesChanged: files.length,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      feedback, reviewState, reviewStatus: "success", prStatus: "open",
      prCreatedAt: details.created_at, reviewedAt: new Date().toISOString(), logFile,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ❌  Failed to review PR #${pullNumber}: ${message}`);

    let author = "unknown", branch = "", filesChanged = 0, additions = 0, deletions = 0;
    let prCreatedAt = new Date().toISOString();
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
    } catch { /* best effort */ }

    return {
      id, title: pr.title ?? "", url: pr.html_url,
      repo: `${owner}/${repo}`, pull_number: pullNumber,
      author, branch, filesChanged, additions, deletions,
      feedback: "", reviewState: "PENDING", reviewStatus: "failed", prStatus: "open",
      prCreatedAt, reviewedAt: new Date().toISOString(), logFile,
    };
  }
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
  tee(`\n🔍  Searching for PRs requesting review from ${username}...`);
  const prs = await getPRsNeedingReview(octokit, username);
  tee(`    Found ${prs.length} PR(s) needing review.`);

  if (prs.length === 0) {
    tee("\n✅  No new PRs to review.");
    tee("Done! Open http://localhost:3000/dashboard/ to view the dashboard.");
    process.exit(0);
  }

  // ── Step 3: review each PR in parallel via Claude Code ────────────────────
  tee(`\n📋  Reviewing ${prs.length} PR(s) in parallel via Claude Code...\n`);

  const results   = await Promise.all(prs.map((pr) => reviewPR(pr, skill, username, orchLog)));
  const succeeded = results.filter(r => r.reviewStatus === "success").length;
  const failed    = results.filter(r => r.reviewStatus === "failed").length;

  tee(`\n✅  Completed: ${succeeded} succeeded, ${failed} failed.`);

  // ── Step 4: merge and save ─────────────────────────────────────────────────
  const currentReviews = loadReviews();
  const { merged, newCount, updatedCount } = mergeReviews(currentReviews, results);
  saveReviews(merged);
  tee(`💾  Results saved.`);

  // ── Step 5: notify ─────────────────────────────────────────────────────────
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
