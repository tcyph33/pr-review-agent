#!/usr/bin/env npx tsx

import "dotenv/config";
import { execSync } from "child_process";
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
} from "./lib/github.js";
import type { SearchPRItem } from "./lib/github.js";
import {
  loadReviews,
  saveReviews,
  mergeReviews,
  applyStatusUpdates,
  writeReviewLog,
  rotateLogIfNeeded,
  RESULTS_PATH,
} from "./lib/storage.js";
import type { PRReview } from "./lib/storage.js";
import { notify, buildNotificationSummary } from "./lib/notify.js";

// ── Config ────────────────────────────────────────────────────────────────────

const GITHUB_TOKEN     = process.env.GITHUB_TOKEN;
const REVIEW_SKILL_URL = process.env.REVIEW_SKILL_URL;

const missing = (
  [
    ["GITHUB_TOKEN",      GITHUB_TOKEN],
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

const githubToken    = GITHUB_TOKEN!;
const reviewSkillUrl = REVIEW_SKILL_URL!;

// ── Paths ─────────────────────────────────────────────────────────────────────

const __dirname  = path.dirname(new URL(import.meta.url).pathname);
const LOGS_OUT   = path.join(__dirname, "logs", "out.log");
const LOGS_ERR   = path.join(__dirname, "logs", "err.log");

// ── Clients ───────────────────────────────────────────────────────────────────

const octokit = createOctokit(githubToken);

// ── Skill fetcher ─────────────────────────────────────────────────────────────

async function fetchSkill(): Promise<string> {
  console.log(`📥  Fetching review skill from ${reviewSkillUrl} ...`);
  const res = await fetch(reviewSkillUrl, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/vnd.github.raw",
    },
  });
  if (!res.ok) {
    console.error(`❌  Failed to fetch skill: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const text = await res.text();
  console.log(`    Loaded ${text.length} characters.`);
  return text;
}

// ── Claude Code runner ────────────────────────────────────────────────────────

function runWithClaudeCode(skill: string, prUrl: string, logPath: string): string {
  const skillPath = path.join(os.tmpdir(), "pr-review-skill.md");
  fs.writeFileSync(skillPath, skill, "utf8");

  const message = `/code-review ${prUrl}`;
  const header  = `=== PR Review: ${prUrl}\n=== Started: ${new Date().toISOString()}\n\n`;

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, header, "utf8");

  try {
    const output = execSync(
      `claude --print --system-prompt "$(cat '${skillPath}')" "${message}"`,
      {
        encoding: "utf8",
        timeout: 30 * 60 * 1000,    // 30 minute timeout per PR
        maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
      }
    );
    const result = output.trim();
    fs.appendFileSync(logPath, result + `\n\n=== Completed: ${new Date().toISOString()}\n`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fs.appendFileSync(logPath, `\n=== FAILED: ${new Date().toISOString()}\n${message}\n`);
    throw new Error(`Claude Code failed: ${message}`);
  }
}

// ── Per-PR review ─────────────────────────────────────────────────────────────

async function reviewPR(
  pr: SearchPRItem,
  skill: string,
  username: string
): Promise<PRReview> {
  const prUrl = pr.pull_request?.url;
  const match = prUrl?.match(/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);

  // Build a minimal failed card if we can't even parse the PR
  if (!prUrl || !match) {
    const id = `unknown#${pr.number}`;
    const logFile = writeReviewLog(id, `Could not parse PR URL: ${prUrl ?? "undefined"}\n`);
    console.warn(`  ⚠️  Could not parse PR info: ${pr.html_url}`);
    return {
      id,
      title:        pr.title ?? "Unknown PR",
      url:          pr.html_url,
      repo:         "unknown",
      pull_number:  pr.number,
      author:       "unknown",
      branch:       "",
      filesChanged: 0,
      additions:    0,
      deletions:    0,
      feedback:     "",
      reviewState:  "PENDING",
      reviewStatus: "failed",
      prStatus:     "open",
      prCreatedAt:  new Date().toISOString(),
      reviewedAt:   new Date().toISOString(),
      logFile,
    };
  }

  const owner      = match[1];
  const repo       = match[2];
  const pullNumber = parseInt(match[3], 10);
  const id         = `${owner}/${repo}#${pullNumber}`;
  const logPath    = path.join(__dirname, "logs", "reviews", `${owner}-${repo}-${pullNumber}.log`);

  console.log(`  🤖  Reviewing PR #${pullNumber} in ${owner}/${repo}: "${pr.title}"`);

  try {
    const [files, details, reviewState] = await Promise.all([
      getPRFiles(octokit, owner, repo, pullNumber),
      getPRDetails(octokit, owner, repo, pullNumber),
      getMyReviewState(octokit, owner, repo, pullNumber, username),
    ]);

    const feedback = runWithClaudeCode(skill, pr.html_url, logPath);
    const logFile  = path.relative(__dirname, logPath);

    console.log(`  ✅  PR #${pullNumber} review complete.`);

    return {
      id,
      title:        pr.title ?? "",
      url:          pr.html_url,
      repo:         `${owner}/${repo}`,
      pull_number:  pullNumber,
      author:       details.user?.login ?? "unknown",
      branch:       `${details.head.ref} → ${details.base.ref}`,
      filesChanged: files.length,
      additions:    files.reduce((s, f) => s + f.additions, 0),
      deletions:    files.reduce((s, f) => s + f.deletions, 0),
      feedback,
      reviewState,
      reviewStatus: "success",
      prStatus:     "open",
      prCreatedAt:  details.created_at,
      reviewedAt:   new Date().toISOString(),
      logFile,
    };
  } catch (err) {
    const message  = err instanceof Error ? err.message : String(err);
    const logFile  = path.relative(__dirname, logPath);
    console.error(`  ❌  Failed to review PR #${pullNumber}: ${message}`);

    // Fetch what metadata we can for the failed card
    let author = "unknown", branch = "", filesChanged = 0, additions = 0, deletions = 0, prCreatedAt = new Date().toISOString();
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
    } catch {
      // best effort — leave defaults if metadata fetch also fails
    }

    return {
      id,
      title:        pr.title ?? "",
      url:          pr.html_url,
      repo:         `${owner}/${repo}`,
      pull_number:  pullNumber,
      author,
      branch,
      filesChanged,
      additions,
      deletions,
      feedback:     "",
      reviewState:  "PENDING",
      reviewStatus: "failed",
      prStatus:     "open",
      prCreatedAt,
      reviewedAt:   new Date().toISOString(),
      logFile,
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🚀  PR Review Agent starting...\n");

  // Rotate orchestrator logs if they've grown large
  rotateLogIfNeeded(LOGS_OUT);
  rotateLogIfNeeded(LOGS_ERR);

  const skill    = await fetchSkill();
  const username = await getAuthenticatedUsername(octokit);

  // ── Step 1: refresh status of all existing reviews ──────────────────────────
  const existing = loadReviews();
  if (existing.length > 0) {
    console.log(`\n🔄  Refreshing status of ${existing.length} existing review(s)...`);
    const statusMap    = await refreshPRStatuses(octokit, existing);
    const refreshed    = applyStatusUpdates(existing, statusMap);
    const mergedClosed = refreshed.filter(r => r.prStatus !== "open").length;
    if (mergedClosed > 0) {
      console.log(`    ${mergedClosed} PR(s) are now merged or closed.`);
    }
    saveReviews(refreshed);
  }

  // ── Step 2: find PRs needing review ──────────────────────────────────────────
  console.log(`\n🔍  Searching for PRs requesting review from ${username}...`);
  const prs = await getPRsNeedingReview(octokit, username);
  console.log(`    Found ${prs.length} PR(s) needing review.`);

  if (prs.length === 0) {
    console.log("\n✅  No new PRs to review.");
    console.log("Done! Open http://localhost:3000/dashboard/ to view the dashboard.");
    process.exit(0);
  }

  // ── Step 3: review each PR in parallel via Claude Code ───────────────────────
  // Each invocation clones to ~/PR-Reviews/<repo>-<number> — unique per PR,
  // so parallel runs are safe with no shared state or filesystem conflicts.
  console.log(`\n📋  Reviewing ${prs.length} PR(s) in parallel via Claude Code...\n`);

  const results = await Promise.all(prs.map((pr) => reviewPR(pr, skill, username)));
  const succeeded = results.filter(r => r.reviewStatus === "success").length;
  const failed    = results.filter(r => r.reviewStatus === "failed").length;

  console.log(`\n✅  Completed: ${succeeded} succeeded, ${failed} failed.`);

  // ── Step 4: merge and save (including failed cards) ──────────────────────────
  const currentReviews = loadReviews();
  const { merged, newCount, updatedCount } = mergeReviews(currentReviews, results);
  saveReviews(merged);
  console.log(`💾  Results saved.`);

  // ── Step 5: notify ───────────────────────────────────────────────────────────
  const summary = buildNotificationSummary(newCount, updatedCount);
  if (summary) {
    notify("PR Review Agent", summary);
    console.log(`🔔  Notification sent: ${summary}`);
  }

  console.log("\nDone! Open http://localhost:3000/dashboard/ to view the dashboard.");
}

main().catch((err: unknown) => {
  console.error("💥  Unexpected error:", err);
  process.exit(1);
});
