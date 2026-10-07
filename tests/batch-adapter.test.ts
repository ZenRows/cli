import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCredits, toJobBody, validateJsonl, withAdaptiveStealth, type BatchJob } from "../src/adapters/batch.ts";
import { ToolkitError } from "../src/core/errors.ts";

function specFile(lines: string[]): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zr-batch-"));
  const file = join(dir, "jobs.jsonl");
  writeFileSync(file, lines.join("\n"));
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("validateJsonl flags invalid JSON and missing/invalid url", () => {
  const { file, cleanup } = specFile([
    JSON.stringify({ url: "https://a.com" }),
    "{ not json",
    JSON.stringify({ noUrl: true }),
    JSON.stringify({ url: "not-a-url" }),
    "",
  ]);
  try {
    const v = validateJsonl(file);
    assert.equal(v.totalLines, 4); // blank line skipped
    assert.equal(v.validJobs, 1);
    assert.equal(v.errors.length, 3);
  } finally {
    cleanup();
  }
});

test("estimateCredits uses the documented multipliers", () => {
  const jobs: BatchJob[] = [
    { url: "https://a.com" }, // 1x
    { url: "https://b.com", js_render: true }, // 5x
    { url: "https://c.com", premium_proxy: true }, // 10x
    { url: "https://d.com", js_render: true, premium_proxy: true }, // 25x
  ];
  const est = estimateCredits(jobs);
  assert.deepEqual(est.perJob, [1, 5, 10, 25]);
  assert.equal(est.credits, 41);
});

test("toJobBody maps job-level flags + per-task zenrows_params (string-valued)", () => {
  const jobs: BatchJob[] = [
    { url: "https://a.com", external_id: "order-1", js_render: true, wait: 2000 },
    { url: "https://b.com", metadata: { sku: "ABC-1" }, zenrows_params: { proxy_country: "de", premium_proxy: true } },
  ];
  const body = toJobBody(jobs, { js_render: true, premium_proxy: true, response_type: "markdown" });

  assert.equal(body.type, "regular");
  assert.equal(body.status, "closed");
  // Job-level params are stringified.
  assert.deepEqual(body.zenrows_params, { js_render: "true", premium_proxy: "true", response_type: "markdown" });

  // Task 1: flat per-line options become that task's zenrows_params.
  assert.equal(body.tasks[0]!.url, "https://a.com");
  assert.equal(body.tasks[0]!.external_id, "order-1");
  assert.deepEqual(body.tasks[0]!.zenrows_params, { js_render: "true", wait: "2000" });

  // Task 2: metadata passes through untouched; nested zenrows_params merge + stringify.
  assert.deepEqual(body.tasks[1]!.metadata, { sku: "ABC-1" });
  assert.deepEqual(body.tasks[1]!.zenrows_params, { proxy_country: "de", premium_proxy: "true" });
});

test("toJobBody rejects proxy_country without premium_proxy BEFORE any HTTP call", () => {
  const jobs: BatchJob[] = [{ url: "https://a.com", proxy_country: "us" }];
  assert.throws(
    () => toJobBody(jobs, {}),
    (e: unknown) => e instanceof ToolkitError && e.code === "PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM",
  );
});

test("toJobBody allows proxy_country when a job-level premium_proxy covers the task", () => {
  const jobs: BatchJob[] = [{ url: "https://a.com", proxy_country: "us" }];
  assert.doesNotThrow(() => toJobBody(jobs, { premium_proxy: true }));
});

test("toJobBody allows proxy_country in mode=auto without premium_proxy", () => {
  const jobs: BatchJob[] = [{ url: "https://a.com", proxy_country: "us", mode: "auto" }];
  const body = toJobBody(jobs, {});
  assert.deepEqual(body.tasks[0]!.zenrows_params, { proxy_country: "us", mode: "auto" });
});

test("withAdaptiveStealth adds mode=auto to lines that don't force flags or set mode", () => {
  const jobs: BatchJob[] = [
    { url: "https://a.com" },
    { url: "https://b.com", js_render: true },
    { url: "https://c.com", zenrows_params: { premium_proxy: "true" } },
    { url: "https://d.com", mode: "auto" },
    { url: "https://e.com", autoparse: true, js_render: false },
  ];
  assert.deepEqual(
    withAdaptiveStealth(jobs).map((j) => j.mode),
    ["auto", undefined, undefined, "auto", "auto"],
  );
  assert.equal(jobs[0]!.mode, undefined, "input is not mutated");
});

test("withAdaptiveStealth leaves every line alone when job-level params force a flag", () => {
  const jobs: BatchJob[] = [{ url: "https://a.com" }];
  assert.equal(withAdaptiveStealth(jobs, { js_render: true })[0]!.mode, undefined);
  assert.equal(withAdaptiveStealth(jobs, { premium_proxy: true })[0]!.mode, undefined);
});

test("toJobBody accepts proxy_country without premium_proxy once Adaptive Stealth Mode is applied", () => {
  const jobs = withAdaptiveStealth([{ url: "https://a.com" }], { proxy_country: "us" });
  const body = toJobBody(jobs, { proxy_country: "us" });
  assert.equal(body.tasks[0]!.zenrows_params?.mode, "auto");
  assert.equal(body.zenrows_params?.proxy_country, "us");
});
