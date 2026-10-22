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

export interface ReviewCandidate {
  item: SearchPRItem;
  /** The strongest reason this PR is yours. Drives which date counts as "since when". */
  triggerType: TriggerType;
}

/**
 * Finds the open PRs that are the user's responsibility, in three tiers.
 *
 * A PR matching more than one tier keeps only the strongest reason, because that
 * reason decides which date counts as the moment it landed on the user.
 *
 * @param octokit - Authenticated GitHub client
 * @param username - Login whose PRs to find
 * @param config - Repo lists scoping the assignee and review-requested tiers
 * @returns One candidate per distinct PR, tagged with its highest-priority trigger
 */
export async function getPRsNeedingReview(
  octokit: Octokit,
  username: string,
  config: RepoConfig
): Promise<ReviewCandidate[]> {
  const SEARCH_PAGE_SIZE = 50;

  // PRs the user commented on can be anywhere, so that tier is bounded by
  // recency instead of by repo. A PR untouched for this long is not waiting.
  const COMMENTER_RECENCY_DAYS = 90;

  const candidates = new Map<number, ReviewCandidate>();

  // First tier to claim a PR keeps it, so tiers must run strongest first
  const claim = (items: SearchPRItem[], triggerType: TriggerType): void => {
    for (const item of items) {
      const isUnclaimed = !candidates.has(item.id);
      if (isUnclaimed) candidates.set(item.id, { item, triggerType });
    }
  };

  // Tier 1 — assigned to you: the strongest claim, so it wins any overlap
  const hasAssigneeRepos = config.assigneeRepos.length > 0;
  if (hasAssigneeRepos) {
    const repoFilters = config.assigneeRepos.map(repo => `repo:${repo}`).join(" ");
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q: `is:pr is:open assignee:${username} ${repoFilters}`,
      per_page: SEARCH_PAGE_SIZE,
    });
    claim(data.items, "assignee");
  }

  // Tier 2 — review requested from you
  const hasReviewRequestedRepos = config.reviewRequestedRepos.length > 0;
  if (hasReviewRequestedRepos) {
    const repoFilters = config.reviewRequestedRepos.map(repo => `repo:${repo}`).join(" ");
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q: `is:pr is:open review-requested:${username} ${repoFilters}`,
      per_page: SEARCH_PAGE_SIZE,
    });
    claim(data.items, "review-requested");
  }

  // Tier 3 — PRs you have commented on, deliberately not repo-scoped: the point
  // is to keep tracking threads you engaged with outside the watched repos, so
  // commits landing after your last comment are not missed. The exclusions drop
  // PRs already covered by a stronger tier or authored by you.
  const recencyCutoff = new Date(Date.now() - (COMMENTER_RECENCY_DAYS * 86400000))
    .toISOString()
    .slice(0, 10);
  const { data: commented } = await octokit.rest.search.issuesAndPullRequests({
    q: `is:pr is:open commenter:${username} -author:${username} -assignee:${username}`
      + ` -review-requested:${username} updated:>=${recencyCutoff}`,
    per_page: SEARCH_PAGE_SIZE,
  });
  claim(commented.items, "commenter");

  return Array.from(candidates.values());
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

export type TriggerType = "assignee" | "review-requested" | "commenter";

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

