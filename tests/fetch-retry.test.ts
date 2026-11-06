/**
 * `--retries` on fetch and extract, following the shared retry policy. Fetch
 * is stubbed and the waits are injected, so only the command tests wait (the
 * 250 ms floor).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { scrape, retryAfterMs, jitterMs, neverSent } from "../src/core/http.ts";
import { fetch_, normalizeRetries } from "../src/cli/commands/fetch.ts";
import { extract } from "../src/cli/commands/extract.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { savePolicy, defaultPolicy } from "../src/core/policy.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { ToolkitError } from "../src/core/errors.ts";
import type { Command } from "../src/cli/command.ts";
import { tempRoot } from "./helpers.ts";

const API = "https://api.zenrows.com/v1/";
const RESP009 = JSON.stringify({ code: "RESP009", status: 503, title: "Service temporarily at capacity (RESP009)" });

/** An answer, or undici's rejection for a transport failure with this `cause.code`. */
type Step = { status: number; body?: string; headers?: Record<string, string> } | { network: string };
const OK: Step = { status: 200, body: "<html>ok</html>", headers: { "content-type": "text/html" } };

const sysErr = (code: string, syscall?: string) => Object.assign(new Error(`${syscall ?? "op"} ${code}`), { code, syscall });
const fetchFailed = (cause: unknown) => new TypeError("fetch failed", { cause });

