/**
 * Fetch and Extract retry policy: which failures are retried, how long each
 * wait is, and when the CLI stops. Every test stubs fetch and injects the
 * sleep (and the clock, where the budget matters), so nothing here waits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrape, DEFAULT_RETRIES, RETRY_BUDGET_MS, type ScrapeOptions } from "../src/core/http.ts";
import { fullJitterMs, retryAfterMs, crawlBackoffMs } from "../src/core/backoff.ts";
import { runFetch } from "../src/adapters/protected-fetch.ts";
import { runExtract } from "../src/adapters/extract.ts";
import { normalizeRetries } from "../src/cli/commands/fetch.ts";
import { defaultConfig } from "../src/core/config.ts";
import { defaultPolicy } from "../src/core/policy.ts";
import { ToolkitError } from "../src/core/errors.ts";

const API = "https://api.zenrows.com/v1/";

const RESP009 = JSON.stringify({
  code: "RESP009",
  detail: "All capacity is busy right now. Retry in a minute.",
  status: 503,
  title: "Service temporarily at capacity (RESP009)",
  type: "https://docs.zenrows.com/api-error-codes#RESP009",
});

const AUTH010 = JSON.stringify({
  code: "AUTH010",
  detail: "Extract is not enabled for this domain.",
  status: 402,
  title: "Feature is not included in plan (AUTH010)",
  type: "https://docs.zenrows.com/api-error-codes#AUTH010",
});

type Step = { status: number; body?: string; headers?: Record<string, string> } | "network";

/** A fetch that answers `steps` in order (repeating the last) and counts calls. */
function seqFetch(steps: Step[], onCall?: () => void): { impl: typeof fetch; calls: () => number } {
  let n = 0;
  const impl = (async () => {
    onCall?.();
    const step = steps[Math.min(n, steps.length - 1)]!;
    n++;
    if (step === "network") throw new TypeError("fetch failed");
    return new Response(step.body ?? "", {
      status: step.status,
      headers: { "content-type": "application/json", ...step.headers },
    });
  }) as unknown as typeof fetch;
  return { impl, calls: () => n };
}

function recordSleep(): { sleepImpl: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleepImpl: async (ms: number) => void waits.push(ms) };
}

function withGlobalFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

const OK: Step = { status: 200, body: "<html>ok</html>", headers: { "content-type": "text/html" } };

// --- delays -------------------------------------------------------------------

test("full jitter stays inside uniform(0.25 s, min(30 s, 1 s x 2^attempt))", () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const ceiling = Math.min(30_000, 1000 * 2 ** attempt);
    assert.equal(fullJitterMs(attempt, () => 0), 250);
    assert.ok(fullJitterMs(attempt, () => 0.999999) <= ceiling);
    assert.ok(fullJitterMs(attempt, () => 0.999999) > ceiling - 1);
    for (let i = 0; i < 200; i++) {
      const ms = fullJitterMs(attempt);
      assert.ok(ms >= 250 && ms <= ceiling, `attempt ${attempt}: ${ms}ms outside [250, ${ceiling}]`);
    }
  }
});

test("Retry-After counts whole seconds only and is capped at 30 s", () => {
  assert.equal(retryAfterMs("7"), 7000);
  assert.equal(retryAfterMs(" 2 "), 2000);
  assert.equal(retryAfterMs("3600"), 30_000);
  assert.equal(retryAfterMs("1.5"), undefined);
  assert.equal(retryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT"), undefined);
  assert.equal(retryAfterMs(null), undefined);
});

test("crawl keeps its own schedule: 250 ms x 2^attempt, capped at 10 s, +/-20%", () => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const base = Math.min(250 * 2 ** attempt, 10_000);
    for (let i = 0; i < 100; i++) {
      const ms = crawlBackoffMs(attempt);
      assert.ok(ms >= base * 0.8 && ms <= base * 1.2, `attempt ${attempt}: ${ms}`);
    }
  }
});

// --- which failures are retried -------------------------------------------------

test("a 503 is retried with full jitter, and the first and second waits keep their bounds", async () => {
  const { impl, calls } = seqFetch([{ status: 503 }, { status: 503 }, OK]);
  const { sleepImpl, waits } = recordSleep();
  const r = await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl });
  assert.equal(r.status, 200);
  assert.equal(calls(), 3);
  assert.equal(waits.length, 2);
  const [first = -1, second = -1] = waits;
  assert.ok(first >= 250 && first <= 1000, `first wait ${first}`);
  assert.ok(second >= 250 && second <= 2000, `second wait ${second}`);
});

