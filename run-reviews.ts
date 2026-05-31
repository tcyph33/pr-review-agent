#!/usr/bin/env npx tsx

import "dotenv/config";
import { createOctokit, getAuthenticatedUsername, getPRsNeedingReview, getPRDiff, getPRDetails, getPRFiles, getMyReviewState, refreshPRStatuses } from "./lib/github.js";
import type { SearchPRItem } from "./lib/github.js";
import { createAnthropic, fetchReviewSkill, reviewPRWithClaude } from "./lib/claude.js";
import { loadReviews, saveReviews, mergeReviews, applyStatusUpdates } from "./lib/storage.js";
import type { PRReview } from "./lib/storage.js";
import { notify, buildNotificationSummary } from "./lib/notify.js";

// ── Config ────────────────────────────────────────────────────────────────────

const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const REVIEW_SKILL_URL  = process.env.REVIEW_SKILL_URL;

const missing = (
  [
    ["GITHUB_TOKEN",      GITHUB_TOKEN],
    ["ANTHROPIC_API_KEY", ANTHROPIC_API_KEY],
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

const githubToken     = GITHUB_TOKEN!;
const anthropicApiKey = ANTHROPIC_API_KEY!;
const reviewSkillUrl  = REVIEW_SKILL_URL!;

// ── Clients ───────────────────────────────────────────────────────────────────

const octokit   = createOctokit(githubToken);
const anthropic = createAnthropic(anthropicApiKey);

// ── Per-PR review ─────────────────────────────────────────────────────────────

async function reviewPR(
  pr: SearchPRItem,
  reviewSkill: string,
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
    const [diff, files, details, reviewState] = await Promise.all([
      getPRDiff(octokit, owner, repo, pullNumber),
      getPRFiles(octokit, owner, repo, pullNumber),
      getPRDetails(octokit, owner, repo, pullNumber),
      getMyReviewState(octokit, owner, repo, pullNumber, username),
    ]);

    const feedback = await reviewPRWithClaude(
      anthropic, reviewSkill, pr, owner, repo, pullNumber, details, files, diff
    );

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

  const reviewSkill = await fetchReviewSkill(reviewSkillUrl, githubToken);
  const username    = await getAuthenticatedUsername(octokit);

  // ── Step 1: refresh status of all existing reviews ──────────────────────────
  const existing = loadReviews();
  if (existing.length > 0) {
    console.log(`\n🔄  Refreshing status of ${existing.length} existing review(s)...`);
    const statusMap = await refreshPRStatuses(octokit, existing);
    const refreshed = applyStatusUpdates(existing, statusMap);
    const mergedClosed = refreshed.filter(r => r.prStatus !== "open").length;
    if (mergedClosed > 0) {
      console.log(`    ${mergedClosed} PR(s) are now merged or closed.`);
    }
    saveReviews(refreshed);
  }

  // ── Step 2: find and review new/updated PRs ──────────────────────────────────
  console.log(`\n🔍  Searching for PRs requesting review from ${username}...`);
  const prs = await getPRsNeedingReview(octokit, username);
  console.log(`    Found ${prs.length} PR(s) needing review.`);

  if (prs.length === 0) {
    console.log("\n✅  No new PRs to review.");
    console.log("Done! Open http://localhost:3000/dashboard/ to view the dashboard.");
    process.exit(0);
  }

  console.log(`\n📋  Reviewing ${prs.length} PR(s) in parallel...\n`);

  const results    = await Promise.all(prs.map((pr) => reviewPR(pr, reviewSkill, username)));
  const successful = results.filter((r): r is PRReview => r !== null);

  console.log(`\n✅  Completed ${successful.length}/${prs.length} reviews.`);

  // ── Step 3: merge and save ───────────────────────────────────────────────────
  const currentReviews = loadReviews();
  const { merged, newCount, updatedCount } = mergeReviews(currentReviews, successful);
  saveReviews(merged);
  console.log(`💾  Results saved.`);

  // ── Step 4: notify ───────────────────────────────────────────────────────────
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
