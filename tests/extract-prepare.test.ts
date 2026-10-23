import { test } from "node:test";
import assert from "node:assert/strict";
import { PREPARE_HELP, runPrepare } from "../src/cli/commands/extract-prepare.ts";
import { extract } from "../src/cli/commands/extract.ts";
import { exampleUrlsHint, failureNextStep, normalizeDomain, prepareCommand } from "../src/core/prepared-domains-api.ts";

const ctx = { json: true, yes: false };
const BASE = "/v1/extract/prepared-domains";
const RECORD = {
  domain: "example.com",
  status: "preparing",
  state: "received",
  submitted_at: "2026-10-15T09:00:00Z",
  updated_at: "2026-10-15T09:00:00Z",
};
const ALLOWANCE = { used: 3, limit: 10, remaining: 7, month: "2026-10" };

type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown };

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  res({ code, detail: `${code} detail`, status, title: code, ...extra }, status);

/** A fetch stub answering by "METHOD path"; a route may be a list answered in order. */
function stub(routes: Record<string, (() => Response) | (() => Response)[]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) throw new Error(`unexpected ${method} ${url.pathname}`);
    if (Array.isArray(route)) {
      const next = route.length > 1 ? route.shift()! : route[0]!;
      return next();
    }
    return route();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function captureOut(fn: () => unknown): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((s: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof s !== "string") return (orig as (...a: unknown[]) => boolean)(s, ...rest);
    buf += s;
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}

async function run(args: string[], fetchImpl?: typeof fetch, extra: { now?: () => number } = {}) {
  let code = -1;
  const raw = await captureOut(async () => {
    code = await runPrepare(args, ctx, { apiKey: "k", fetchImpl, sleepImpl: async () => {}, intervalMs: 1000, ...extra });
  });
  return { code, out: JSON.parse(raw) as Record<string, any> };
}

test("normalizeDomain and prepareCommand", () => {
  assert.equal(normalizeDomain("https://www.Example.com/p/1"), "example.com");
  assert.equal(normalizeDomain("shop.example.com"), "shop.example.com");
  assert.equal(prepareCommand("https://www.example.com/p/1"), "zenrows extract prepare example.com --url https://www.example.com/p/1");
});

test("prepare submits the domain and example URLs, returns at once without --wait", async () => {
  const { calls, fetchImpl } = stub({ [`POST ${BASE}`]: () => res(RECORD, 202) });
  const { code, out } = await run(
    ["www.example.com", "--url", "https://example.com/p/1", "--url", "https://example.com/list"],
    fetchImpl,
  );
  assert.equal(code, 0);
  assert.equal(out.status, "preparing");
  assert.match(out.next, /zenrows extract prepare status example\.com/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.body, { domain: "example.com", example_urls: ["https://example.com/p/1", "https://example.com/list"] });
  assert.equal(calls[0]!.headers["X-API-Key"], "k");
});

test("prepare --wait polls until ready", async () => {
  const { calls, fetchImpl } = stub({
    [`POST ${BASE}`]: () => res(RECORD, 202),
    [`GET ${BASE}/example.com`]: [
      () => res({ ...RECORD, state: "preparing" }),
      () => res({ ...RECORD, state: "verifying" }),
      () => res({ ...RECORD, status: "ready", state: "ready" }),
    ],
  });
  const { code, out } = await run(["example.com", "--url", "https://example.com/p/1", "--wait"], fetchImpl);
  assert.equal(code, 0);
  assert.equal(out.status, "ready");
  assert.match(out.next, /zenrows extract https:\/\/example\.com\/p\/1/);
  assert.equal(calls.filter((c) => c.method === "GET").length, 3);
});

