import { Octokit } from "@octokit/rest";
import type { RestEndpointMethodTypes } from "@octokit/rest";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReviewState = "PENDING" | "COMMENTED" | "CHANGES_REQUESTED" | "APPROVED";
export type PRStatus    = "open" | "merged" | "closed";

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

export async function getAuthenticatedUsername(octokit: Octokit): Promise<string> {
  const { data } = await octokit.rest.users.getAuthenticated();
  return data.login;
}

export interface RepoConfig {
  reviewRequestedRepos: string[]; // repos to watch for review-requested
  assigneeRepos: string[];        // repos to watch for assignee
}

export async function getPRsNeedingReview(
  octokit: Octokit,
  username: string,
  config: RepoConfig
): Promise<SearchPRItem[]> {
  const { reviewRequestedRepos, assigneeRepos } = config;

  if (reviewRequestedRepos.length === 0 && assigneeRepos.length === 0) {
    throw new Error(
      "No repos configured. Set REVIEW_REQUESTED_REPOS and/or REVIEW_ASSIGNEE_REPOS in your environment."
    );
  }

  const results = new Map<number, SearchPRItem>();

  // Query 1: review-requested on REVIEW_REQUESTED_REPOS
  if (reviewRequestedRepos.length > 0) {
    const repoFilters = reviewRequestedRepos.map(r => `repo:${r}`).join(" ");
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q: `is:pr is:open review-requested:${username} ${repoFilters}`,
      per_page: 50,
    });
    for (const item of data.items) results.set(item.id, item);
  }

  // Query 2: assignee on REVIEW_ASSIGNEE_REPOS
  if (assigneeRepos.length > 0) {
    const repoFilters = assigneeRepos.map(r => `repo:${r}`).join(" ");
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q: `is:pr is:open assignee:${username} ${repoFilters}`,
      per_page: 50,
    });
    for (const item of data.items) results.set(item.id, item);
  }

  return Array.from(results.values());
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

export type TriggerType = "review-requested" | "assignee" | "both";

async function getReviewerRequestedAt(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  username: string
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.pulls.listRequestedReviewers({
      owner, repo, pull_number,
    });
    const reviewer = data.users.find((u) => u.login === username);
    const requestedAt = (reviewer as unknown as { requested_at?: string })?.requested_at;
    return requestedAt ?? null;
  } catch {
    return null;
  }
}

async function getAssigneeRequestedAt(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  username: string
): Promise<string | null> {
  try {
    // Use the issues events API to find when this user was assigned
    const { data } = await octokit.rest.issues.listEvents({
      owner, repo, issue_number: pull_number, per_page: 100,
    });
    // Find the oldest assigned event for this user — when they were first made responsible
    const assignedEvents = data
      .filter((e) => e.event === "assigned" &&
        (e as unknown as { assignee?: { login: string } }).assignee?.login === username)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return assignedEvents[0]?.created_at ?? null;
  } catch {
    return null;
  }
}

export async function getReviewRequestedAt(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  username: string,
  triggerType: TriggerType
): Promise<string | null> {
  const dates: string[] = [];

  if (triggerType === "review-requested" || triggerType === "both") {
    const d = await getReviewerRequestedAt(octokit, owner, repo, pull_number, username);
    if (d) dates.push(d);
  }

  if (triggerType === "assignee" || triggerType === "both") {
    const d = await getAssigneeRequestedAt(octokit, owner, repo, pull_number, username);
    if (d) dates.push(d);
  }

  if (dates.length === 0) return null;
  // Return the oldest date — when you first became responsible for this PR
  return dates.sort()[0];
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

export interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface PRRefreshData {
  reviewState: ReviewState;
  lastReviewSubmittedAt: string | null;
  prStatus: PRStatus;
  additions: number;
  deletions: number;
  filesChanged: number;
  newCommits: CommitSummary[];
}

export async function refreshPRData(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  username: string,
  commitsSeenAt: string | null
): Promise<PRRefreshData> {
  const [reviewsData, filesData, prData] = await Promise.all([
    octokit.rest.pulls.listReviews({ owner, repo, pull_number }),
    octokit.rest.pulls.listFiles({ owner, repo, pull_number, per_page: 100 }),
    octokit.rest.pulls.get({ owner, repo, pull_number }),
  ]);

  // Review state + last submission time
  const myReviews = reviewsData.data
    .filter((r) => r.user?.login === username)
    .sort((a, b) => new Date(a.submitted_at ?? 0).getTime() - new Date(b.submitted_at ?? 0).getTime());

  const latestReview = myReviews[myReviews.length - 1];
  const lastReviewSubmittedAt = latestReview?.submitted_at ?? null;

  let reviewState: ReviewState = "PENDING";
  if (latestReview) {
    const state = latestReview.state as string;
    if (state === "APPROVED")          reviewState = "APPROVED";
    else if (state === "CHANGES_REQUESTED") reviewState = "CHANGES_REQUESTED";
    else if (state === "COMMENTED")    reviewState = "COMMENTED";
  }

  // PR status
  let prStatus: PRStatus = "open";
  if (prData.data.merged)               prStatus = "merged";
  else if (prData.data.state === "closed") prStatus = "closed";

  // File stats
  const files    = filesData.data;
  const additions   = files.reduce((s, f) => s + f.additions, 0);
  const deletions   = files.reduce((s, f) => s + f.deletions, 0);
  const filesChanged = files.length;

  // New commits since last seen or last review submitted
  const since = commitsSeenAt ?? lastReviewSubmittedAt;
  let newCommits: CommitSummary[] = [];
  if (since) {
    try {
      const { data: commits } = await octokit.rest.pulls.listCommits({
        owner, repo, pull_number, per_page: 100,
      });
      newCommits = commits
        .filter((c) => {
          const msg = c.commit.message.toLowerCase();
          // Exclude merge commits and common non-substantive commit types
          if (msg.startsWith("merge ") || msg.startsWith("merged ")) return false;
          const date = c.commit.committer?.date ?? c.commit.author?.date ?? "";
          return date > since;
        })
        .map((c) => ({
          sha:     c.sha.slice(0, 7),
          message: c.commit.message.split("\n")[0], // first line only
          author:  c.commit.author?.name ?? c.author?.login ?? "unknown",
          date:    c.commit.committer?.date ?? c.commit.author?.date ?? "",
        }));
    } catch {
      // best effort
    }
  }

  return { reviewState, lastReviewSubmittedAt, prStatus, additions, deletions, filesChanged, newCommits };
}
