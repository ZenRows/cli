import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOutputs } from "../src/cli/commands/extract.ts";
import { buildParams, type FetchOptions } from "../src/adapters/protected-fetch.ts";
import { FALLBACK_AUTOPARSE_DEPRECATION, isEmptyData, runExtract } from "../src/adapters/extract.ts";
import { defaultConfig } from "../src/core/config.ts";
import { defaultPolicy } from "../src/core/policy.ts";
import { ToolkitError } from "../src/core/errors.ts";
import { refusalReason } from "../src/core/http.ts";

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

test("runExtract reports REQS007 with the prepare step and does not retry", async () => {
  const REQS007 = JSON.stringify({ code: "REQS007", detail: "Extract has not been prepared for x.com yet.", status: 403 });
  const calls: string[] = [];
  await withFetchHandler((url) => {
    calls.push(url);
    return new Response(REQS007, { status: 403, headers: { "content-type": "application/json" } });
  }, async () => {
    await assert.rejects(
      () => runExtract({ url: "https://www.x.com/item/1" }, cfg, defaultPolicy(), "testkey"),
      (e: unknown) => {
        assert.ok(e instanceof ToolkitError);
        assert.equal(e.code, "EXTRACT_DOMAIN_NOT_PREPARED");
        assert.equal(
          e.message,
          "Extract hasn't prepared x.com yet. Prepare it with `zenrows extract prepare x.com --url https://www.x.com/item/1` (a few example URLs, a few minutes, no credits), then retry; meanwhile use --css.",
        );
        assert.deepEqual(e.toJSON().suggested_commands, [
          "zenrows extract prepare x.com --url https://www.x.com/item/1 --wait",
          "zenrows extract prepare status x.com",
          `zenrows extract https://www.x.com/item/1 --css '{"title":"h1"}'`,
        ]);
        assert.doesNotMatch(JSON.stringify(e.toJSON()), /autoparse/);
        return true;
      },
    );
    assert.equal(calls.length, 1, "REQS007 must not be retried with autoparse");
  });
});

/** A REQS007 the way the gateway sends it: with `reason`, or (an older gateway) without. */
function reqs007(kind: "domain" | "page" | "allowlist", withReason: boolean): string {
  const bodies = {
    domain: {
      title: "Extract is not prepared for the requested domain (x.com) (REQS007)",
      detail: "Extract has not been prepared for x.com yet.",
      reason: "domain_not_prepared",
    },
    page: {
      title: "Extract did not recognise this page on x.com (REQS007)",
      detail: "Extract serves x.com, but did not recognise this page as one it can extract.",
      reason: "page_not_recognised",
    },
    allowlist: {
      title: "Extract is not enabled for the requested domain (x.com) (REQS007)",
      detail: "Extract is not enabled for the requested domain (x.com) yet.",
      reason: "domain_not_enabled",
    },
  } as const;
  const { reason, ...rest } = bodies[kind];
  return JSON.stringify({ code: "REQS007", status: 403, ...rest, ...(withReason ? { reason } : {}) });
}

async function reqs007Error(body: string, url = "https://x.com/search?q=a"): Promise<ToolkitError> {
  let calls = 0;
  let caught: unknown;
  await withFetchHandler(() => {
    calls += 1;
    return new Response(body, { status: 403, headers: { "content-type": "application/json" } });
  }, async () => {
    caught = await runExtract({ url }, cfg, defaultPolicy(), "testkey").then(
      () => undefined,
      (e: unknown) => e,
    );
  });
  assert.equal(calls, 1, "a REQS007 is never retried");
  assert.ok(caught instanceof ToolkitError);
  return caught;
}

