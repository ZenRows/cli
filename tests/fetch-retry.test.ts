/**
 * Fetch and Extract retry policy: which failures are retried, how long each
 * wait is, and when the CLI stops. Every test stubs fetch and injects the
 * sleep (and the clock, where the budget matters), so nothing here waits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { scrape, failedBeforeSend, DEFAULT_RETRIES, RETRY_BUDGET_MS, type ScrapeOptions } from "../src/core/http.ts";
import { fullJitterMs, retryAfterMs, retryAfterDelayMs, crawlBackoffMs } from "../src/core/backoff.ts";
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

/**
 * A response to answer, or a fetch() rejection shaped like undici's:
 * `TypeError("fetch failed")` whose `cause.code` says what went wrong
 * (`cause: null` means no cause at all).
 */
type Step = { status: number; body?: string; headers?: Record<string, string> } | { network: string | null };

/** undici's rejection for a transport failure with the given `cause.code`. */
function fetchFailed(code: string | null): TypeError {
  if (code === null) return new TypeError("fetch failed");
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}

/** The request was never written: connection refused. */
const REFUSED: Step = { network: "ECONNREFUSED" };

/** A fetch that answers `steps` in order (repeating the last) and counts calls. */
function seqFetch(steps: Step[], onCall?: () => void): { impl: typeof fetch; calls: () => number } {
  let n = 0;
  const impl = (async () => {
    onCall?.();
    const step = steps[Math.min(n, steps.length - 1)]!;
    n++;
    if ("network" in step) throw fetchFailed(step.network);
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

// Shared retry policy, conformance vectors: Retry-After header value -> delay.
const RETRY_AFTER_VECTORS: Array<[string, number | undefined]> = [
  ["5", 5000],
  ["0", 250],
  [" 7 ", 7000],
  ["99999", 30_000],
  ["1.5", undefined],
  ["-1", undefined],
  ["1e3", undefined],
  ["0x10", undefined],
  ["", undefined],
  ["abc", undefined],
  ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
];

for (const [header, expected] of RETRY_AFTER_VECTORS) {
  test(`conformance: Retry-After ${JSON.stringify(header)} -> ${expected ?? "jitter"}`, () => {
    assert.equal(retryAfterDelayMs(header), expected);
  });
}

test("conformance: a Retry-After the policy ignores falls back to jitter on the wire", async () => {
  for (const [header, expected] of RETRY_AFTER_VECTORS) {
    const { impl } = seqFetch([{ status: 503, headers: { "retry-after": header } }, OK]);
    const { sleepImpl, waits } = recordSleep();
    // random() = 1 makes the first jitter wait exactly 1000 ms, which no vector produces.
    await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl, randomImpl: () => 1 });
    assert.deepEqual(waits, [expected ?? 1000], `Retry-After ${JSON.stringify(header)}`);
  }
});

test("Retry-After: 0 waits 250 ms on Fetch, so a server cannot drive a tight loop", async () => {
  const { impl, calls } = seqFetch([{ status: 503, headers: { "retry-after": "0" } }]);
  const { sleepImpl, waits } = recordSleep();
  await assert.rejects(() => scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl }));
  assert.equal(calls(), 3);
  assert.deepEqual(waits, [250, 250]);
});

test("crawl keeps its own Retry-After reading: whole seconds, capped at 30 s, 0 is no wait", () => {
  assert.equal(retryAfterMs("0"), 0);
  assert.equal(retryAfterMs("7"), 7000);
  assert.equal(retryAfterMs("3600"), 30_000);
  assert.equal(retryAfterMs("1.5"), undefined);
  assert.equal(retryAfterMs(null), undefined);
});

// Shared retry policy, conformance vectors: jitter bounds, with the random
// source at 0 and at its maximum. The CLI has no option for the 30 s cap; the
// last two rows exercise the internal parameter the vectors name.
const JITTER_VECTORS: Array<{ attempt: number; capMs?: number; low: number; high: number }> = [
  { attempt: 0, low: 250, high: 1000 },
  { attempt: 1, low: 250, high: 2000 },
  { attempt: 2, low: 250, high: 4000 },
  { attempt: 5, low: 250, high: 30_000 },
  { attempt: 9, low: 250, high: 30_000 },
  { attempt: 4, capMs: 5000, low: 250, high: 5000 },
  { attempt: 3, capMs: 100, low: 250, high: 250 },
];

