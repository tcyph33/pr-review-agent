import { Octokit } from "@octokit/rest";
import type { RestEndpointMethodTypes } from "@octokit/rest";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReviewState = "PENDING" | "COMMENTED" | "CHANGES_REQUESTED" | "APPROVED";
export type PRStatus    = "open" | "merged" | "closed";

export interface ParsedRepo {
  owner: string;
  repo: string;
  pull_number: number;
}

export type SearchPRItem =
  RestEndpointMethodTypes["search"]["issuesAndPullRequests"]["response"]["data"]["items"][number];

export type PRDetails =
  RestEndpointMethodTypes["pulls"]["get"]["response"]["data"];

export type PRFile =
  RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];

// ── Client ────────────────────────────────────────────────────────────────────

export function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

// ── Functions ─────────────────────────────────────────────────────────────────

export function parseRepoFromUrl(url: string): ParsedRepo | null {
  const match = url.match(/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], pull_number: parseInt(match[3], 10) };
}

export async function getAuthenticatedUsername(octokit: Octokit): Promise<string> {
  const { data } = await octokit.rest.users.getAuthenticated();
  return data.login;
}

export async function getPRsNeedingReview(
  octokit: Octokit,
  username: string
): Promise<SearchPRItem[]> {
  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `is:pr is:open review-requested:${username}`,
    per_page: 50,
  });
  return data.items;
}

export async function getPRDetails(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number
): Promise<PRDetails> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number });
  return data;
}

export async function getPRFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number
): Promise<PRFile[]> {
  const { data } = await octokit.rest.pulls.listFiles({
    owner, repo, pull_number,
    per_page: 100,
  });
  return data;
}

export async function getMyReviewState(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  username: string
): Promise<ReviewState> {
  try {
    const { data } = await octokit.rest.pulls.listReviews({ owner, repo, pull_number });
    const mine = data.filter((r) => r.user?.login === username);
    if (mine.length === 0) return "PENDING";
    const latest = mine[mine.length - 1];
    const state = latest.state as string;
    if (state === "APPROVED")          return "APPROVED";
    if (state === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
    if (state === "COMMENTED")         return "COMMENTED";
    return "PENDING";
  } catch {
    return "PENDING";
  }
}

export async function getPRStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number
): Promise<PRStatus> {
  try {
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number });
    if (data.merged) return "merged";
    if (data.state === "closed") return "closed";
    return "open";
  } catch {
    return "open";
  }
}

export async function refreshPRStatuses(
  octokit: Octokit,
  reviews: Array<{ id: string; repo: string; pull_number: number; prStatus: PRStatus }>
): Promise<Map<string, PRStatus>> {
  const statusMap = new Map<string, PRStatus>();

  await Promise.all(
    reviews.map(async (r) => {
      const [owner, repoName] = r.repo.split("/");
      const status = await getPRStatus(octokit, owner, repoName, r.pull_number);
      statusMap.set(r.id, status);
    })
  );

  return statusMap;
}