for (const withReason of [true, false]) {
  const via = withReason ? "the reason field" : "the title (gateway without the reason field)";

  test(`REQS007 page_not_recognised, read from ${via}: the gateway's advice in order, no prepare command`, async () => {
    const e = await reqs007Error(reqs007("page", withReason));
    assert.equal(e.code, "EXTRACT_PAGE_NOT_RECOGNISED");
    let last = -1;
    for (const step of [
      /product, article or listing page/,
      /retry it once in a few minutes; do not retry in a loop/,
      /--css with explicit selectors/,
      /Preparing the domain again does not change this/,
    ]) {
      const at = e.message.search(step);
      assert.ok(at > last, `${step} missing or out of order in: ${e.message}`);
      last = at;
    }
    const shape = JSON.stringify(e.toJSON());
    assert.doesNotMatch(shape, /extract prepare/, "no prepare command: it would answer ready and loop");
    assert.doesNotMatch(shape, /autoparse|contact Zenrows support/);
  });

  test(`REQS007 domain_not_enabled, read from ${via}: no prepare command, --css`, async () => {
    const e = await reqs007Error(reqs007("allowlist", withReason));
    assert.equal(e.code, "EXTRACT_DOMAIN_NOT_ENABLED");
    assert.match(e.message, /preparing it does not change this/);
    const shape = JSON.stringify(e.toJSON());
    assert.doesNotMatch(shape, /extract prepare|autoparse/);
    assert.match(shape, /--css/);
  });

  test(`REQS007 domain_not_prepared, read from ${via}: the prepare command`, async () => {
    const e = await reqs007Error(reqs007("domain", withReason), "https://www.x.com/p/1");
    assert.equal(e.code, "EXTRACT_DOMAIN_NOT_PREPARED");
    assert.equal(e.toJSON().suggested_commands?.[0], "zenrows extract prepare x.com --url https://www.x.com/p/1 --wait");
  });
}

test("refusalReason trusts the field over the sentence, and ignores a reason it does not know", () => {
  assert.equal(
    refusalReason(JSON.stringify({ title: "Extract did not recognise this page on x.com", reason: "domain_not_prepared" })),
    "domain_not_prepared",
  );
  assert.equal(refusalReason(JSON.stringify({ reason: "something_new", detail: "Extract serves x.com, but" })), "page_not_recognised");
  assert.equal(refusalReason("not json"), "domain_not_prepared");
});

test("runExtract reports legacy AUTH010 like REQS007 and does not retry", async () => {
  const calls: string[] = [];
  await withFetchHandler((url) => {
    calls.push(url);
    return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
  }, async () => {
    await assert.rejects(
      () => runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey"),
      (e: unknown) =>
        e instanceof ToolkitError &&
        e.code === "EXTRACT_DOMAIN_NOT_PREPARED" &&
        e.message.startsWith("Extract hasn't prepared x.com yet. Prepare it with `zenrows extract prepare x.com --url https://x.com`"),
    );
    assert.equal(calls.length, 1, "AUTH010 must not be retried with autoparse");
  });
});