/** Run `fn` with a global fetch that answers `steps` in order (repeating the last); returns the call count. */
async function withSteps(steps: Step[], fn: () => Promise<unknown>, onCall?: () => void): Promise<number> {
  let n = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    onCall?.();
    const step = steps[Math.min(n++, steps.length - 1)]!;
    if ("network" in step) throw fetchFailed(sysErr(step.network, "connect"));
    return new Response(step.body ?? "", { status: step.status, headers: { "content-type": "application/json", ...step.headers } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
  return n;
}

/** Records each wait instead of sleeping. */
function waits(): { sleep: (ms: number) => Promise<void>; list: number[] } {
  const list: number[] = [];
  return { list, sleep: async (ms) => void list.push(ms) };
}

const errorOf = async (p: Promise<unknown>): Promise<ToolkitError> => {
  try {
    await p;
  } catch (err) {
    return err as ToolkitError;
  }
  assert.fail("expected an error");
};

// --- shared conformance vectors -------------------------------------------------

test("conformance: Retry-After is whole seconds, clamped to 0.25-30 s; anything else means jitter", () => {
  const vectors: Array<[string, number | undefined]> = [
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
  for (const [header, expected] of vectors) assert.equal(retryAfterMs(header), expected, JSON.stringify(header));
});

test("conformance: full jitter is uniform(0.25 s, min(30 s, 2^attempt s))", () => {
  for (const [attempt, high] of [[0, 1000], [1, 2000], [2, 4000], [5, 30_000], [9, 30_000]] as const) {
    assert.equal(jitterMs(attempt, () => 0), 250, `attempt ${attempt}`);
    assert.equal(jitterMs(attempt, () => 1), high, `attempt ${attempt}`);
  }
});

test("conformance: only a network error before the request reached the API is retryable", () => {
  const agg = (...errors: Error[]) => new AggregateError(errors);
  const vectors: Array<[string, unknown, boolean]> = [
    ...["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"].map(
      (code) => [code, sysErr(code), true] as [string, unknown, boolean],
    ),
    ...["UND_ERR_SOCKET", "ECONNRESET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "EPIPE"].map(
      (code) => [code, sysErr(code), false] as [string, unknown, boolean],
    ),
    ["no cause", undefined, false],
    ["ETIMEDOUT on connect", sysErr("ETIMEDOUT", "connect"), true],
    ["ETIMEDOUT on read", sysErr("ETIMEDOUT", "read"), false],
    ["ETIMEDOUT, no syscall", sysErr("ETIMEDOUT"), false],
    ["happy eyeballs, every address refused", agg(sysErr("ECONNREFUSED", "connect"), sysErr("ECONNREFUSED", "connect")), true],
    ["happy eyeballs, refused and connect timeout", agg(sysErr("ECONNREFUSED", "connect"), sysErr("ETIMEDOUT", "connect")), true],
    ["happy eyeballs, one address reset", agg(sysErr("ECONNREFUSED", "connect"), sysErr("ECONNRESET", "read")), false],
    ["happy eyeballs, one read timeout", agg(sysErr("ETIMEDOUT", "connect"), sysErr("ETIMEDOUT", "read")), false],
    ["happy eyeballs, no errors", agg(), false],
  ];
  for (const [name, cause, expected] of vectors) assert.equal(neverSent(cause), expected, name);
});

// --- which answers are retried --------------------------------------------------

test("429, 502, 503 and 504 are retried, a 429 whatever its body says", async () => {
  const credits = JSON.stringify({ code: "AUTH004", title: "No credit available. Upgrade your plan." });
  for (const [status, body] of [[429, "{}"], [429, credits], [502, ""], [503, RESP009], [504, ""]] as const) {
    const w = waits();
    const calls = await withSteps([{ status, body }, OK], async () => {
      assert.equal((await scrape(API, "k", { url: "https://x" }, { retries: 2, sleep: w.sleep })).status, 200);
    });
    assert.equal(calls, 2, `${status} ${body}`);
    assert.equal(w.list.length, 1);
  }
});

test("other statuses, a target status and a client timeout are sent once", async () => {
  const cases: Array<[string, Step, Record<string, string | boolean>]> = [
    ...[400, 401, 402, 403, 404, 422, 500].map((status) => [`HTTP ${status}`, { status, body: "{}" }, {}] as [string, Step, Record<string, string | boolean>]),
    ["--original-status 503", { status: 503, body: "<html>target</html>" }, { original_status: true }],
    ["allowed_status_codes 503", { status: 503, body: "<html>target</html>" }, { allowed_status_codes: "503" }],
  ];
  for (const [name, step, params] of cases) {
    const w = waits();
    const calls = await withSteps([step, OK], () => scrape(API, "k", { url: "https://x", ...params }, { retries: 2, sleep: w.sleep }).catch(() => {}));
    assert.equal(calls, 1, name);
    assert.deepEqual(w.list, [], name);
  }
  let hung = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = ((_u: unknown, init?: RequestInit) => {
    hung++;
    return new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  }) as typeof fetch;
  try {
    const err = await errorOf(scrape(API, "k", { url: "https://x" }, { retries: 5, timeoutMs: 20, sleep: waits().sleep }));
    assert.equal(err.code, "REQUEST_TIMEOUT");
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(hung, 1);
});

test("each wait is Retry-After, capped at 30 s, or full jitter", async () => {
  for (const [header, check] of [
    ["7", (ms: number) => ms === 7000],
    ["3600", (ms: number) => ms === 30_000],
    ["abc", (ms: number) => ms >= 250 && ms <= 1000],
  ] as const) {
    const w = waits();
    await withSteps([{ status: 503, headers: { "retry-after": header } }, OK], () => scrape(API, "k", { url: "https://x" }, { retries: 2, sleep: w.sleep }));
    assert.equal(w.list.length, 1);
    assert.ok(check(w.list[0]!), `Retry-After ${header}: waited ${w.list[0]}`);
  }
});

test("no retry starts more than 90 s after the first request", async () => {
  // Each request takes 40 s. A 503 waits 5 s: retries start at 45 s and 90 s, and one at 135 s would be late.
  // A refused connection waits at most 1 s, then 2 s: the third retry would start after 120 s.
  for (const step of [{ status: 503, headers: { "retry-after": "5" } }, { network: "ECONNREFUSED" }] as Step[]) {
    let clock = 0;
    const calls = await withSteps(
      [step],
      () => scrape(API, "k", { url: "https://x" }, { retries: 10, now: () => clock, sleep: async (ms) => void (clock += ms) }).catch(() => {}),
      () => (clock += 40_000),
    );
    assert.equal(calls, 3, JSON.stringify(step));
  }
});

test("after the retries, a 502, 503 or 504 says to run the same command again; a 429 keeps its error", async () => {
  for (const status of [502, 503, 504]) {
    const calls = await withSteps([{ status, body: RESP009 }], async () => {
      const err = await errorOf(scrape(API, "k", { url: "https://x.com/p" }, { retries: 2, sleep: waits().sleep }));
      assert.equal(err.code, "FETCH_FAILED");
      assert.equal(err.message, `The Zenrows API answered HTTP ${status} after 2 retries.`);
      assert.match(err.next_action, /^Wait a minute, then run the same command again\./);
      assert.deepEqual(err.suggested_commands, []);
    });
    assert.equal(calls, 3);
  }
  await withSteps([{ status: 429, body: "{}" }], async () => {
    const err = await errorOf(scrape(API, "k", { url: "https://x.com/p" }, { retries: 1, sleep: waits().sleep }));
    assert.equal(err.message, "Rate limited (HTTP 429).");
    assert.deepEqual(err.suggested_commands, ["zenrows fetch https://x.com/p"]);
  });
});

test("real sockets: a refused port is retried; a connection closed after the request was sent is not", async () => {
  let hits = 0;
  const server = createServer((req) => {
    hits++;
    req.resume();
    req.on("end", () => req.socket.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const err = await errorOf(scrape(`http://127.0.0.1:${port}/v1/`, "k", { url: "https://x" }, { retries: 5, sleep: waits().sleep }));
  assert.equal(err.code, "BACKEND_UNAVAILABLE");
  assert.equal(hits, 1);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  // Now nothing listens. localhost may resolve to several addresses (happy eyeballs).
  for (const host of ["127.0.0.1", "localhost"]) {
    const w = waits();
    const e = await errorOf(scrape(`http://${host}:${port}/v1/`, "k", { url: "https://x" }, { retries: 2, sleep: w.sleep }));
    assert.equal(e.code, "BACKEND_UNAVAILABLE");
    assert.equal(w.list.length, 2, host);
  }
});

test("--retries takes a whole number, 0 or more", () => {
  assert.equal(normalizeRetries(undefined), undefined);
  assert.equal(normalizeRetries("0"), 0);
  assert.equal(normalizeRetries("3"), 3);
  for (const bad of [true, "", "-1", "1.5", "many", "1e1", "0x2", " 3", "+1"]) {
    assert.throws(() => normalizeRetries(bad), (err: unknown) => (err as ToolkitError).code === "INVALID_USAGE", String(bad));
  }
});

// --- the commands ---------------------------------------------------------------

/** Run a command with --json in a fresh workspace; every request answers `steps`. */
async function runCommand(cmd: Command, args: string[], steps: Step[]): Promise<{ exit: number; out: any; calls: number }> {
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  savePolicy(defaultPolicy(), root);
  saveApiKey("0".repeat(41), root);
  process.chdir(root);
  const write = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((s: string | Uint8Array, ...rest: unknown[]) =>
    typeof s === "string" ? ((buf += s), true) : (write as (...a: unknown[]) => boolean)(s, ...rest)) as typeof process.stdout.write;
  let exit = -1;
  try {
    const calls = await withSteps(steps, async () => {
      exit = await cmd.run(args, { json: true, yes: false });
    });
    return { exit, out: JSON.parse(buf), calls };
  } finally {
    process.stdout.write = write;
    process.chdir(cwd);
    cleanup();
  }
}

// What 1.12.0 prints for each failure. Without --retries, nothing changes.
const UNCHANGED: Array<[string, Step, Record<string, unknown>]> = [
  [
    "503 RESP009",
    { status: 503, body: RESP009, headers: { "retry-after": "0" } },
    {
      code: "FETCH_FAILED",
      message: "Protected Fetch failed with HTTP 503.",
      likely_cause: RESP009,
      next_action: "Retry with --manual --js-render --premium-proxy, or inspect the trace for the exact reason.",
      suggested_commands: ["zenrows fetch https://x.com/p --manual --js-render --premium-proxy"],
    },
  ],
  [
    "429",
    { status: 429, body: "{}" },
    {
      code: "FETCH_FAILED",
      message: "Rate limited (HTTP 429).",
      likely_cause: "{}. This looks like a concurrency cap or a target-site rate limit, not Free-plan credit exhaustion.",
      next_action: "Wait a few seconds and retry. If it persists, lower concurrency / parallel requests.",
      suggested_commands: ["zenrows fetch https://x.com/p"],
    },
  ],
  [
    "refused connection",
    { network: "ECONNREFUSED" },
    {
      code: "BACKEND_UNAVAILABLE",
      message: "Could not reach the Zenrows API.",
      likely_cause: "Network error after 0s: fetch failed",
      next_action: "Check connectivity and retry. Verify api base in `zenrows config show`.",
      suggested_commands: ["zenrows status", "zenrows config show"],
    },
  ],
];

for (const [name, step, expected] of UNCHANGED) {
  test(`without --retries, fetch sends a ${name} once, with the 1.12.0 error`, async () => {
    const { exit, out, calls } = await runCommand(fetch_, ["https://x.com/p"], [step, OK]);
    assert.equal(calls, 1);
    assert.equal(exit, 1);
    const { code, message, likely_cause, next_action, suggested_commands } = out.error;
    assert.deepEqual({ code, message, likely_cause, next_action, suggested_commands }, expected);
  });
}

test("extract without --retries sends a 503 once; fetch and extract with --retries 1 send it again", async () => {
  const busy: Step = { status: 503, body: RESP009, headers: { "retry-after": "0" } };
  assert.equal((await runCommand(extract, ["https://x.com/p"], [busy, OK])).calls, 1);
  for (const [cmd, ok] of [[fetch_, OK], [extract, { status: 200, body: '{"title":"ok"}' }]] as const) {
    const { exit, out, calls } = await runCommand(cmd, ["https://x.com/p", "--retries", "1"], [busy, ok]);
    assert.equal(calls, 2);
    assert.equal(exit, 0);
    assert.equal(out.ok, true);
  }
});

test("extract prepare is never retried: a 429 and a 503 are answers", async () => {
  for (const [status, code] of [[429, "out_of_allowance"], [503, "overloaded"]] as const) {
    const body = JSON.stringify({ code, status, title: code, detail: code });
    const step: Step = { status, body, headers: { "content-type": "application/problem+json", "retry-after": "0" } };
    const { exit, out, calls } = await runCommand(extract, ["prepare", "x.com", "--url", "https://x.com/p"], [step]);
    assert.equal(exit, 1);
    assert.match(out.error.code, /^EXTRACT_PREPARE_/);
    assert.equal(calls, 1, code);
  }
});
