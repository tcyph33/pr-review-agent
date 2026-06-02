#!/usr/bin/env npx tsx

import "dotenv/config";
import http from "http";
import https from "https";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH   = path.join(__dirname, "results", "reviews.json");
const DASHBOARD_PATH = path.join(__dirname, "dashboard");
const LOGS_PATH      = path.join(__dirname, "logs");
const PORT           = 3000;

const GITHUB_API_TOKEN        = process.env.GITHUB_API_TOKEN;
const REVIEW_SKILL_URL = process.env.REVIEW_SKILL_URL;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Review {
  id: string;
  url: string;
  title: string;
  repo: string;
  pull_number: number;
  author: string;
  branch: string;
  feedback: string;
  reviewState: string;
  reviewStatus: string;
  prStatus: string;
  prCreatedAt: string;
  reviewedAt: string;
  logFile?: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

function readReviews(): Review[] {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
  } catch {
    return [];
  }
}

function writeReviews(reviews: Review[]): void {
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(reviews, null, 2));
}

function findReview(id: string): Review | null {
  return readReviews().find((r) => r.id === id) ?? null;
}

function deleteLogFile(review: Review): void {
  if (!review.logFile) return;
  const logPath = path.join(__dirname, review.logFile);
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
}

// ── Claude Code launcher ──────────────────────────────────────────────────────

async function fetchSkill(): Promise<string> {
  if (!REVIEW_SKILL_URL || !GITHUB_API_TOKEN) {
    throw new Error("REVIEW_SKILL_URL and GITHUB_API_TOKEN must be set in environment");
  }
  const text = await new Promise<string>((resolve, reject) => {
    const req = https.get(REVIEW_SKILL_URL, {
      headers: {
        Authorization: `token ${GITHUB_API_TOKEN}`,
        Accept: "application/vnd.github.json",
        "User-Agent": "pr-review-agent",
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.end();
  });
  const json = JSON.parse(text) as { content?: string; message?: string };
  if (!json.content) throw new Error(`GitHub API error or missing content: ${text.slice(0, 200)}`);
  return Buffer.from(json.content.replace(/\n/g, ""), "base64").toString("utf8");
}

function buildClaudeMessage(review: Review): string {
  return [
    `Please review this PR: ${review.url}`,
    ``,
    `The automated review agent already reviewed this PR. Here is its prior feedback for additional context — use it to inform your review and our discussion:`,
    ``,
    review.feedback,
  ].join("\n");
}

async function launchClaudeCode(review: Review): Promise<void> {
  if (os.platform() !== "darwin") {
    throw new Error("Launching Claude Code from the dashboard is currently only supported on macOS");
  }

  const skill       = await fetchSkill();
  const message     = buildClaudeMessage(review);
  const skillPath   = path.join(os.tmpdir(), "pr-review-skill.md");
  const messagePath = path.join(os.tmpdir(), "pr-review-message.txt");

  fs.writeFileSync(skillPath, skill, "utf8");
  fs.writeFileSync(messagePath, message, "utf8");

  const command = `claude --system-prompt "$(cat '${skillPath}')" "$(cat '${messagePath}')"`;
  execSync(
    `osascript -e 'tell application "Terminal" to do script "${command.replace(/"/g, '\\"')}"'`
  );
}

// ── Request handler ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── GET /api/open-in-claude/:id ───────────────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/open-in-claude/")) {
    const id     = decodeURIComponent(url.pathname.replace("/api/open-in-claude/", ""));
    const review = findReview(id);

    if (!review) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Review not found" }));
      return;
    }

    try {
      await launchClaudeCode(review);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // ── GET /api/logs/:id ─────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/logs/")) {
    const id     = decodeURIComponent(url.pathname.replace("/api/logs/", ""));
    const review = findReview(id);

    if (!review?.logFile) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Log not found" }));
      return;
    }

    const logPath = path.join(__dirname, review.logFile);
    if (!fs.existsSync(logPath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Log file not found on disk" }));
      return;
    }

    const content = fs.readFileSync(logPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(content);
    return;
  }

  // ── DELETE /api/reviews/:id ───────────────────────────────────────────────
  if (req.method === "DELETE" && url.pathname.startsWith("/api/reviews/")) {
    const id      = decodeURIComponent(url.pathname.replace("/api/reviews/", ""));
    const reviews = readReviews();
    const target  = reviews.find((r) => r.id === id);
    const filtered = reviews.filter((r) => r.id !== id);

    if (filtered.length === reviews.length) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Review not found" }));
      return;
    }

    if (target) deleteLogFile(target);
    writeReviews(filtered);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, remaining: filtered.length }));
    return;
  }

  // ── DELETE /api/reviews (clear all) ──────────────────────────────────────
  if (req.method === "DELETE" && url.pathname === "/api/reviews") {
    const reviews = readReviews();
    reviews.forEach(deleteLogFile);
    writeReviews([]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, remaining: 0 }));
    return;
  }

  // ── GET /results/reviews.json ─────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/results/reviews.json") {
    const reviews = readReviews();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reviews));
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  if (req.method === "GET") {
    let filePath: string;

    if (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
      filePath = path.join(DASHBOARD_PATH, "index.html");
    } else if (url.pathname.startsWith("/dashboard/")) {
      filePath = path.join(DASHBOARD_PATH, url.pathname.replace("/dashboard/", ""));
    } else {
      filePath = path.join(__dirname, url.pathname);
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext  = path.extname(filePath);
      const mime = MIME[ext] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`🌐  Dashboard running at http://localhost:${PORT}/dashboard/`);
});
