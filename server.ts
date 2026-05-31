#!/usr/bin/env npx tsx

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = path.join(__dirname, "results", "reviews.json");
const DASHBOARD_PATH = path.join(__dirname, "dashboard");
const PORT = 3000;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".json": "application/json",
};

function readReviews(): object[] {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
  } catch {
    return [];
  }
}

function writeReviews(reviews: object[]): void {
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(reviews, null, 2));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── DELETE /api/reviews/:id ───────────────────────────────────────────────
  if (req.method === "DELETE" && url.pathname.startsWith("/api/reviews/")) {
    const id = decodeURIComponent(url.pathname.replace("/api/reviews/", ""));
    const reviews = readReviews() as Array<{ id: string }>;
    const filtered = reviews.filter((r) => r.id !== id);

    if (filtered.length === reviews.length) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Review not found" }));
      return;
    }

    writeReviews(filtered);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, remaining: filtered.length }));
    return;
  }

  // ── DELETE /api/reviews (clear all) ──────────────────────────────────────
  if (req.method === "DELETE" && url.pathname === "/api/reviews") {
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
      const ext = path.extname(filePath);
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
