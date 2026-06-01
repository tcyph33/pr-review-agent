import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ReviewState, PRStatus } from "./github.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_PATH  = path.join(__dirname, "..", "results", "reviews.json");
export const PR_LOGS_PATH  = path.join(__dirname, "..", "logs", "reviews");

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
  reviewedAt: string;
  logFile: string; // relative path: logs/reviews/<id>.log
}

// ── Log helpers ───────────────────────────────────────────────────────────────

export function idToLogFilename(id: string): string {
  // "org/repo#42" → "org-repo-42.log"
  return id.replace(/\//g, "-").replace("#", "-") + ".log";
}

export function logPathForId(id: string): string {
  return path.join(PR_LOGS_PATH, idToLogFilename(id));
}

export function writeReviewLog(id: string, content: string): string {
  if (!fs.existsSync(PR_LOGS_PATH)) fs.mkdirSync(PR_LOGS_PATH, { recursive: true });
  const logPath = logPathForId(id);
  fs.writeFileSync(logPath, content, "utf8");
  return path.relative(path.join(__dirname, ".."), logPath); // relative path for storage
}

export function deleteReviewLog(id: string): void {
  const logPath = logPathForId(id);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
}

// ── Log rotation ──────────────────────────────────────────────────────────────

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export function rotateLogIfNeeded(logPath: string): void {
  if (!fs.existsSync(logPath)) return;
  const { size } = fs.statSync(logPath);
  if (size < MAX_LOG_SIZE_BYTES) return;
  const rotated = logPath.replace(/\.log$/, `.${Date.now()}.log`);
  fs.renameSync(logPath, rotated);
  console.log(`📦  Rotated ${path.basename(logPath)} (was ${(size / 1024 / 1024).toFixed(1)}MB)`);
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
  const dir = path.dirname(RESULTS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(reviews, null, 2));
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
