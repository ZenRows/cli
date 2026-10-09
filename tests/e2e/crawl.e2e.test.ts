/**
 * End-to-end test for `zenrows crawl` against a live Zenrows API.
 *
 * Drives the built CLI binary (`dist/bin/zenrows.js`) the way a user does, so it
 * covers argument parsing, the HTTP client and the output together. Skipped
 * unless all are set:
 *
 *   ZENROWS_E2E=1
 *   ZENROWS_API_KEY=<a key with Crawl access>
 *   ZENROWS_E2E_CRAWL_URL=<the start URL to crawl>
 *
 * Optional: `ZENROWS_E2E_CRAWL_INCLUDE` (an include pattern every result URL
 * must contain) and `ZENROWS_CRAWL_API_BASE` (default https://api.zenrows.com/v1).
 * Run with `npm run test:e2e`, which does NOT load tests/setup.ts (that file
 * scrubs every ZENROWS_* variable to keep the unit suite hermetic).
 *
 * The test starts one real, small crawl (bills a few pages on the key's account).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const START_URL = process.env.ZENROWS_E2E_CRAWL_URL;
const INCLUDE = process.env.ZENROWS_E2E_CRAWL_INCLUDE || undefined;
const enabled = process.env.ZENROWS_E2E === "1" && !!process.env.ZENROWS_API_KEY && !!START_URL;
const skip = enabled
  ? false
  : "set ZENROWS_E2E=1, ZENROWS_API_KEY and ZENROWS_E2E_CRAWL_URL to run the Crawl e2e test";

const BIN = fileURLToPath(new URL("../../bin/zenrows.js", import.meta.url));
/** How long to keep retrying a start that hits the account's active-crawl limit. */
const QUOTA_RETRY_MS = 5 * 60_000;

interface CliResult {
  code: number;
  out: Record<string, any>;
}

/** Run `zenrows <args> --json` in `cwd` and parse its JSON stdout. */
function cli(cwd: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args, "--json"], {
      cwd,
      env: { ...process.env, ZENROWS_CONFIG_HOME: cwd, ZENROWS_TELEMETRY: "off" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code: code ?? -1, out: JSON.parse(stdout) as Record<string, any> });
      } catch {
        reject(new Error(`zenrows ${args[0]} ${args[1] ?? ""} printed no JSON (exit ${code}): ${stdout.slice(0, 500)} ${stderr.slice(-500)}`));
      }
    });
  });
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

test("zenrows crawl end to end against a live API", { skip, timeout: 20 * 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "zr-crawl-e2e-"));
  try {
    // 1. Start a small crawl and wait for it. Other runs may hold the account's
    // active-job slots: on CRAWL_TOO_MANY_CRAWLS wait retry_after and try again.
    const deadline = Date.now() + QUOTA_RETRY_MS;
    let start: CliResult;
    for (;;) {
      start = await cli(dir, [
        "crawl", "start", START_URL!,
        "--depth", "1", "--max-items", "3", "--max-pages", "5",
        ...(INCLUDE ? ["--include", INCLUDE] : []),
        "--html", "--wait", "--timeout", "600000",
      ]);
      if (start.out.error?.code !== "CRAWL_TOO_MANY_CRAWLS" || Date.now() > deadline) break;
      const wait = Number(start.out.error.retry_after ?? 30);
      log(`too_many_crawls: retrying start in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    assert.equal(start.code, 0, JSON.stringify(start.out.error ?? start.out));
    const id = start.out.crawlId as string;
    assert.match(id, /\S/);
    assert.equal(start.out.status, "completed");
    log(`crawl: ${start.out.status} (${start.out.stop_reason ?? "nothing left"})`);

    // 2. Every kept URL, across all pages.
    const results = await cli(dir, ["crawl", "results", id]);
    assert.equal(results.code, 0, JSON.stringify(results.out));
    const rows = results.out.results as Array<{ url: string; content_status?: string; content_url?: string }>;
    assert.ok(rows.length >= 1, "at least one result");
    if (INCLUDE) for (const r of rows) assert.ok(r.url.includes(INCLUDE), `${r.url} matches --include`);
    log(`results: ${rows.length} URL(s)${INCLUDE ? ", all matching the include pattern" : ""}`);

    // 3. One fetched page's HTML.
    const fetched = rows.find((r) => r.content_status === "fetched" && r.content_url);
    assert.ok(fetched, "at least one result has fetched content");
    const content = await cli(dir, ["crawl", "content", id, fetched.content_url!]);
    assert.equal(content.code, 0, JSON.stringify(content.out));
    assert.match(content.out.contentType, /text\/html/);
    assert.match(content.out.content, /<html/i);
    log(`content: HTML (${content.out.contentType})`);

    // 4. The NDJSON export has one line per result.
    const file = join(dir, "export.jsonl");
    const download = await cli(dir, ["crawl", "results", id, "--download", "--out", file]);
    assert.equal(download.code, 0, JSON.stringify(download.out));
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    assert.equal(lines.length, rows.length);
    assert.equal(download.out.count, rows.length);
    log(`download: ${lines.length} NDJSON line(s), X-Crawl-Status ${download.out.crawlStatus}`);

    // 5. The new crawl is listed.
    const list = await cli(dir, ["crawl", "list", "--limit", "100"]);
    assert.equal(list.code, 0, JSON.stringify(list.out));
    assert.ok((list.out.crawls as Array<{ crawl_id: string }>).some((c) => c.crawl_id === id), "crawl is listed");
    log("list: the new crawl is listed");

    // 6. Stopping an ended crawl answers as it ended.
    const stop = await cli(dir, ["crawl", "stop", id]);
    assert.equal(stop.code, 0, JSON.stringify(stop.out));
    assert.equal(stop.out.status, start.out.status);
    log(`stop on ended crawl: status ${stop.out.status}`);

    // 7. An unknown id is CRAWL_NOT_FOUND.
    const missing = await cli(dir, ["crawl", "status", "c_does_not_exist_e2e"]);
    assert.equal(missing.code, 1);
    assert.equal(missing.out.error.code, "CRAWL_NOT_FOUND");
    log("status on unknown id: CRAWL_NOT_FOUND");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
