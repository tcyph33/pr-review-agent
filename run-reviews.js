#!/usr/bin/env node

import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const GITHUB_USERNAME    = process.env.GITHUB_USERNAME || "<your_gh_username>";
const REVIEW_SKILL_URL   = process.env.REVIEW_SKILL_URL; // raw GitHub URL to your skill .md
const RESULTS_PATH       = path.join(__dirname, "results", "reviews.json");

if (!GITHUB_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("❌  Missing GITHUB_TOKEN or ANTHROPIC_API_KEY in environment.");
  console.error("    Copy .env.example to .env and fill in your keys.");
  process.exit(1);
}

if (!REVIEW_SKILL_URL) {
  console.error("❌  Missing REVIEW_SKILL_URL in environment.");
  console.error("    Set it to the raw GitHub URL of your review skill .md file.");
  console.error("    e.g. https://raw.githubusercontent.com/you/skills-repo/main/pr-review.md");
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

const octokit   = new Octokit({ auth: GITHUB_TOKEN });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchReviewSkill() {
  console.log(`📥  Fetching review skill from ${REVIEW_SKILL_URL} ...`);
  const res = await fetch(REVIEW_SKILL_URL, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.raw",
    },
  });
  if (!res.ok) {
    console.error(`❌  Failed to fetch review skill: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const text = await res.text();
  console.log(`    Loaded ${text.length} characters.`);
  return text;
}

async function getPRsNeedingReview() {
  console.log(`\n🔍  Searching for PRs requesting review from ${GITHUB_USERNAME}...`);
  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `is:pr is:open review-requested:${GITHUB_USERNAME}`,
    per_page: 50,
  });
  console.log(`    Found ${data.items.length} PR(s) needing review.`);
  return data.items;
}

async function getPRDiff(owner, repo, pull_number) {
  const { data } = await octokit.rest.pulls.get({
    owner, repo, pull_number,
    mediaType: { format: "diff" },
  });
  return data;
}

async function getPRDetails(owner, repo, pull_number) {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number });
  return data;
}

async function getPRFiles(owner, repo, pull_number) {
  const { data } = await octokit.rest.pulls.listFiles({
    owner, repo, pull_number,
    per_page: 100,
  });
  return data;
}

function parseRepoFromUrl(url) {
  const match = url.match(/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], pull_number: parseInt(match[3]) };
}

async function reviewPR(pr, reviewSkill) {
  const parsed = parseRepoFromUrl(pr.pull_request.url);
  if (!parsed) {
    console.warn(`  ⚠️  Could not parse repo info for PR: ${pr.html_url}`);
    return null;
  }

  const { owner, repo, pull_number } = parsed;
  console.log(`  🤖  Reviewing PR #${pull_number} in ${owner}/${repo}: "${pr.title}"`);

  let diff, files, details;
  try {
    [diff, files, details] = await Promise.all([
      getPRDiff(owner, repo, pull_number),
      getPRFiles(owner, repo, pull_number),
      getPRDetails(owner, repo, pull_number),
    ]);
  } catch (err) {
    console.error(`  ❌  Failed to fetch PR data for #${pull_number}: ${err.message}`);
    return null;
  }

  const fileList = files
    .map((f) => `- ${f.filename} (+${f.additions} -${f.deletions})`)
    .join("\n");

  const userMessage = `
## Pull Request: ${pr.title}
**Repo:** ${owner}/${repo}
**PR #${pull_number}**
**Author:** ${details.user.login}
**Branch:** \`${details.head.ref}\` → \`${details.base.ref}\`
**Description:**
${details.body || "_No description provided._"}

## Files Changed
${fileList}

## Diff
\`\`\`diff
${typeof diff === "string" ? diff.slice(0, 20000) : JSON.stringify(diff).slice(0, 20000)}
\`\`\`
`.trim();

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: reviewSkill,
    messages: [{ role: "user", content: userMessage }],
  });

  const feedback = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return {
    id: `${owner}/${repo}#${pull_number}`,
    title: pr.title,
    url: pr.html_url,
    repo: `${owner}/${repo}`,
    pull_number,
    author: details.user.login,
    branch: `${details.head.ref} → ${details.base.ref}`,
    filesChanged: files.length,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    feedback,
    reviewedAt: new Date().toISOString(),
  };
}

function saveResults(reviews) {
  const dir = path.dirname(RESULTS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let existing = {};
  if (fs.existsSync(RESULTS_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
      existing = Object.fromEntries(raw.map((r) => [r.id, r]));
    } catch {
      // corrupt file — start fresh
    }
  }

  for (const review of reviews) {
    existing[review.id] = review;
  }

  const sorted = Object.values(existing).sort(
    (a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt)
  );

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(sorted, null, 2));
  console.log(`\n💾  Results saved to ${RESULTS_PATH}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀  PR Review Agent starting...\n");

  const reviewSkill = await fetchReviewSkill();
  const prs = await getPRsNeedingReview();

  if (prs.length === 0) {
    console.log("\n✅  No PRs needing review. All clear!");
    process.exit(0);
  }

  console.log(`\n📋  Reviewing ${prs.length} PR(s) in parallel...\n`);

  const results = await Promise.all(prs.map((pr) => reviewPR(pr, reviewSkill)));
  const successful = results.filter(Boolean);

  console.log(`\n✅  Completed ${successful.length}/${prs.length} reviews.`);

  saveResults(successful);

  console.log("\nDone! Open http://localhost:3000 to view the dashboard.");
}

main().catch((err) => {
  console.error("💥  Unexpected error:", err);
  process.exit(1);
});