for (const v of JITTER_VECTORS) {
  test(`conformance: jitter attempt ${v.attempt}${v.capMs ? `, cap ${v.capMs} ms` : ""} -> [${v.low}, ${v.high}] ms`, () => {
    assert.equal(fullJitterMs(v.attempt, () => 0, v.capMs), v.low);
    assert.equal(fullJitterMs(v.attempt, () => 1, v.capMs), v.high);
  });
}

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

test("the response path waits fullJitter(retry index): exactly 1 s, then 2 s, at the random maximum", async () => {
  for (const [random, expected] of [
    [() => 1, [1000, 2000]],
    [() => 0, [250, 250]],
  ] as const) {
    const { impl } = seqFetch([{ status: 503 }, { status: 503 }, OK]);
    const { sleepImpl, waits } = recordSleep();
    await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl, randomImpl: random });
    assert.deepEqual(waits, expected);
  }
});

test("the network-error path waits fullJitter(retry index) too, never 0", async () => {
  for (const [random, expected] of [
    [() => 1, [1000, 2000]],
    [() => 0, [250, 250]],
  ] as const) {
    const { impl } = seqFetch([REFUSED, REFUSED, OK]);
    const { sleepImpl, waits } = recordSleep();
    await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl, randomImpl: random });
    assert.deepEqual(waits, expected);
  }
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

// Shared retry policy: only failures before the request was written are retried.
for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
  test(`a network error before the request was sent (${code}) is retried`, async () => {
    const { impl, calls } = seqFetch([{ network: code }, { network: code }, OK]);
    const { sleepImpl, waits } = recordSleep();
    const r = await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl });
    assert.equal(r.status, 200);
    assert.equal(calls(), 3);
    assert.equal(waits.length, 2);
    assert.equal(r.attempts, 3);
  });
}

for (const code of ["UND_ERR_SOCKET", "ECONNRESET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "EPIPE", null]) {
  test(`a network error that may follow the request (${code ?? "no cause"}) is not retried`, async () => {
    const { impl, calls } = seqFetch([{ network: code }, OK]);
    const { sleepImpl, waits } = recordSleep();
    await assert.rejects(
      () => scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl }),
      (err: unknown) => (err as ToolkitError).code === "BACKEND_UNAVAILABLE",
    );
    assert.equal(calls(), 1);
    assert.deepEqual(waits, []);
  });
}

test("a refused connection to every address of a host (AggregateError) counts as never sent", () => {
  const refused = (addr: string) => Object.assign(new Error(`connect ECONNREFUSED ${addr}`), { code: "ECONNREFUSED" });
  const all = new AggregateError([refused("::1"), refused("127.0.0.1")]);
  assert.equal(failedBeforeSend(new TypeError("fetch failed", { cause: all })), true);
  const mixed = new AggregateError([refused("::1"), Object.assign(new Error("reset"), { code: "ECONNRESET" })]);
  assert.equal(failedBeforeSend(new TypeError("fetch failed", { cause: mixed })), false);
  assert.equal(failedBeforeSend(new DOMException("aborted", "AbortError")), false);
  assert.equal(failedBeforeSend(new TypeError("fetch failed")), false);
});