/** Runs fn with stderr captured, and returns what was written to it. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let written = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return written;
}

// fallbackAutoparse is deprecated and has no effect: the refusal is reported in
// one request, with the prepare step, and the caller is told once.
for (const [name, body, status] of [
  ["REQS007", JSON.stringify({ code: "REQS007", detail: "Extract has not been prepared for x.com yet.", status: 403 }), 403],
  ["AUTH010", AUTH010, 402],
] as const) {
  test(`runExtract ignores fallbackAutoparse: true on ${name}, in one request, with one deprecation warning`, async () => {
    const calls: string[] = [];
    const stderr = await captureStderr(() =>
      withFetchHandler((url) => {
        calls.push(url);
        return new Response(body, { status, headers: { "content-type": "application/json" } });
      }, async () => {
        await assert.rejects(
          () => runExtract({ url: "https://x.com", fallbackAutoparse: true }, cfg, defaultPolicy(), "testkey"),
          (e: unknown) =>
            e instanceof ToolkitError &&
            e.code === "EXTRACT_DOMAIN_NOT_PREPARED" &&
            e.suggested_commands?.includes("zenrows extract prepare x.com --url https://x.com --wait") === true,
        );
      }),
    );
    assert.equal(calls.length, 1, "fallbackAutoparse must not retry with autoparse");
    assert.doesNotMatch(calls[0]!, /autoparse=true/);
    assert.equal(stderr.split(FALLBACK_AUTOPARSE_DEPRECATION).length - 1, 1, `want one deprecation warning, got: ${stderr}`);
  });
}

test("runExtract prints no deprecation warning without fallbackAutoparse, or with it false", async () => {
  for (const fallbackAutoparse of [undefined, false]) {
    const stderr = await captureStderr(() =>
      withFetch(JSON.stringify({ parsed: { title: "X" } }), async () => {
        await runExtract({ url: "https://x.com", fallbackAutoparse }, cfg, defaultPolicy(), "testkey");
      }),
    );
    assert.doesNotMatch(stderr, /fallbackAutoparse/);
  }
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

// --- empty extraction must not be a silent success --------------------------
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

test("runExtract flags a result whose fields are all null or empty (empty=true)", async () => {
  const scaffolding = {
    title: null,
    author: { name: "", url: null },
    tags: [],
    comments: [{ body: null, date: "  " }],
  };
  await withFetch(JSON.stringify({ parsed: scaffolding, html: "<html/>" }), async () => {
    const outcome = await runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey");
    assert.deepEqual(outcome.data, scaffolding);
    assert.equal(outcome.empty, true);
  });
});

test("isEmptyData keeps 0, false and one filled nested field as data", () => {
  assert.equal(isEmptyData({ count: 0 }), false);
  assert.equal(isEmptyData({ in_stock: false }), false);
  assert.equal(isEmptyData({ title: null, items: [{ name: null }, { name: "A" }] }), false);
  assert.equal(isEmptyData([[], {}, null, ""]), true);
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

// --- 422 no_data_extracted: an answer, not a failure ------------------------
const NO_DATA = JSON.stringify({
  code: "no_data_extracted",
  detail: "Extract found no data on this page.",
  status: 422,
  title: "No data extracted",
});

test("runExtract reports 422 no_data_extracted as an empty result, in one request, without fallback", async () => {
  const calls: string[] = [];
  await withFetchHandler((url) => {
    calls.push(url);
    return new Response(NO_DATA, { status: 422, headers: { "content-type": "application/problem+json" } });
  }, async () => {
    const outcome = await runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey");
    assert.equal(outcome.method, "extract");
    assert.equal(outcome.empty, true);
    assert.equal(outcome.noDataExtracted, true);
    assert.equal(outcome.data, undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /extract=auto/);
  });
});

test("runExtract under --validate turns 422 no_data_extracted into EXTRACT_VALIDATION_FAILED", async () => {
  await withFetch(NO_DATA, async () => {
    await assert.rejects(
      () => runExtract({ url: "https://x.com", validate: true }, cfg, defaultPolicy(), "testkey"),
      (e: unknown) =>
        e instanceof ToolkitError && e.code === "EXTRACT_VALIDATION_FAILED" && /no data/i.test(e.message),
    );
  }, { status: 422 });
});

test("runExtract keeps treating other 422s as a failed fetch", async () => {
  const RESP001 = JSON.stringify({ code: "RESP001", detail: "Could not get content.", status: 422 });
  await withFetch(RESP001, async () => {
    await assert.rejects(
      () => runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey"),
      (e: unknown) => e instanceof ToolkitError && e.code === "FETCH_FAILED",
    );
  }, { status: 422 });
});

test("a 422 no_data_extracted outside an Extract request is still a failed fetch", async () => {
  await withFetch(NO_DATA, async () => {
    await assert.rejects(
      () => runExtract({ url: "https://x.com", method: "autoparse" }, cfg, defaultPolicy(), "testkey"),
      (e: unknown) => e instanceof ToolkitError && e.code === "FETCH_FAILED",
    );
  }, { status: 422 });
});

// --- 422 blocked_document: a block page, not an extraction miss --------------
test("runExtract turns 422 blocked_document into EXTRACT_FAILED with a stronger-fetch hint, without fallback", async () => {
  const BLOCKED = JSON.stringify({
    code: "blocked_document",
    detail: "The page fetched for this request had no real content.",
    status: 422,
  });
  const calls: string[] = [];
  await withFetchHandler((url) => {
    calls.push(url);
    return new Response(BLOCKED, { status: 422, headers: { "content-type": "application/problem+json" } });
  }, async () => {
    await assert.rejects(
      () => runExtract({ url: "https://x.com" }, cfg, defaultPolicy(), "testkey"),
      (e: unknown) =>
        e instanceof ToolkitError &&
        e.code === "EXTRACT_FAILED" &&
        /blocked_document/.test(e.message) &&
        /--js-render --premium-proxy/.test(e.next_action ?? ""),
    );
    assert.equal(calls.length, 1);
  });
});
