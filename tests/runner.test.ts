import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalStep, runStep, type RunStep } from "../src/cli/runner.ts";
import { defaultConfig } from "../src/core/config.ts";
import { defaultPolicy } from "../src/core/policy.ts";

const cfg = defaultConfig();
const pol = defaultPolicy();

function withSpecDir(lines: string[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zr-runner-"));
  writeFileSync(join(dir, "jobs.jsonl"), lines.join("\n") + "\n");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("isLocalStep: batch-estimate is local, fetch/extract are not", () => {
  assert.equal(isLocalStep({ kind: "batch-estimate", file: "x.jsonl" }), true);
  assert.equal(isLocalStep({ kind: "fetch", url: "https://x" }), false);
  assert.equal(isLocalStep({ kind: "extract", url: "https://x" }), false);
});

test("batch-estimate step passes on a clean spec (no key, no network)", async () => {
  const { dir, cleanup } = withSpecDir([
    '{"url":"https://a.com"}',
    '{"url":"https://b.com","js_render":true}',
  ]);
  try {
    const step: RunStep = { kind: "batch-estimate", file: "jobs.jsonl", expect: { maxErrors: 0, minValidJobs: 2 } };
    const r = await runStep(step, cfg, pol, "", dir);
    assert.equal(r.ok, true);
    assert.equal(r.bytes, 2); // valid job count
    assert.equal(r.estimatedCredits, 1 + 5); // basic + js
  } finally {
    cleanup();
  }
});

test("batch-estimate step fails when the spec has invalid lines beyond maxErrors", async () => {
  const { dir, cleanup } = withSpecDir(['{"url":"https://a.com"}', "not-json", '{"nope":true}']);
  try {
    const step: RunStep = { kind: "batch-estimate", file: "jobs.jsonl", expect: { maxErrors: 0 } };
    const r = await runStep(step, cfg, pol, "", dir);
    assert.equal(r.ok, false);
    assert.match(r.failureReason ?? "", /invalid line/);
  } finally {
    cleanup();
  }
});

test("batch-estimate step fails cleanly when the file is missing", async () => {
  const step: RunStep = { kind: "batch-estimate", file: "nope.jsonl" };
  const r = await runStep(step, cfg, pol, "", "/tmp/does-not-exist-zr");
  assert.equal(r.ok, false);
  assert.ok(r.failureReason && r.failureReason.length > 0);
});
