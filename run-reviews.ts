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
import { loadReviews, saveReviews, mergeReviews, applyStatusUpdates } from "./lib/storage.js";
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

function runWithClaudeCode(skill: string, prUrl: string): string {
  const skillPath = path.join(os.tmpdir(), "pr-review-skill.md");
  fs.writeFileSync(skillPath, skill, "utf8");

  const message = `/code-review ${prUrl}`;

  try {
    const output = execSync(
      `claude --print --system-prompt "$(cat '${skillPath}')" "${message}"`,
      {
        encoding: "utf8",
        timeout: 10 * 60 * 1000, // 10 minute timeout per PR
        maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
      }
    );
    return output.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Claude Code failed: ${message}`);
  }
}

// ── Per-PR review ─────────────────────────────────────────────────────────────

async function reviewPR(
  pr: SearchPRItem,
  skill: string,
  username: string
): Promise<PRReview | null> {
  const prUrl = pr.pull_request?.url;
  if (!prUrl) {
    console.warn(`  ⚠️  No pull_request URL for: ${pr.html_url}`);
    return null;
  }

  const match = prUrl.match(/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);
  if (!match) {
    console.warn(`  ⚠️  Could not parse repo info for PR: ${pr.html_url}`);
    return null;
  }

  const owner      = match[1];
  const repo       = match[2];
  const pullNumber = parseInt(match[3], 10);

  console.log(`  🤖  Reviewing PR #${pullNumber} in ${owner}/${repo}: "${pr.title}"`);

  try {
    const [files, details, reviewState] = await Promise.all([
      getPRFiles(octokit, owner, repo, pullNumber),
      getPRDetails(octokit, owner, repo, pullNumber),
      getMyReviewState(octokit, owner, repo, pullNumber, username),
    ]);

    const feedback = runWithClaudeCode(skill, pr.html_url);

    return {
      id:           `${owner}/${repo}#${pullNumber}`,
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
      prStatus:     "open",
      prCreatedAt:  details.created_at,
      reviewedAt:   new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ❌  Failed to review PR #${pullNumber}: ${message}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🚀  PR Review Agent starting...\n");

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

  // ── Step 3: review each PR via Claude Code ───────────────────────────────────
  // Note: reviews run sequentially, not in parallel, because each Claude Code
  // invocation clones a repo and runs gh commands — parallel runs risk git/gh
  // conflicts and excessive disk usage.
  console.log(`\n📋  Reviewing ${prs.length} PR(s) via Claude Code...\n`);

  const successful: PRReview[] = [];
  for (const pr of prs) {
    const result = await reviewPR(pr, skill, username);
    if (result) successful.push(result);
  }

  console.log(`\n✅  Completed ${successful.length}/${prs.length} reviews.`);

  // ── Step 4: merge and save ───────────────────────────────────────────────────
  const currentReviews = loadReviews();
  const { merged, newCount, updatedCount } = mergeReviews(currentReviews, successful);
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
