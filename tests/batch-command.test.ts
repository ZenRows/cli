import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { batch } from "../src/cli/commands/batch.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { savePolicy, defaultPolicy } from "../src/core/policy.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { tempRoot } from "./helpers.ts";

const ctx = { json: true, yes: false };

/**
 * Run `fn` inside a fresh initialized workspace with a saved key, applying the
 * given policy. A fetch stub records whether ANY network call was attempted so
 * pre-flight (local) governance can be proven to fire before the wire.
 */
function withBatchWorkspace(
  policy: Partial<ReturnType<typeof defaultPolicy>>,
  fn: (didFetch: () => boolean) => Promise<void>,
): Promise<void> {
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  savePolicy({ ...defaultPolicy(), ...policy }, root);
  saveApiKey("0".repeat(41), root);
  process.chdir(root);
  let fetched = false;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response(JSON.stringify({ job_id: "j1", latest_run: { status: "queued" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return fn(() => fetched).finally(() => {
    globalThis.fetch = orig;
    process.chdir(cwd);
    cleanup();
  });
}

function writeSpec(urls: string[]): string {
  const file = join(process.cwd(), "jobs.jsonl");
  writeFileSync(file, urls.map((u) => JSON.stringify({ url: u })).join("\n") + "\n");
  return file;
}

test("batch create rejects a blocked-domain task before any network call", async () => {
  await withBatchWorkspace({ blocked_domains: ["blocked.example"] }, async (didFetch) => {
    const file = writeSpec(["https://ok.example/a", "https://blocked.example/b"]);
    const code = await batch.run(["create", file], ctx);
    assert.equal(code, 1);
    assert.equal(didFetch(), false, "blocked task must be rejected before submitting");
  });
});

test("batch create rejects a run over the page cap before any network call", async () => {
  await withBatchWorkspace({ max_pages_per_run: 1 }, async (didFetch) => {
    const file = writeSpec(["https://ok.example/a", "https://ok.example/b"]);
    const code = await batch.run(["create", file], ctx);
    assert.equal(code, 1);
    assert.equal(didFetch(), false, "over-cap run must be rejected before submitting");
  });
});

test("batch create rejects a run over the credit cap before any network call", async () => {
  // Two premium+js tasks ≈ 50 credits; cap at 10 → blocked.
  await withBatchWorkspace({ max_credits_per_run: 10 }, async (didFetch) => {
    const file = join(process.cwd(), "jobs.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ url: "https://ok.example/a", js_render: true, premium_proxy: true }),
        JSON.stringify({ url: "https://ok.example/b", js_render: true, premium_proxy: true }),
      ].join("\n") + "\n",
    );
    const code = await batch.run(["create", file], ctx);
    assert.equal(code, 1);
    assert.equal(didFetch(), false, "over-credit-cap run must be rejected before submitting");
  });
});

test("batch create submits when the run is within policy caps", async () => {
  await withBatchWorkspace({ max_pages_per_run: 10, max_credits_per_run: 100 }, async (didFetch) => {
    const file = writeSpec(["https://ok.example/a", "https://ok.example/b"]);
    const code = await batch.run(["create", file], ctx);
    assert.equal(code, 0);
    assert.equal(didFetch(), true, "an in-policy run must reach the Batch API");
  });
});
