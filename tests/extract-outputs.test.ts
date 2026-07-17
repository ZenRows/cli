import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOutputs } from "../src/cli/commands/extract.ts";
import { buildParams, type FetchOptions } from "../src/adapters/protected-fetch.ts";
import { runExtract } from "../src/adapters/extract.ts";
import { defaultConfig } from "../src/core/config.ts";
import { defaultPolicy } from "../src/core/policy.ts";
import { ToolkitError } from "../src/core/errors.ts";

const cfg = defaultConfig();

// --- normalizeOutputs (the --outputs value validator) -----------------------
test("normalizeOutputs accepts and normalizes a known filter list", () => {
  assert.equal(normalizeOutputs("emails,links"), "emails,links");
  assert.equal(normalizeOutputs(" Emails , LINKS "), "emails,links"); // trims + lowercases
});

test("normalizeOutputs accepts the wildcard", () => {
  assert.equal(normalizeOutputs("*"), "*");
});

test("normalizeOutputs returns undefined when no value is given", () => {
  assert.equal(normalizeOutputs(undefined), undefined);
  assert.equal(normalizeOutputs(""), undefined);
});

test("normalizeOutputs rejects an unknown filter (no silent drop)", () => {
  assert.throws(
    () => normalizeOutputs("emails,emals"),
    (e: unknown) => e instanceof ToolkitError && e.code === "INVALID_USAGE",
  );
});

// --- buildParams forwards the API param -------------------------------------
test("buildParams forwards outputs to the API `outputs` param", () => {
  const opts: FetchOptions = { url: "https://x.com", outputs: "emails,links" };
  assert.equal(buildParams(opts, cfg).outputs, "emails,links");
});

test("buildParams omits outputs when not requested", () => {
  assert.equal(buildParams({ url: "https://x.com" }, cfg).outputs, undefined);
});

// --- runExtract wiring (stubbed network) ------------------------------------
function withFetch(body: string, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

test("runExtract method 'outputs' sets the param, and parses the JSON result", async () => {
  await withFetch('{"emails":["a@b.com"],"links":["https://x"]}', async () => {
    const outcome = await runExtract(
      { url: "https://x.com", method: "outputs", outputs: "emails,links" },
      cfg,
      defaultPolicy(),
      "testkey",
    );
    assert.equal(outcome.method, "outputs");
    assert.equal(outcome.params.outputs, "emails,links");
    // outputs must NOT also request autoparse / css / a response_type
    assert.equal(outcome.params.autoparse, undefined);
    assert.equal(outcome.params.css_extractor, undefined);
    assert.equal(outcome.params.response_type, undefined);
    assert.deepEqual(outcome.data, { emails: ["a@b.com"], links: ["https://x"] });
  });
});
