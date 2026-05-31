import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { ReviewState, PRStatus } from "./github.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_PATH = path.join(__dirname, "..", "results", "reviews.json");

// ── Types ─────────────────────────────────────────────────────────────────────

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
  prStatus: PRStatus;
  prCreatedAt: string;
  reviewedAt: string;
}

// ── Functions ─────────────────────────────────────────────────────────────────

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
