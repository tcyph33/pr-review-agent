import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ReviewState, PRStatus, TriggerType } from "./github.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_PATH        = path.join(__dirname, "..", "results", "reviews.json");
export const PR_LOGS_PATH        = path.join(__dirname, "..", "logs", "reviews");
export const ORCH_LOGS_PATH      = path.join(__dirname, "..", "logs", "orchestration");
export const LAUNCHD_ERR_LOG     = path.join(__dirname, "..", "logs", "launchd-err.log");
const LOG_RETENTION_MS           = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReviewStatus = "success" | "failed";

export interface PRReview {
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
  reviewState: ReviewState;
  reviewStatus: ReviewStatus;
  prStatus: PRStatus;
  prCreatedAt: string;
  reviewRequestedAt: string | null;
  triggerType: TriggerType;
  reviewedAt: string;
  logFile: string; // relative path: logs/reviews/<id>.log
}

// ── Orchestration log helpers ─────────────────────────────────────────────────

export function createOrchestrationLog(): { logPath: string; log: (msg: string) => void } {
  if (!fs.existsSync(ORCH_LOGS_PATH)) fs.mkdirSync(ORCH_LOGS_PATH, { recursive: true });

  const now       = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const logPath   = path.join(ORCH_LOGS_PATH, `${timestamp}.log`);

  fs.writeFileSync(logPath, `=== PR Review Agent Run\n=== Started: ${now.toISOString()}\n\n`, "utf8");

  function log(msg: string): void {
    fs.appendFileSync(logPath, msg + "\n", "utf8");
  }

  return { logPath, log };
}

export function cleanupOldLogs(): void {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  let deleted  = 0;

  // Clean up orchestration logs older than 7 days
  if (fs.existsSync(ORCH_LOGS_PATH)) {
    for (const file of fs.readdirSync(ORCH_LOGS_PATH)) {
      const filePath = path.join(ORCH_LOGS_PATH, file);
      const { mtimeMs } = fs.statSync(filePath);
      if (mtimeMs < cutoff) { fs.unlinkSync(filePath); deleted++; }
    }
  }

  // Clean up launchd-err.log if older than 7 days (based on last modified time)
  if (fs.existsSync(LAUNCHD_ERR_LOG)) {
    const { mtimeMs } = fs.statSync(LAUNCHD_ERR_LOG);
    if (mtimeMs < cutoff) { fs.unlinkSync(LAUNCHD_ERR_LOG); deleted++; }
  }

  if (deleted > 0) {
    console.log(`🗑   Cleaned up ${deleted} log file(s) older than 7 days.`);
  }
}

// ── Per-PR log helpers ────────────────────────────────────────────────────────

export function deleteReviewLog(review: { logFile?: string }): void {
  if (!review.logFile) return;
  const logPath = path.join(__dirname, "..", review.logFile);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
}

// ── Review storage ────────────────────────────────────────────────────────────

export function loadReviews(): PRReview[] {
  if (!fs.existsSync(RESULTS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8")) as PRReview[];
  } catch {
    return [];
  }
}

export function saveReviews(reviews: PRReview[]): void {
  const dir  = path.dirname(RESULTS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write — write to temp file then rename to prevent corruption on kill/crash
  const tmp  = RESULTS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reviews, null, 2));
  fs.renameSync(tmp, RESULTS_PATH);
}

export function mergeReviews(
  existing: PRReview[],
  incoming: PRReview[]
): { merged: PRReview[]; newCount: number; updatedCount: number } {
  const existingMap = new Map(existing.map((r) => [r.id, r]));
  const existingIds = new Set(existingMap.keys());

  const newCount     = incoming.filter((r) => !existingIds.has(r.id)).length;
  const updatedCount = incoming.filter((r) => existingIds.has(r.id)).length;

  for (const review of incoming) {
    existingMap.set(review.id, review);
  }

  const merged = Array.from(existingMap.values()).sort(
    (a, b) => new Date(b.reviewedAt).getTime() - new Date(a.reviewedAt).getTime()
  );

  return { merged, newCount, updatedCount };
}

export function applyStatusUpdates(
  reviews: PRReview[],
  statusMap: Map<string, PRStatus>
): PRReview[] {
  return reviews.map((r) => {
    const updated = statusMap.get(r.id);
    return updated ? { ...r, prStatus: updated } : r;
  });
}
