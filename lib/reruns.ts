import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

/**
 * Re-runs launched from the dashboard, as background child processes.
 *
 * Nothing here writes a log. The review script owns the PR's log from its first
 * line, so a re-run's startup output, agent output and outcome all land in the
 * one file the dashboard already shows — there is no second log to reconcile.
 * What this module keeps instead is what only the parent can know: whether a run
 * is going, and how the last one ended.
 */

interface RerunnableReview {
  id: string;
}

export interface RerunJob {
  reviewId: string;
  startedAt: string;
}

export interface RerunOutcome {
  reviewId: string;
  endedAt: string;
  exitCode: number | null;
  /** Set when the run was signalled, which means it was cancelled on purpose. */
  signal: string | null;
}

interface TrackedRerun extends RerunJob {
  child: ChildProcess;
}

const runningReruns = new Map<string, TrackedRerun>();

/**
 * How the last re-run of each review ended.
 *
 * In memory rather than stored: this exists to put a notice on the card, and the
 * PR's own log holds the detail either way. A server restart forgets the notice,
 * not the diagnosis.
 */
const lastOutcomes = new Map<string, RerunOutcome>();

/**
 * Starts a background re-run of the review agent for one PR.
 *
 * @param review - The review whose PR should be re-reviewed
 * @param prUrl - The PR's web url, passed to the review script
 * @param repoPath - Absolute path of this project, used as the working directory
 * @returns The started job
 * @throws {Error} If a re-run for this review is already in progress
 */
export function startRerun(
  review: RerunnableReview,
  prUrl: string,
  repoPath: string
): RerunJob {
  const isAlreadyRunning = runningReruns.has(review.id);
  if (isAlreadyRunning) {
    throw new Error("A re-run is already in progress for this PR");
  }

  // Cleared so a previous failure's notice does not sit on the card next to a
  // run that is currently going
  lastOutcomes.delete(review.id);

  const startedAt = new Date().toISOString();

  // No shell, so the url arrives as an argv entry and nothing in it can be read
  // as a command. detached puts the run in its own process group, which is what
  // lets a cancel reach the agent — npm spawns tsx, which spawns claude, so
  // signalling npm alone would leave the agent running.
  const child = spawn("npm", ["run", "review", "--", prUrl], {
    cwd: repoPath,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Read and discarded. The script writes everything worth keeping to the PR's
  // own log, so nothing here needs the content — but an unread pipe stalls the
  // child once its buffer fills, so both streams still have to be drained.
  child.stdout?.resume();
  child.stderr?.resume();

  // "error" and "close" can both fire for one failed spawn, and the outcome must
  // be recorded exactly once
  let hasFinished = false;
  function finish(outcome: Omit<RerunOutcome, "reviewId" | "endedAt">): void {
    if (hasFinished) return;
    hasFinished = true;
    runningReruns.delete(review.id);
    lastOutcomes.set(review.id, {
      reviewId: review.id,
      endedAt: new Date().toISOString(),
      ...outcome,
    });
  }

  // A spawn that never started reports no exit code and no signal, which reads
  // as a failure below — correctly, since nothing ran
  child.on("error", () => finish({ exitCode: null, signal: null }));

  child.on("close", (code: number | null, signal: string | null) => {
    finish({ exitCode: code, signal });
  });

  const job: TrackedRerun = { reviewId: review.id, startedAt, child };
  runningReruns.set(review.id, job);

  return { reviewId: review.id, startedAt };
}

/**
 * Finds an in-progress re-run.
 *
 * @param reviewId - Review id in `owner/repo#number` form
 * @returns The running job, or null when nothing is running for that review
 */
export function getRerun(reviewId: string): RerunJob | null {
  const job: TrackedRerun | undefined = runningReruns.get(reviewId);
  const foundJob: RerunJob | null = job
    ? { reviewId: job.reviewId, startedAt: job.startedAt }
    : null;
  return foundJob;
}

/**
 * Lists every re-run this server has in progress.
 *
 * Known gap: the list lives in memory, so a server restart loses it. The run
 * itself is in its own process group and may well carry on — its own cap in
 * run-reviews.ts is what ends it then, and the dashboard simply stops showing
 * it as running.
 *
 * @returns One entry per in-progress re-run
 */
export function listReruns(): RerunJob[] {
  const jobs: RerunJob[] = [...runningReruns.values()].map((job: TrackedRerun) => ({
    reviewId: job.reviewId,
    startedAt: job.startedAt,
  }));
  return jobs;
}

/**
 * Lists the re-runs that failed and have not been re-run since.
 *
 * A failed re-run leaves the stored review untouched, so without this nothing
 * anywhere would say the re-run did not happen.
 *
 * A cancelled run is not a failure: it was signalled because someone asked for
 * it to stop, so reporting it as failed would turn pressing Cancel into an
 * error message.
 *
 * @returns One entry per review whose last re-run failed
 */
export function listFailedReruns(): RerunOutcome[] {
  const failures: RerunOutcome[] = [...lastOutcomes.values()].filter(
    (outcome: RerunOutcome) => {
      const wasCancelled = outcome.signal !== null;
      const didFail = outcome.exitCode !== 0;
      return didFail && !wasCancelled;
    }
  );
  return failures;
}

/**
 * Stops an in-progress re-run and everything it spawned.
 *
 * @param reviewId - Review id in `owner/repo#number` form
 * @returns True when a running re-run was signalled
 */
export function cancelRerun(reviewId: string): boolean {
  const job: TrackedRerun | undefined = runningReruns.get(reviewId);

  const isRunning = job !== undefined;
  if (!isRunning) return false;

  const processId: number | undefined = job!.child.pid;
  const hasProcessId = typeof processId === "number";
  if (!hasProcessId) return false;

  try {
    // Negated pid signals the whole process group rather than npm alone
    process.kill(-processId!, "SIGTERM");
  } catch {
    // Already gone — the close handler will have cleared the map entry
    return false;
  }

  return true;
}

/**
 * Forgets a review's last re-run outcome, so its failure notice goes away.
 *
 * @param reviewId - Review id in `owner/repo#number` form
 */
export function dismissRerunOutcome(reviewId: string): void {
  lastOutcomes.delete(reviewId);
}