test("prepare --wait on failed exits 1 with the step for the failure code", async () => {
  const { fetchImpl } = stub({
    [`POST ${BASE}`]: () => res(RECORD, 202),
    [`GET ${BASE}/example.com`]: () =>
      res({ ...RECORD, status: "failed", state: "failed", failure: { code: "unpreparable", detail: "x", slot_consumed: false } }),
  });
  const { code, out } = await run(["example.com", "--url", "https://example.com/p/1", "--wait"], fetchImpl);
  assert.equal(code, 1);
  assert.equal(out.error.code, "EXTRACT_PREPARE_FAILED");
  assert.equal(out.error.server_code, "unpreparable");
  assert.match(out.error.next_action, /different --url pages/);
});

test("prepare --wait gives up after --timeout with EXTRACT_PREPARE_TIMEOUT", async () => {
  let t = 0;
  const { fetchImpl } = stub({
    [`POST ${BASE}`]: () => res(RECORD, 202),
    [`GET ${BASE}/example.com`]: () => res(RECORD),
  });
  const { code, out } = await run(["example.com", "--url", "https://example.com/p/1", "--wait", "--timeout", "3"], fetchImpl, {
    now: () => (t += 1000),
  });
  assert.equal(code, 1);
  assert.equal(out.error.code, "EXTRACT_PREPARE_TIMEOUT");
  assert.deepEqual(out.error.suggested_commands, ["zenrows extract prepare status example.com"]);
});

test("prepare on 409 in_progress follows the running preparation", async () => {
  const { calls, fetchImpl } = stub({
    [`POST ${BASE}`]: () => problem(409, "in_progress"),
    [`GET ${BASE}/example.com`]: () => res({ ...RECORD, state: "verifying" }),
  });
  const { code, out } = await run(["example.com", "--url", "https://example.com/p/1"], fetchImpl);
  assert.equal(code, 0);
  assert.equal(out.already_in_progress, true);
  assert.equal(out.state, "verifying");
  assert.equal(calls.length, 2);
});

test("prepare on 409 in_progress that this account cannot read reports EXTRACT_PREPARE_IN_PROGRESS", async () => {
  const { fetchImpl } = stub({
    [`POST ${BASE}`]: () => problem(409, "in_progress"),
    [`GET ${BASE}/example.com`]: () => problem(404, "not_found"),
  });
  const { code, out } = await run(["example.com", "--url", "https://example.com/p/1"], fetchImpl);
  assert.equal(code, 1);
  assert.equal(out.error.code, "EXTRACT_PREPARE_IN_PROGRESS");
  assert.match(out.error.next_action, /Do not resubmit/);
});

for (const [status, serverCode, code, pattern] of [
  [400, "invalid_argument", "EXTRACT_PREPARE_INVALID", /1 to 5 full page URLs/],
  [429, "out_of_allowance", "EXTRACT_PREPARE_OUT_OF_ALLOWANCE", /Do not retry this month/],
  [503, "overloaded", "EXTRACT_PREPARE_UNAVAILABLE", /do not loop/],
  [503, "disabled", "EXTRACT_PREPARE_UNAVAILABLE", /do not loop/],
] as const) {
  test(`prepare maps ${status} ${serverCode} to ${code}`, async () => {
    const { calls, fetchImpl } = stub({
      [`POST ${BASE}`]: () => problem(status, serverCode, serverCode === "out_of_allowance" ? { used: 10, limit: 10 } : {}),
    });
    const { code: exit, out } = await run(["example.com", "--url", "https://example.com/p/1"], fetchImpl);
    assert.equal(exit, 1);
    assert.equal(out.error.code, code);
    assert.equal(out.error.server_code, serverCode);
    assert.match(out.error.next_action, pattern);
    assert.equal(calls.length, 1);
    if (serverCode === "out_of_allowance") assert.match(out.error.message, /10 of 10 used/);
  });
}

