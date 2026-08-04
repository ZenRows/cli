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
const AUTH010 = JSON.stringify({
  code: "AUTH010",
  detail: "This domain is not enabled for Extract.",
  status: 402,
  title: "Feature is not included in plan (AUTH010)",
  type: "https://docs.zenrows.com/api-error-codes#AUTH010",
});

const AUTH004 = JSON.stringify({
  code: "AUTH004",
  detail: "This account has reached its usage limit.",
  status: 402,
  title: "Usage exceeded (AUTH004)",
  type: "https://docs.zenrows.com/api-error-codes#AUTH004",
});

function withFetch(body: string, fn: () => Promise<void>, opts: { status?: number; headers?: Record<string, string> } = {}): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, {
      status: opts.status ?? 200,
      headers: { "content-type": "application/json", ...opts.headers },
    })) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

/** Stub fetch with a URL-aware handler; restores the original on exit. */
function withFetchHandler(handler: (url: string) => Response, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

test("buildParams forwards extract=auto", () => {
  assert.equal(buildParams({ url: "https://x.com", extract: true }, cfg).extract, "auto");
});

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
    // outputs must NOT also request extract / autoparse / css / a response_type
    assert.equal(outcome.params.extract, undefined);
    assert.equal(outcome.params.autoparse, undefined);
    assert.equal(outcome.params.css_extractor, undefined);
    assert.equal(outcome.params.response_type, undefined);
    assert.deepEqual(outcome.data, { emails: ["a@b.com"], links: ["https://x"] });
  });
});

test("runExtract method 'css' sets css_extractor", async () => {
  await withFetch('{"title":"Hi"}', async () => {
    const outcome = await runExtract(
      { url: "https://x.com", method: "css", cssExtractor: '{"title":"h1"}' },
      cfg,
      defaultPolicy(),
      "testkey",
    );
    assert.equal(outcome.method, "css");
    assert.equal(outcome.params.css_extractor, '{"title":"h1"}');
    assert.equal(outcome.params.extract, undefined);
    assert.deepEqual(outcome.data, { title: "Hi" });
  });
});

test("runExtract method 'markdown' sets response_type", async () => {
  await withFetch("# Hello", async () => {
    const outcome = await runExtract(
      { url: "https://x.com", method: "markdown" },
      cfg,
      defaultPolicy(),
      "testkey",
    );
    assert.equal(outcome.method, "markdown");
    assert.equal(outcome.params.response_type, "markdown");
    assert.equal(outcome.params.extract, undefined);
    assert.equal(outcome.data, undefined);
  });
});

test("runExtract default method is extract=auto and unwraps {parsed,html}", async () => {
  await withFetch(
    JSON.stringify({ parsed: { title: "X" }, html: "<html>x</html>" }),
    async () => {
      const outcome = await runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey");
      assert.equal(outcome.method, "extract");
      assert.equal(outcome.params.extract, "auto");
      assert.equal(outcome.params.autoparse, undefined);
      assert.deepEqual(outcome.data, { title: "X" });
      assert.equal(outcome.html, "<html>x</html>");
      assert.equal(outcome.fellBackToAutoparse, undefined);
    },
  );
});

test("runExtract extract success surfaces costCredits from response headers", async () => {
  await withFetch(
    JSON.stringify({ parsed: { ok: true }, html: "<html/>" }),
    async () => {
      const outcome = await runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey");
      assert.equal(outcome.result.costUsd, 0.0003625);
      assert.equal(outcome.result.costCredits, 1);
    },
    { headers: { "x-request-cost": "0.0003625", "x-request-credits": "1" } },
  );
});

test("runExtract --autoparse skips extract and does not unwrap envelope", async () => {
  await withFetch('{"title":"Y"}', async () => {
    const outcome = await runExtract(
      { url: "https://x.com", method: "autoparse" },
      cfg,
      defaultPolicy(),
      "testkey",
    );
    assert.equal(outcome.method, "autoparse");
    assert.equal(outcome.params.autoparse, true);
    assert.equal(outcome.params.extract, undefined);
    assert.deepEqual(outcome.data, { title: "Y" });
  });
});