for (const status of [429, 502, 504]) {
  test(`HTTP ${status} is retried`, async () => {
    const { impl, calls } = seqFetch([{ status, body: "{}" }, OK]);
    const { sleepImpl, waits } = recordSleep();
    const r = await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl });
    assert.equal(r.status, 200);
    assert.equal(calls(), 2);
    assert.equal(waits.length, 1);
  });
}

test("a network error before any response is retried", async () => {
  const { impl, calls } = seqFetch(["network", "network", OK]);
  const { sleepImpl, waits } = recordSleep();
  const r = await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl });
  assert.equal(r.status, 200);
  assert.equal(calls(), 3);
  assert.equal(waits.length, 2);
});

test("Retry-After is honoured", async () => {
  const { impl } = seqFetch([{ status: 503, headers: { "retry-after": "7" } }, OK]);
  const { sleepImpl, waits } = recordSleep();
  await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl });
  assert.deepEqual(waits, [7000]);
});

test("a large Retry-After is capped at 30 s", async () => {
  const { impl } = seqFetch([{ status: 429, body: "{}", headers: { "retry-after": "3600" } }, OK]);
  const { sleepImpl, waits } = recordSleep();
  await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl });
  assert.deepEqual(waits, [30_000]);
});

for (const status of [400, 401, 404, 422]) {
  test(`HTTP ${status} is not retried`, async () => {
    const body = JSON.stringify({ code: "REQS002", title: "Bad request (REQS002)", status });
    const { impl, calls } = seqFetch([{ status, body }, OK]);
    const { sleepImpl, waits } = recordSleep();
    await assert.rejects(() => scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl }));
    assert.equal(calls(), 1);
    assert.deepEqual(waits, []);
  });
}

test("a 429 that says the account is out of credits is not retried", async () => {
  const body = JSON.stringify({ code: "AUTH004", title: "Usage exceeded", detail: "No credit available" });
  const { impl, calls } = seqFetch([{ status: 429, body }, OK]);
  const { sleepImpl } = recordSleep();
  await assert.rejects(
    () => scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl }),
    (err: unknown) => (err as ToolkitError).code === "POLICY_MAX_CREDITS_EXCEEDED",
  );
  assert.equal(calls(), 1);
});

test("the client timeout is never retried: the API may still finish and charge it", async () => {
  let calls = 0;
  const hanging = ((_input: unknown, init?: { signal?: AbortSignal }) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
    });
  }) as unknown as typeof fetch;
  const { sleepImpl, waits } = recordSleep();
  await assert.rejects(
    () => scrape(API, "k", { url: "https://x" }, { fetchImpl: hanging, sleepImpl, timeoutMs: 20, retries: 5 }),
    (err: unknown) => (err as ToolkitError).code === "REQUEST_TIMEOUT",
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

// --- how many, and for how long ---------------------------------------------------

test("the default is 2 retries: three attempts in all", async () => {
  assert.equal(DEFAULT_RETRIES, 2);
  const { impl, calls } = seqFetch([{ status: 503 }]);
  const { sleepImpl, waits } = recordSleep();
  await assert.rejects(() => scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl }));
  assert.equal(calls(), 3);
  assert.equal(waits.length, 2);
});

test("retries: 0 sends the request once", async () => {
  const { impl, calls } = seqFetch([{ status: 503 }, OK]);
  const { sleepImpl, waits } = recordSleep();
  await assert.rejects(() => scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl, retries: 0 }));
  assert.equal(calls(), 1);
  assert.deepEqual(waits, []);
});

test("no retry starts when it would pass the 90 s budget", async () => {
  assert.equal(RETRY_BUDGET_MS, 90_000);
  let clock = 0;
  // Each attempt takes 40 s; the server asks for 5 s between attempts.
  const { impl, calls } = seqFetch([{ status: 503, headers: { "retry-after": "5" } }], () => (clock += 40_000));
  const opts: ScrapeOptions = {
    fetchImpl: impl,
    sleepImpl: async (ms) => void (clock += ms),
    nowImpl: () => clock,
    retries: 10,
  };
  await assert.rejects(() => scrape(API, "k", { url: "https://x" }, opts));
  // 40 s + 5 s fits (45 s); then 85 s + 5 s = 90 s still fits; then 130 s does not.
  assert.equal(calls(), 3);
  assert.ok(clock <= RETRY_BUDGET_MS + 40_000);
});