test("prepare rejects zero, six or non-URL --url values before any request", async () => {
  const { calls, fetchImpl } = stub({});
  for (const args of [
    ["example.com"],
    ["example.com", ...Array.from({ length: 6 }, (_, i) => ["--url", `https://example.com/${i}`]).flat()],
    ["example.com", "--url", "example.com/p/1"],
    [],
  ]) {
    const { code, out } = await run(args, fetchImpl);
    assert.equal(code, 1, args.join(" "));
    assert.equal(out.error.code, "INVALID_USAGE", args.join(" "));
  }
  assert.equal(calls.length, 0);
});

test("prepare status shows the record, the allowance and the next step", async () => {
  const { fetchImpl } = stub({
    [`GET ${BASE}/example.com`]: () => res({ ...RECORD, state: "preparing" }),
    [`GET ${BASE}/allowance`]: () => res(ALLOWANCE),
  });
  const { code, out } = await run(["status", "https://www.example.com/"], fetchImpl);
  assert.equal(code, 0);
  assert.equal(out.status, "preparing");
  assert.deepEqual(out.allowance, ALLOWANCE);
  assert.match(out.next, /Preparing/);
});

test("prepare status keeps the record when the allowance call fails", async () => {
  const { fetchImpl } = stub({
    [`GET ${BASE}/example.com`]: () => res({ ...RECORD, status: "ready", state: "ready" }),
    [`GET ${BASE}/allowance`]: () => problem(503, "overloaded"),
  });
  const { code, out } = await run(["status", "example.com"], fetchImpl);
  assert.equal(code, 0);
  assert.equal(out.status, "ready");
  assert.equal(out.allowance, undefined);
  assert.match(out.next, /example\.com is ready: run the extract again/);
  assert.match(out.next, /EXTRACT_PAGE_NOT_RECOGNISED/);
});

test("prepare status on 404 says to prepare the domain first", async () => {
  const { fetchImpl } = stub({
    [`GET ${BASE}/example.com`]: () => problem(404, "not_found"),
    [`GET ${BASE}/allowance`]: () => res(ALLOWANCE),
  });
  const { code, out } = await run(["status", "example.com"], fetchImpl);
  assert.equal(code, 1);
  assert.equal(out.error.code, "EXTRACT_PREPARE_NOT_FOUND");
  assert.match(out.error.next_action, /zenrows extract prepare example\.com --url/);
});

test("failureNextStep: the step comes from failure.code, the slot sentence from failure.slot_consumed", () => {
  assert.match(failureNextStep("x.com", { code: "interrupted" }), /same zenrows extract prepare/);
  assert.match(failureNextStep("x.com", { code: "preparation_exhausted" }), /same zenrows extract prepare/);
  assert.match(failureNextStep("x.com", { code: "discovery_failed" }), /--url page URLs/);
  assert.match(failureNextStep("x.com", { code: "unpreparable" }), /different --url pages/);
  assert.match(failureNextStep("x.com", { code: "preparation_failed" }), /other --url pages/);
  assert.match(failureNextStep("x.com", { code: "verification_failed" }), /support/);
  assert.match(failureNextStep("x.com", { code: "unsupported" }), /support/);
  assert.match(failureNextStep("x.com", { code: "unpreparable", slot_consumed: false }), /did not use an allowance slot/);
  assert.match(failureNextStep("x.com", { code: "unpreparable", slot_consumed: true }), /This attempt used an allowance slot/);
  assert.doesNotMatch(failureNextStep("x.com", { code: "unpreparable" }), /slot/);
});

test("prepare answering ready at once says the domain is already prepared and what a page refusal then means", async () => {
  const { calls, fetchImpl } = stub({ [`POST ${BASE}`]: () => res({ ...RECORD, status: "ready", state: "ready" }, 202) });
  const { code, out } = await run(["example.com", "--url", "https://example.com/search", "--wait"], fetchImpl);
  assert.equal(code, 0);
  assert.equal(out.already_prepared, true);
  assert.match(out.next, /already prepared, so nothing new was submitted: run the extract \(`zenrows extract https:\/\/example\.com\/search`\)\./);
  assert.match(out.next, /Preparing the domain again does not change this/);
  assert.doesNotMatch(out.next, /not covered|contact Zenrows support|autoparse/);
  assert.equal(calls.length, 1, "--wait does not poll a domain that is already ready");
});

