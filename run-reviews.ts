#!/usr/bin/env npx tsx

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import type { RestEndpointMethodTypes } from "@octokit/rest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────────────────

interface PRReview {
  id: string;
  title: string;
  url: string;
  repo: string;
  pull_number: number;
  author: string;
  branch: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  feedback: string;
  prCreatedAt: string;
  reviewedAt: string;
}

interface ParsedRepo {
  owner: string;
  repo: string;
  pull_number: number;
}

type SearchPRItem =
  RestEndpointMethodTypes["search"]["issuesAndPullRequests"]["response"]["data"]["items"][number];

type PRDetails =
  RestEndpointMethodTypes["pulls"]["get"]["response"]["data"];

type PRFile =
  RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];

// ── Config ────────────────────────────────────────────────────────────────────

const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const REVIEW_SKILL_URL  = process.env.REVIEW_SKILL_URL;
const RESULTS_PATH      = path.join(__dirname, "results", "reviews.json");

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

// Safe to assert non-null after validation above
const githubToken      = GITHUB_TOKEN!;
const anthropicApiKey  = ANTHROPIC_API_KEY!;
const reviewSkillUrl   = REVIEW_SKILL_URL!;

// ── Clients ───────────────────────────────────────────────────────────────────

const octokit   = new Octokit({ auth: githubToken });
const anthropic = new Anthropic({ apiKey: anthropicApiKey });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchReviewSkill(): Promise<string> {
  console.log(`📥  Fetching review skill from ${reviewSkillUrl} ...`);
  const res = await fetch(reviewSkillUrl, {
    headers: {
      Authorization: `token ${githubToken}`,
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

async function getPRsNeedingReview(): Promise<SearchPRItem[]> {
  const { data: user } = await octokit.rest.users.getAuthenticated();
  const username = user.login;
  console.log(`\n🔍  Searching for PRs requesting review from ${username}...`);
  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `is:pr is:open review-requested:${username}`,
    per_page: 50,
  });
  console.log(`    Found ${data.items.length} PR(s) needing review.`);
  return data.items;
}

async function getPRDiff(owner: string, repo: string, pull_number: number): Promise<string> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  return data as unknown as string;
}

async function getPRDetails(owner: string, repo: string, pull_number: number): Promise<PRDetails> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number });
  return data;
}

async function getPRFiles(owner: string, repo: string, pull_number: number): Promise<PRFile[]> {
  const { data } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  return data;
}

function parseRepoFromUrl(url: string): ParsedRepo | null {
  const match = url.match(/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], pull_number: parseInt(match[3], 10) };
}

async function reviewPR(pr: SearchPRItem, reviewSkill: string): Promise<PRReview | null> {
  const prUrl = pr.pull_request?.url;
  if (!prUrl) {
    console.warn(`  ⚠️  No pull_request URL for: ${pr.html_url}`);
    return null;
  }

  const parsed = parseRepoFromUrl(prUrl);
  if (!parsed) {
    console.warn(`  ⚠️  Could not parse repo info for PR: ${pr.html_url}`);
    return null;
  }

  const { owner, repo, pull_number } = parsed;
  console.log(`  🤖  Reviewing PR #${pull_number} in ${owner}/${repo}: "${pr.title}"`);

  let diff: string;
  let files: PRFile[];
  let details: PRDetails;

  try {
    [diff, files, details] = await Promise.all([
      getPRDiff(owner, repo, pull_number),
      getPRFiles(owner, repo, pull_number),
      getPRDetails(owner, repo, pull_number),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ❌  Failed to fetch PR data for #${pull_number}: ${message}`);
    return null;
  }

  const fileList = files
    .map((f) => `- ${f.filename} (+${f.additions} -${f.deletions})`)
    .join("\n");

  const userMessage = `
## Pull Request: ${pr.title}
**Repo:** ${owner}/${repo}
**PR #${pull_number}**
**Author:** ${details.user?.login ?? "unknown"}
**Branch:** \`${details.head.ref}\` → \`${details.base.ref}\`
**Description:**
${details.body ?? "_No description provided._"}

## Files Changed
${fileList}

## Diff
\`\`\`diff
${diff.slice(0, 20000)}
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
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");

  return {
    id: `${owner}/${repo}#${pull_number}`,
    title: pr.title ?? "",
    url: pr.html_url,
    repo: `${owner}/${repo}`,
    pull_number,
    author: details.user?.login ?? "unknown",
    branch: `${details.head.ref} → ${details.base.ref}`,
    filesChanged: files.length,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    feedback,
    prCreatedAt: details.created_at,
    reviewedAt: new Date().toISOString(),
  };
}

function saveResults(reviews: PRReview[]): void {
  const dir = path.dirname(RESULTS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let existing: Record<string, PRReview> = {};
  if (fs.existsSync(RESULTS_PATH)) {
    try {
      const raw: PRReview[] = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
      existing = Object.fromEntries(raw.map((r) => [r.id, r]));
    } catch {
      // corrupt file — start fresh
    }
  }

  for (const review of reviews) {
    existing[review.id] = review;
  }

  const sorted = Object.values(existing).sort(
    (a, b) => new Date(b.reviewedAt).getTime() - new Date(a.reviewedAt).getTime()
  );

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(sorted, null, 2));
  console.log(`\n💾  Results saved to ${RESULTS_PATH}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🚀  PR Review Agent starting...\n");

  const reviewSkill = await fetchReviewSkill();
  const prs = await getPRsNeedingReview();

  if (prs.length === 0) {
    console.log("\n✅  No PRs needing review. All clear!");
    process.exit(0);
  }

  console.log(`\n📋  Reviewing ${prs.length} PR(s) in parallel...\n`);

  const results = await Promise.all(prs.map((pr) => reviewPR(pr, reviewSkill)));
  const successful = results.filter((r): r is PRReview => r !== null);

  console.log(`\n✅  Completed ${successful.length}/${prs.length} reviews.`);

  saveResults(successful);

  console.log("\nDone! Open http://localhost:3000/dashboard/ to view the dashboard.");
}

main().catch((err: unknown) => {
  console.error("💥  Unexpected error:", err);
  process.exit(1);
});