test("runExtract falls back to autoparse on AUTH010 for extract=auto", async () => {
  const calls: string[] = [];
  await withFetchHandler((url) => {
    calls.push(url);
    if (url.includes("extract=auto")) {
      return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response('{"title":"fallback"}', {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-cost": "0.0003625",
        "x-request-credits": "1",
      },
    });
  }, async () => {
    const outcome = await runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey");
    assert.equal(outcome.method, "autoparse");
    assert.equal(outcome.fellBackToAutoparse, true);
    assert.equal(outcome.params.autoparse, true);
    assert.deepEqual(outcome.data, { title: "fallback" });
    assert.equal(outcome.result.costCredits, 1);
    assert.equal(calls.length, 2);
    assert.match(calls[0]!, /extract=auto/);
    assert.match(calls[1]!, /autoparse=true/);
    assert.doesNotMatch(calls[1]!, /extract=auto/);
  });
});

test("runExtract does not fall back when fallbackAutoparse is false", async () => {
  await withFetch(AUTH010, async () => {
    await assert.rejects(
      () =>
        runExtract(
          { url: "https://x.com", method: "extract", fallbackAutoparse: false },
          cfg,
          defaultPolicy(),
          "testkey",
        ),
      (e: unknown) => e instanceof ToolkitError && e.code === "EXTRACT_DOMAIN_NOT_ENABLED",
    );
  }, { status: 402 });
});

test("runExtract does not fall back on AUTH004 (credits exhausted)", async () => {
  let calls = 0;
  await withFetchHandler(() => {
    calls += 1;
    return new Response(AUTH004, { status: 402, headers: { "content-type": "application/json" } });
  }, async () => {
    await assert.rejects(
      () => runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey"),
      (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_MAX_CREDITS_EXCEEDED",
    );
    assert.equal(calls, 1, "must not retry autoparse when credits are exhausted");
  });
});

test("runExtract surfaces autoparse failure after AUTH010 fallback", async () => {
  await withFetchHandler((url) => {
    if (url.includes("extract=auto")) {
      return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response("upstream boom", { status: 500, headers: { "content-type": "text/plain" } });
  }, async () => {
    await assert.rejects(
      () => runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey"),
      (e: unknown) => e instanceof ToolkitError && e.code === "FETCH_FAILED",
    );
  });
});

test("runExtract --validate fails when body is not JSON", async () => {
  await withFetch("<html>not json</html>", async () => {
    await assert.rejects(
      () =>
        runExtract(
          { url: "https://x.com", method: "autoparse", validate: true },
          cfg,
          defaultPolicy(),
          "testkey",
        ),
      (e: unknown) => e instanceof ToolkitError && e.code === "EXTRACT_VALIDATION_FAILED",
    );
  });
});

test("runExtract --css without a selector map fails locally (no network)", async () => {
  await assert.rejects(
    () => runExtract({ url: "https://x.com", method: "css" }, cfg, defaultPolicy(), "testkey"),
    (e: unknown) => e instanceof ToolkitError && e.code === "INVALID_USAGE",
  );
});

// --- ACT-1514: empty extraction must not be a silent success ----------------
test("runExtract flags an empty extract=auto result (empty=true)", async () => {
  await withFetch(JSON.stringify({ parsed: {}, html: "<html/>" }), async () => {
    const outcome = await runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey");
    assert.equal(outcome.method, "extract");
    assert.deepEqual(outcome.data, {});
    assert.equal(outcome.empty, true);
  });
});

test("runExtract flags an empty autoparse result (empty=true)", async () => {
  await withFetch("{}", async () => {
    const outcome = await runExtract(
      { url: "https://x.com", method: "autoparse" },
      cfg,
      defaultPolicy(),
      "testkey",
    );
    assert.equal(outcome.empty, true);
  });
});

test("runExtract does not flag a non-empty result", async () => {
  await withFetch(JSON.stringify({ parsed: { title: "X" }, html: "<html/>" }), async () => {
    const outcome = await runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey");
    assert.equal(outcome.empty ?? false, false);
  });
});

test("runExtract --validate fails on an empty result", async () => {
  await withFetch(JSON.stringify({ parsed: {}, html: "<html/>" }), async () => {
    await assert.rejects(
      () =>
        runExtract(
          { url: "https://x.com", method: "extract", fallbackAutoparse: false, validate: true },
          cfg,
          defaultPolicy(),
          "testkey",
        ),
      (e: unknown) => e instanceof ToolkitError && e.code === "EXTRACT_VALIDATION_FAILED",
    );
  });
});