test("a retry whose delay alone would pass the budget is skipped", async () => {
  let clock = 0;
  const { impl, calls } = seqFetch([{ status: 503, headers: { "retry-after": "30" } }], () => (clock += 70_000));
  await assert.rejects(() =>
    scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl: async (ms) => void (clock += ms), nowImpl: () => clock }),
  );
  assert.equal(calls(), 1);
});

// --- the flag ---------------------------------------------------------------------

test("--retries accepts whole numbers from 0, and rejects anything else", () => {
  assert.equal(normalizeRetries(undefined), undefined);
  assert.equal(normalizeRetries("0"), 0);
  assert.equal(normalizeRetries("3"), 3);
  for (const bad of ["-1", "1.5", "many", ""]) {
    assert.throws(() => normalizeRetries(bad), (err: unknown) => (err as ToolkitError).code === "INVALID_USAGE", bad);
  }
});

test("runFetch threads --retries 0 through to the HTTP client", async () => {
  const { impl, calls } = seqFetch([{ status: 503 }, OK]);
  await withGlobalFetch(impl, async () => {
    await assert.rejects(() => runFetch({ url: "https://x.com", retries: 0 }, defaultConfig(), defaultPolicy(), "k"));
  });
  assert.equal(calls(), 1);
});

// --- the outcome after retries ------------------------------------------------------

test("503 RESP009 on Extract is SERVICE_BUSY: not charged, retry shortly, no escalation", async () => {
  const { impl, calls } = seqFetch([{ status: 503, body: RESP009, headers: { "retry-after": "1" } }]);
  const { sleepImpl } = recordSleep();
  await assert.rejects(
    () => scrape(API, "k", { url: "https://x.com/p", extract: "auto" }, { fetchImpl: impl, sleepImpl }),
    (err: unknown) => {
      assert.ok(err instanceof ToolkitError);
      assert.equal(err.code, "SERVICE_BUSY");
      assert.equal(err.server_code, "RESP009");
      assert.equal(err.retry_after, 1);
      assert.match(err.message, /RESP009 after 2 retries/);
      assert.match(err.message, /not charged/i);
      assert.match(err.likely_cause, /still preparing this layout; the request was not charged/);
      assert.match(err.next_action, /retry/i);
      assert.deepEqual(err.suggested_commands, ["zenrows extract https://x.com/p"]);
      assert.ok(!err.suggested_commands.some((c) => /--js-render|--premium-proxy|--manual/.test(c)));
      return true;
    },
  );
  assert.equal(calls(), 3);
});

test("503 RESP009 on Fetch is SERVICE_BUSY with a fetch retry command", async () => {
  const { impl } = seqFetch([{ status: 503, body: RESP009 }]);
  await assert.rejects(
    () => scrape(API, "k", { url: "https://x.com/p" }, { fetchImpl: impl, retries: 0 }),
    (err: unknown) => {
      const e = err as ToolkitError;
      assert.equal(e.code, "SERVICE_BUSY");
      assert.match(e.likely_cause, /not charged/);
      assert.doesNotMatch(e.message, /after \d+ retr/);
      assert.deepEqual(e.suggested_commands, ["zenrows fetch https://x.com/p"]);
      return true;
    },
  );
});

test("a 503 RESP009 that clears on retry returns the page", async () => {
  const { impl } = seqFetch([{ status: 503, body: RESP009 }, OK]);
  const { sleepImpl } = recordSleep();
  const r = await scrape(API, "k", { url: "https://x", extract: "auto" }, { fetchImpl: impl, sleepImpl });
  assert.equal(r.status, 200);
});

test("the Extract-not-enabled fallback to autoparse is unchanged and spends no retries", async () => {
  const seen: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    seen.push(u.searchParams.get("extract") ? "extract" : u.searchParams.get("autoparse") ? "autoparse" : "other");
    if (u.searchParams.get("extract")) {
      return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ title: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await withGlobalFetch(impl, async () => {
    const outcome = await runExtract({ url: "https://x.com/p" }, defaultConfig(), defaultPolicy(), "k");
    assert.equal(outcome.fellBackToAutoparse, true);
  });
  assert.deepEqual(seen, ["extract", "autoparse"]);
});