/** Start a real HTTP server on a free port; resolves with its base URL. */
async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}/v1/` };
}

/** The real global fetch, counting calls. */
function countingFetch(): { impl: typeof fetch; calls: () => number } {
  let n = 0;
  const real = globalThis.fetch;
  return { impl: ((...args: Parameters<typeof fetch>) => (n++, real(...args))) as typeof fetch, calls: () => n };
}

test("real socket: a refused port is retried, because the request was never sent", async () => {
  const { server, base } = await listen(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { impl, calls } = countingFetch();
  const { sleepImpl, waits } = recordSleep();
  await assert.rejects(
    () => scrape(base, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl }),
    (err: unknown) => {
      const e = err as ToolkitError;
      assert.equal(e.code, "BACKEND_UNAVAILABLE");
      assert.match(e.likely_cause, /ECONNREFUSED/);
      return true;
    },
  );
  assert.equal(calls(), 3);
  assert.equal(waits.length, 2);
});

test("real socket: a connection closed after the API read the request is not retried", async () => {
  let hits = 0;
  const { server, base } = await listen((req) => {
    hits++;
    req.resume();
    req.on("end", () => req.socket.destroy());
  });
  try {
    const { impl, calls } = countingFetch();
    const { sleepImpl, waits } = recordSleep();
    await assert.rejects(
      () => scrape(base, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl, retries: 5 }),
      (err: unknown) => (err as ToolkitError).code === "BACKEND_UNAVAILABLE",
    );
    assert.equal(calls(), 1);
    assert.equal(hits, 1);
    assert.deepEqual(waits, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

// Shared retry policy, conformance vectors: retry decision (GET). The CLI
// never retried 422 or 500 and keeps it that way; it only sends GET, so the
// POST rows do not apply.
for (const status of [400, 401, 402, 403, 404, 422, 500]) {
  test(`conformance: HTTP ${status} is not retried`, async () => {
    const body = JSON.stringify({ code: "REQS002", title: "Bad request (REQS002)", status });
    const { impl, calls } = seqFetch([{ status, body }, OK]);
    const { sleepImpl, waits } = recordSleep();
    await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl }).catch(() => undefined);
    assert.equal(calls(), 1);
    assert.deepEqual(waits, []);
  });
}

test("conformance: 422 no_data_extracted and any other 422 are not retried by the CLI", async () => {
  for (const body of [JSON.stringify({ code: "no_data_extracted" }), JSON.stringify({ code: "RESP001" })]) {
    const { impl, calls } = seqFetch([{ status: 422, body }, OK]);
    const { sleepImpl } = recordSleep();
    await scrape(API, "k", { url: "https://x", extract: "auto" }, { fetchImpl: impl, sleepImpl }).catch(() => undefined);
    assert.equal(calls(), 1, body);
  }
});

// AUTH004 and AUTH014 are 402 answers in the API, and 402 is not retried. A 429
// never carries them, so the retry decision must not special-case them either.
test("a 429 is retried even when its body carries an out-of-credits code (AUTH004, AUTH014)", async () => {
  for (const code of ["AUTH004", "AUTH014"]) {
    const body = JSON.stringify({ code, title: `Usage exceeded (${code})`, detail: "No credit available" });
    const { impl, calls } = seqFetch([{ status: 429, body }, OK]);
    const { sleepImpl, waits } = recordSleep();
    const r = await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl });
    assert.equal(r.status, 200, code);
    assert.equal(calls(), 2, code);
    assert.equal(waits.length, 1, code);
  }
});

test("a 402 AUTH004 (account out of credits) is sent once and reported as out of credits", async () => {
  const body = JSON.stringify({ code: "AUTH004", title: "Usage exceeded (AUTH004)", detail: "No credit available", status: 402 });
  const { impl, calls } = seqFetch([{ status: 402, body }, OK]);
  const { sleepImpl, waits } = recordSleep();
  await assert.rejects(
    () => scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl }),
    (err: unknown) => (err as ToolkitError).code === "POLICY_MAX_CREDITS_EXCEEDED",
  );
  assert.equal(calls(), 1);
  assert.deepEqual(waits, []);
});

test("a 429 is retried by its code, not by keywords: concurrency, rate limit and non-JSON pages all retry", async () => {
  const bodies = [
    JSON.stringify({ code: "AUTH006", title: "Concurrency limit reached (AUTH006)" }),
    JSON.stringify({ code: "AUTH008", title: "Rate limit reached (AUTH008)", detail: "Upgrade your plan for a higher limit." }),
    "<html>Too many requests. Upgrade to premium for more.</html>",
    "Too Many Requests",
  ];
  for (const body of bodies) {
    const { impl, calls } = seqFetch([{ status: 429, body, headers: { "content-type": "text/html" } }, OK]);
    const { sleepImpl, waits } = recordSleep();
    const r = await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl });
    assert.equal(r.status, 200, body);
    assert.equal(calls(), 2, body);
    assert.equal(waits.length, 1, body);
  }
});

// With original_status or allowed_status_codes, a 429/5xx may be the target
// site's own answer: retrying would hit the target again and may be charged.
for (const status of [429, 502, 503, 504]) {
  test(`--original-status: a ${status} belongs to the target and is not retried`, async () => {
    const { impl, calls } = seqFetch([{ status, body: "<html>target page</html>", headers: { "content-type": "text/html" } }, OK]);
    const { sleepImpl, waits } = recordSleep();
    await scrape(API, "k", { url: "https://x", original_status: true }, { fetchImpl: impl, sleepImpl }).catch(() => undefined);
    assert.equal(calls(), 1);
    assert.deepEqual(waits, []);
  });
}

test("allowed_status_codes that covers the status: not retried; one that does not: retried", async () => {
  for (const [allowed, expectedCalls] of [
    ["404, 503", 1],
    ["503", 1],
    ["404", 3],
    ["5030", 3],
  ] as const) {
    const { impl, calls } = seqFetch([{ status: 503, body: "<html>target</html>", headers: { "content-type": "text/html" } }]);
    const { sleepImpl } = recordSleep();
    await scrape(API, "k", { url: "https://x", allowed_status_codes: allowed }, { fetchImpl: impl, sleepImpl }).catch(() => undefined);
    assert.equal(calls(), expectedCalls, `allowed_status_codes=${allowed}`);
  }
});

test("runFetch --original-status sends a target 503 once", async () => {
  const { impl, calls } = seqFetch([{ status: 503, body: "<html>maintenance</html>", headers: { "content-type": "text/html" } }, OK]);
  await withGlobalFetch(impl, async () => {
    await runFetch({ url: "https://x.com", originalStatus: true }, defaultConfig(), defaultPolicy(), "k").catch(() => undefined);
  });
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

test("no network-error retry starts when it would pass the 90 s budget", async () => {
  let clock = 0;
  const { impl, calls } = seqFetch([REFUSED], () => (clock += 40_000));
  const opts: ScrapeOptions = {
    fetchImpl: impl,
    sleepImpl: async (ms) => void (clock += ms),
    nowImpl: () => clock,
    randomImpl: () => 1,
    retries: 10,
  };
  await assert.rejects(() => scrape(API, "k", { url: "https://x" }, opts));
  // 40 s + 1 s fits; 81 s + 2 s fits; 123 s + 4 s does not.
  assert.equal(calls(), 3);
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

test("--retries accepts whole decimal digits from 0, and rejects anything else", () => {
  assert.equal(normalizeRetries(undefined), undefined);
  assert.equal(normalizeRetries("0"), 0);
  assert.equal(normalizeRetries("3"), 3);
  assert.equal(normalizeRetries("010"), 10);
  for (const bad of ["-1", "1.5", "many", "", "1e1", "0x2", " 3", "3 ", "+1", "1_0", "Infinity", "99999999999999999999"]) {
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
      // The cause quotes the API's own words; it does not claim a reason of its own.
      assert.match(err.likely_cause, /Service temporarily at capacity \(RESP009\): All capacity is busy right now/);
      assert.match(err.likely_cause, /not charged/);
      assert.doesNotMatch(err.likely_cause, /preparing this layout/);
      assert.match(err.next_action, /Wait at least 1 s.*run the same command again/);
      assert.doesNotMatch(err.next_action, /support|escalat/i);
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

test("503 RESP009 on Extract quotes the API's title for each of its two documented meanings", async () => {
  for (const title of ["Extract could not finish this page right now", "Extract is at capacity for new pages right now"]) {
    const body = JSON.stringify({ code: "RESP009", status: 503, title, type: "https://docs.zenrows.com/api-error-codes#RESP009" });
    const { impl } = seqFetch([{ status: 503, body }]);
    await assert.rejects(
      () => scrape(API, "k", { url: "https://x.com/p", extract: "auto" }, { fetchImpl: impl, retries: 0 }),
      (err: unknown) => {
        const e = err as ToolkitError;
        assert.equal(e.code, "SERVICE_BUSY");
        assert.ok(e.likely_cause.includes(title), e.likely_cause);
        assert.match(e.next_action, /run the same command again/);
        return true;
      },
    );
  }
});

test("503 RESP009 on Extract without a title names both meanings and asserts neither", async () => {
  const { impl } = seqFetch([{ status: 503, body: JSON.stringify({ code: "RESP009" }) }]);
  await assert.rejects(
    () => scrape(API, "k", { url: "https://x.com/p", extract: "auto" }, { fetchImpl: impl, retries: 0 }),
    (err: unknown) => {
      const e = err as ToolkitError;
      assert.match(e.likely_cause, /either it could not finish this page yet, or it is at capacity/);
      assert.match(e.next_action, /about a minute .* longer if it says it is at capacity/);
      return true;
    },
  );
});

for (const status of [429, 502, 503, 504]) {
  test(`after the retries, a ${status} does not advise the most expensive configuration`, async () => {
    const { impl } = seqFetch([{ status, body: "upstream trouble", headers: { "content-type": "text/plain" } }]);
    const { sleepImpl } = recordSleep();
    await assert.rejects(
      () => scrape(API, "k", { url: "https://x.com/p" }, { fetchImpl: impl, sleepImpl, rerunCommand: "zenrows fetch https://x.com/p --json" }),
      (err: unknown) => {
        const e = err as ToolkitError;
        assert.equal(e.code, "FETCH_FAILED");
        assert.match(e.message, /after 2 retries/);
        assert.deepEqual(e.suggested_commands, ["zenrows fetch https://x.com/p --json"]);
        assert.doesNotMatch(`${e.next_action} ${e.suggested_commands.join(" ")}`, /Retry with --manual/);
        assert.ok(!e.suggested_commands.some((c) => /--js-render|--premium-proxy/.test(c)));
        return true;
      },
    );
  });
}

test("a target 503 under --original-status keeps the stronger-fetch advice: the target may be blocking", async () => {
  const { impl } = seqFetch([{ status: 503, body: "<html>blocked</html>", headers: { "content-type": "text/html" } }]);
  await assert.rejects(
    () => scrape(API, "k", { url: "https://x.com/p", original_status: true }, { fetchImpl: impl }),
    (err: unknown) => /--js-render --premium-proxy/.test((err as ToolkitError).suggested_commands.join(" ")),
  );
});

test("the result counts the HTTP requests sent", async () => {
  const { impl } = seqFetch([{ status: 503 }, OK]);
  const { sleepImpl } = recordSleep();
  const r = await scrape(API, "k", { url: "https://x" }, { fetchImpl: impl, sleepImpl });
  assert.equal(r.attempts, 2);
  const once = await scrape(API, "k", { url: "https://x" }, { fetchImpl: seqFetch([OK]).impl });
  assert.equal(once.attempts, 1);
});

test("a 503 RESP009 that clears on retry returns the page", async () => {
  const { impl } = seqFetch([{ status: 503, body: RESP009 }, OK]);
  const { sleepImpl } = recordSleep();
  const r = await scrape(API, "k", { url: "https://x", extract: "auto" }, { fetchImpl: impl, sleepImpl });
  assert.equal(r.status, 200);
});

test("an Extract AUTH010 is sent once: it is not retried, and nothing falls back to Autoparse", async () => {
  const seen: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    seen.push(u.searchParams.get("extract") ? "extract" : u.searchParams.get("autoparse") ? "autoparse" : "other");
    return new Response(AUTH010, { status: 402, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await withGlobalFetch(impl, async () => {
    await assert.rejects(
      () => runExtract({ url: "https://x.com/p" }, defaultConfig(), defaultPolicy(), "k"),
      (err: unknown) => (err as ToolkitError).code === "EXTRACT_DOMAIN_NOT_PREPARED",
    );
  });
  assert.deepEqual(seen, ["extract"]);
});