test("prepare never auto-creates a Free plan account", async () => {
  const { calls, fetchImpl } = stub({});
  const saved = process.env.ZENROWS_API_KEY;
  delete process.env.ZENROWS_API_KEY;
  let code = -1;
  const raw = await captureOut(async () => {
    code = await runPrepare(["example.com", "--url", "https://example.com/p/1"], ctx, { fetchImpl });
  });
  if (saved !== undefined) process.env.ZENROWS_API_KEY = saved;
  assert.equal(code, 1);
  assert.equal(JSON.parse(raw).error.code, "AUTH_MISSING");
  assert.equal(calls.length, 0);
});

test("zenrows extract routes `prepare` to the prepare command", async () => {
  let code = -1;
  const raw = await captureOut(async () => {
    code = await extract.run(["prepare", "example.com"], ctx);
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(raw).error.code, "INVALID_USAGE", "no --url: rejected locally, no extract of a URL named prepare");
});

async function captureErr(fn: () => unknown): Promise<string> {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = ((s: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof s !== "string") return (orig as (...a: unknown[]) => boolean)(s, ...rest);
    buf += s;
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return buf;
}

test("prepare with fewer than 3 URLs prints a tip on stderr, keeps the JSON and the exit code", async () => {
  for (const urls of [["https://example.com/products/a"], ["https://example.com/products/a", "https://example.com/products/b"]]) {
    const { calls, fetchImpl } = stub({ [`POST ${BASE}`]: () => res(RECORD, 202) });
    let result: Awaited<ReturnType<typeof run>> | undefined;
    const err = await captureErr(async () => {
      result = await run(["example.com", ...urls.flatMap((u) => ["--url", u])], fetchImpl);
    });
    assert.equal(result!.code, 0);
    assert.equal(result!.out.ok, true);
    assert.equal(result!.out.hint, undefined, "the tip never enters the stdout JSON");
    assert.deepEqual((calls[0]!.body as { example_urls: string[] }).example_urls, urls, "1 or 2 URLs are still sent as given");
    assert.match(err, /Tip: .*more related URLs work better/);
    assert.match(err, /same page type \(at least 3, up to 5 in total\)/);
  }
});

test("prepare with 3 or more URLs prints no tip", async () => {
  const { fetchImpl } = stub({ [`POST ${BASE}`]: () => res(RECORD, 202) });
  const urls = ["a", "b", "c"].map((p) => `https://example.com/products/${p}`);
  let code = -1;
  const err = await captureErr(async () => {
    ({ code } = await run(["example.com", ...urls.flatMap((u) => ["--url", u])], fetchImpl));
  });
  assert.equal(code, 0);
  assert.doesNotMatch(err, /Tip:/);
});

test("exampleUrlsHint recommends 3 and is silent from 3 on", () => {
  assert.match(exampleUrlsHint(1) ?? "", /one example URL works/);
  assert.match(exampleUrlsHint(2) ?? "", /2 example URLs work/);
  assert.equal(exampleUrlsHint(3), undefined);
  assert.equal(exampleUrlsHint(5), undefined);
});

test("prepare help recommends several URLs of one page type, not one per page kind", () => {
  assert.doesNotMatch(PREPARE_HELP, /one per page kind/);
  assert.match(PREPARE_HELP, /One works;/);
  assert.match(PREPARE_HELP, /at least 3 pages of the same page type work better/);
  assert.match(PREPARE_HELP, /3 product pages \+\s+2 search-result pages/);
  assert.match(PREPARE_HELP, /products\/a[\s\S]*products\/b[\s\S]*products\/c/);
});