async function getLastCommentAt(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  username: string
): Promise<string | null> {
  try {
    // Both kinds count: a PR conversation comment and an inline review comment
    const [conversation, inline] = await Promise.all([
      octokit.rest.issues.listComments({ owner, repo, issue_number: pull_number, per_page: 100 }),
      octokit.rest.pulls.listReviewComments({ owner, repo, pull_number, per_page: 100 }),
    ]);

    const ownCommentDates = [...conversation.data, ...inline.data]
      .filter((comment) => comment.user?.login === username)
      .map((comment) => comment.created_at)
      .sort();

    const hasComments = ownCommentDates.length > 0;
    return hasComments ? ownCommentDates[ownCommentDates.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * Resolves when this PR became the user's responsibility, which depends on why.
 *
 * Each tier measures from the moment the claim was made: being assigned, having
 * a review requested, or — for a PR you merely commented on — your own most
 * recent comment, since that is the point after which new commits matter.
 *
 * @param octokit - Authenticated GitHub client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param pull_number - Pull request number
 * @param username - Login whose responsibility is being dated
 * @param triggerType - The tier that claimed this PR
 * @returns The ISO date, or null when GitHub does not report one
 */
export async function getReviewRequestedAt(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  username: string,
  triggerType: TriggerType
): Promise<string | null> {
  if (triggerType === "assignee") {
    return getAssigneeRequestedAt(octokit, owner, repo, pull_number, username);
  }
  if (triggerType === "review-requested") {
    return getReviewerRequestedAt(octokit, owner, repo, pull_number, username);
  }
  return getLastCommentAt(octokit, owner, repo, pull_number, username);
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

export interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff for this file, or null when GitHub omits it (binary or oversized). */
  patch: string | null;
}

export interface PullRequestDiff {
  files: DiffFile[];
  /** True when the PR has at least a full page of files, so `files` may be incomplete. */
  truncated: boolean;
}

/**
 * Fetches the per-file diff for a pull request.
 *
 * Reads a single page rather than paginating: a PR with more files than this is
 * already past the point of being browsed file-by-file, and an unbounded fetch
 * would stall the dashboard on a huge refactor. Callers surface `truncated`
 * instead of silently showing a partial list.
 *
 * @param octokit - Authenticated GitHub client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param pull_number - Pull request number
 * @returns The per-file diffs, flagged truncated when a full page came back
 */
export async function getPullRequestDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number
): Promise<PullRequestDiff> {
  const DIFF_FILE_PAGE_SIZE = 100;

  const { data } = await octokit.rest.pulls.listFiles({
    owner, repo, pull_number, per_page: DIFF_FILE_PAGE_SIZE,
  });

  // Keep only the fields the dashboard renders — the raw payload carries several
  // URLs per file that would bloat the response for no benefit.
  const files: DiffFile[] = data.map((file: PRFile) => ({
    filename:  file.filename,
    status:    file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch:     file.patch ?? null,
  }));

  const truncated: boolean = (files.length === DIFF_FILE_PAGE_SIZE);
  const pullRequestDiff: PullRequestDiff = { files, truncated };
  return pullRequestDiff;
}

export interface PendingReviewComment {
  path: string;
  line: number | null;
}

export interface PendingReview {
  id: number;
  htmlUrl: string;
  comments: PendingReviewComment[];
}

export interface PendingReviewCommentInput {
  path: string;
  line: number;
  body: string;
}

export interface CreatePendingReviewResult {
  id: number;
  htmlUrl: string;
  /** GitHub's own report of the review's state. Anything other than PENDING means it published. */
  state: string;
}

/**
 * Finds the authenticated user's pending (draft) review on a pull request.
 *
 * @param octokit - Authenticated GitHub client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param pull_number - Pull request number
 * @param username - Login whose pending review to look for
 * @returns The pending review with its comment positions, or null when none exists
 */
export async function getPendingReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  username: string
): Promise<PendingReview | null> {
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner, repo, pull_number, per_page: 100,
  });

  const pending = reviews.find((review) => {
    const isPending = review.state === "PENDING";
    const isOurs = review.user?.login === username;
    return isPending && isOurs;
  });

  const hasPending = pending !== undefined;
  if (!hasPending) return null;

  // A pending review's comments are only reachable through its own endpoint
  const { data: comments } = await octokit.rest.pulls.listCommentsForReview({
    owner, repo, pull_number, review_id: pending.id, per_page: 100,
  });

  const pendingReview: PendingReview = {
    id: pending.id,
    htmlUrl: pending.html_url,
    comments: comments.map((comment) => ({ path: comment.path, line: comment.line ?? null })),
  };
  return pendingReview;
}

/**
 * Creates a pending (draft) review on a pull request.
 *
 * The `event` parameter is deliberately omitted — that is what makes GitHub hold
 * the review as a private draft rather than publishing it. Callers must check the
 * returned `state`, because anything other than PENDING means it published and
 * the author needs telling.
 *
 * @param octokit - Authenticated GitHub client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param pull_number - Pull request number
 * @param comments - Inline comments, each already validated against the diff
 * @param commitId - Commit the line numbers refer to, or null to use the PR head
 * @returns The new review's id and url, plus the state GitHub reported
 */
export async function createPendingReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  comments: PendingReviewCommentInput[],
  commitId: string | null
): Promise<CreatePendingReviewResult> {
  const { data } = await octokit.rest.pulls.createReview({
    owner, repo, pull_number,
    ...(commitId === null ? {} : { commit_id: commitId }),
    comments: comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: "RIGHT",
      body: comment.body,
    })),
  });

  const result: CreatePendingReviewResult = {
    id: data.id,
    htmlUrl: data.html_url,
    state: data.state,
  };
  return result;
}

/**
 * Deletes a pending (draft) review, discarding its comments.
 *
 * @param octokit - Authenticated GitHub client
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param pull_number - Pull request number
 * @param reviewId - Id of the pending review to delete
 */
export async function deletePendingReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  reviewId: number
): Promise<void> {
  await octokit.rest.pulls.deletePendingReview({
    owner, repo, pull_number, review_id: reviewId,
  });
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
  /** The PR's head SHA right now, for comparison against the SHA a review was generated from. */
  headSha: string;
}

export async function refreshPRData(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  username: string,
  commitsSeenAt: string | null,
  reviewedAt: string
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

  // Commits since the agent last analyzed this PR, unless the user has dismissed
  // them. The baseline is deliberately the agent's run rather than the user's
  // last submitted review: this list exists to answer "what changed since these
  // findings were produced", which is what decides whether a re-run is needed.
  // A review the user has never submitted feedback on would otherwise have no
  // baseline at all and always report zero commits.
  const since = commitsSeenAt ?? reviewedAt;
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

  return {
    reviewState, lastReviewSubmittedAt, prStatus,
    additions, deletions, filesChanged, newCommits,
    headSha: prData.data.head.sha,
  };
}
