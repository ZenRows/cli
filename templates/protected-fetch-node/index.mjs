#!/usr/bin/env node
// Minimal Zenrows Protected Fetch example (Adaptive Stealth Mode).
// Usage: node index.mjs <url>
const API_BASE = "https://api.zenrows.com/v1/";
const apikey = process.env.ZENROWS_API_KEY;
const url = process.argv[2] ?? "https://httpbin.io/html";

if (!apikey) {
  console.error("Set ZENROWS_API_KEY (see .env.example).");
  process.exit(1);
}

const params = new URLSearchParams({ apikey, url, mode: "auto" });
const res = await fetch(`${API_BASE}?${params}`);
const body = await res.text();

console.error(`HTTP ${res.status} · ${body.length} bytes · cost $${res.headers.get("x-request-cost") ?? "?"}`);
process.stdout.write(body);
