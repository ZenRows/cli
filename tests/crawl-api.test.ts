import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CRAWL_API_BASE_ENV,
  DEFAULT_CRAWL_API_BASE,
  contentIdOf,
  crawlBase,
  createCrawl,
  downloadCrawl,
  getCrawl,
  getCrawlContent,
  listAllResults,
  listCrawls,
  stopCrawl,
  waitForCrawl,
  type CrawlWithResults,
} from "../src/core/crawl-api.ts";
import { ToolkitError } from "../src/core/errors.ts";

const crawlBody = {
  crawl_id: "c_1",
  status: "running",
  url: "https://example.com/products/",
  depth: 1,
  max_items: 10,
  max_pages: 10,
  coverage: { pages_fetched: 0, pages_failed: 0, items_found: 0 },
  created_at: "2026-10-15T09:00:00Z",
};

/** Build a fetch stub that returns a fixed body, recording each call. */
function stubFetch(status: number, payload: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function problem(status: number, code: string, detail = "nope", headers: Record<string, string> = {}) {
  return stubFetch(status, { code, title: code, detail, status, instance: "urn:zenrows:request:x" }, {
    "content-type": "application/problem+json",
    ...headers,
  });
}

test("crawlBase defaults to the production API and honors ZENROWS_CRAWL_API_BASE", () => {
  assert.equal(crawlBase(), DEFAULT_CRAWL_API_BASE);
  process.env[CRAWL_API_BASE_ENV] = "https://example.com/v1/";
  try {
    assert.equal(crawlBase(), "https://example.com/v1");
  } finally {
    delete process.env[CRAWL_API_BASE_ENV];
  }
});

test("createCrawl posts /crawls with X-API-Key and sends only the fields the caller set", async () => {
  const { impl, calls } = stubFetch(202, crawlBody, { location: "/v1/crawls/c_1" });
  const c = await createCrawl(
    { url: "https://example.com/products/", depth: 1, max_items: 3, include_patterns: ["/product/"], exclude_patterns: [] },
    { apiKey: "zr-key", fetchImpl: impl },
  );
  assert.equal(c.crawl_id, "c_1");
  const call = calls[0]!;
  assert.equal(call.url, `${DEFAULT_CRAWL_API_BASE}/crawls`);
  assert.equal(call.init?.method, "POST");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers["X-API-Key"], "zr-key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["Idempotency-Key"], undefined);
  assert.ok(!call.url.includes("apikey"), "the key never rides the query string");
  const body = JSON.parse(String(call.init?.body));
  assert.deepEqual(body, { url: "https://example.com/products/", depth: 1, max_items: 3, include_patterns: ["/product/"] });
  assert.ok(!("discovery" in body));
  assert.ok(!("output_format" in body));
});

test("createCrawl sends output_format html and Idempotency-Key when asked", async () => {
  const { impl, calls } = stubFetch(202, crawlBody);
  await createCrawl({ url: "https://example.com/products/", depth: 2, max_pages: 5, output_format: "html" }, {
    apiKey: "k",
    fetchImpl: impl,
    idempotencyKey: "idem-1",
  });
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.deepEqual(body, { url: "https://example.com/products/", depth: 2, max_pages: 5, output_format: "html" });
  assert.equal((calls[0]!.init?.headers as Record<string, string>)["Idempotency-Key"], "idem-1");
});

test("getCrawl passes cursor + limit and parses results, tolerating unknown fields", async () => {
  const { impl, calls } = stubFetch(200, {
    ...crawlBody,
    status: "a_future_status",
    brand_new_field: { x: 1 },
    results: [{ url: "https://example.com/product/a", content_status: "fetched", content_url: "/v1/crawls/c_1/contents/ct_9" }],
    next_cursor: "cur_2",
  });
  const page = await getCrawl("c_1", { apiKey: "k", cursor: "cur_1", limit: 50, fetchImpl: impl });
  const u = new URL(calls[0]!.url);
  assert.equal(u.pathname, "/v1/crawls/c_1");
  assert.equal(u.searchParams.get("cursor"), "cur_1");
  assert.equal(u.searchParams.get("limit"), "50");
  assert.equal(calls[0]!.init?.method, "GET");
  assert.equal(page.results[0]!.content_status, "fetched");
  assert.equal(contentIdOf(page.results[0]!), "ct_9");
  assert.equal(page.next_cursor, "cur_2");
  assert.equal(page.brand_new_field && typeof page.brand_new_field, "object");
});

test("listCrawls reads one page; next_cursor is absent on the last page", async () => {
  const { impl, calls } = stubFetch(200, { crawls: [{ ...crawlBody, status: "completed" }] });
  const page = await listCrawls({ apiKey: "k", limit: 5, fetchImpl: impl });
  assert.equal(new URL(calls[0]!.url).pathname, "/v1/crawls");
  assert.equal(new URL(calls[0]!.url).searchParams.get("limit"), "5");
  assert.equal(new URL(calls[0]!.url).searchParams.get("cursor"), null);
  assert.equal(page.crawls.length, 1);
  assert.equal(page.next_cursor, undefined);
});

test("stopCrawl posts /crawls/{id}/stop with no body", async () => {
  const { impl, calls } = stubFetch(200, { crawl_id: "c_1", status: "stopped", stop_reason: "user" });
  const s = await stopCrawl("c_1", { apiKey: "k", fetchImpl: impl });
  assert.equal(s.status, "stopped");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal(calls[0]!.init?.body, undefined);
  assert.match(calls[0]!.url, /\/crawls\/c_1\/stop$/);
});

test("getCrawlContent returns the HTML body and its type", async () => {
  const { impl, calls } = stubFetch(200, "<html><body>hi</body></html>", { "content-type": "text/html; charset=utf-8" });
  const out = await getCrawlContent("c_1", "ct_9", { apiKey: "k", fetchImpl: impl });
  assert.match(calls[0]!.url, /\/crawls\/c_1\/contents\/ct_9$/);
  assert.match(out.contentType, /text\/html/);
  assert.equal(out.body, "<html><body>hi</body></html>");
});

test("downloadCrawl returns the NDJSON and X-Crawl-Status", async () => {
  const { impl, calls } = stubFetch(200, '{"url":"https://example.com/product/a"}\n{"url":"https://example.com/product/b"}\n', {
    "content-type": "application/x-ndjson",
    "x-crawl-status": "running",
  });
  const out = await downloadCrawl("c_1", { apiKey: "k", fetchImpl: impl });
  assert.match(calls[0]!.url, /\/crawls\/c_1\/download$/);
  assert.equal(out.status, "running");
  assert.equal(out.ndjson.trim().split("\n").length, 2);
});

test("403 REQS008 maps to CRAWL_NOT_ENABLED with the API's wording", async () => {
  const { impl } = problem(403, "REQS008", "Crawl is not enabled for this account.");
  await assert.rejects(
    () => createCrawl({ url: "https://example.com/products/", depth: 1 }, { apiKey: "k", fetchImpl: impl }),
    (e: unknown) =>
      e instanceof ToolkitError &&
      e.code === "CRAWL_NOT_ENABLED" &&
      e.message === "Crawl is not enabled for this account." &&
      e.server_code === "REQS008" &&
      e.crawl_id === undefined,
  );
});

test("any other 403 maps to CRAWL_FAILED", async () => {
  const { impl } = problem(403, "REQS001");
  await assert.rejects(
    () => createCrawl({ url: "https://example.com/products/", depth: 1 }, { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "CRAWL_FAILED" && e.server_code === "REQS001",
  );
});

test("404 crawl_not_found maps to CRAWL_NOT_FOUND", async () => {
  const { impl } = problem(404, "crawl_not_found");
  await assert.rejects(
    () => getCrawl("c_nope", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) =>
      e instanceof ToolkitError &&
      e.code === "CRAWL_NOT_FOUND" &&
      e.server_code === "crawl_not_found" &&
      e.crawl_id === "c_nope",
  );
});

test("404 content_not_found maps to CRAWL_CONTENT_NOT_FOUND with content guidance", async () => {
  const { impl } = problem(404, "content_not_found");
  await assert.rejects(
    () => getCrawlContent("c_1", "ct_x", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) =>
      e instanceof ToolkitError && e.code === "CRAWL_CONTENT_NOT_FOUND" && /content_status/.test(e.next_action) && e.crawl_id === "c_1",
  );
});

test("400 and 422 map to CRAWL_INVALID_REQUEST with the server code", async () => {
  for (const [status, code] of [
    [422, "invalid_parameter"],
    [400, "unknown_parameter"],
  ] as const) {
    const { impl } = problem(status, code, "'depth' is out of range.");
    await assert.rejects(
      () => createCrawl({ url: "https://example.com/products/", depth: 1 }, { apiKey: "k", fetchImpl: impl }),
      (e: unknown) => e instanceof ToolkitError && e.code === "CRAWL_INVALID_REQUEST" && e.server_code === code,
    );
  }
});

test("422 idempotency_key_reused says to send a new key, not to retry as is", async () => {
  const { impl } = problem(422, "idempotency_key_reused");
  await assert.rejects(
    () => createCrawl({ url: "https://example.com/products/", depth: 1 }, { apiKey: "k", fetchImpl: impl, idempotencyKey: "k1" }),
    (e: unknown) => e instanceof ToolkitError && e.code === "CRAWL_INVALID_REQUEST" && /new key, or no key/.test(e.next_action),
  );
});

test("409 maps to CRAWL_REQUEST_IN_FLIGHT", async () => {
  const { impl } = problem(409, "idempotency_request_in_flight");
  await assert.rejects(
    () => createCrawl({ url: "https://example.com/products/", depth: 1 }, { apiKey: "k", fetchImpl: impl, idempotencyKey: "k1" }),
    (e: unknown) => e instanceof ToolkitError && e.code === "CRAWL_REQUEST_IN_FLIGHT" && /finished/.test(e.next_action),
  );
});

test("429 too_many_crawls maps to CRAWL_TOO_MANY_CRAWLS with retry_after and no retry", async () => {
  const { impl, calls } = problem(429, "too_many_crawls", "Too many crawls.", { "retry-after": "30" });
  await assert.rejects(
    () => createCrawl({ url: "https://example.com/products/", depth: 1 }, { apiKey: "k", fetchImpl: impl, idempotencyKey: "k1" }),
    (e: unknown) =>
      e instanceof ToolkitError &&
      e.code === "CRAWL_TOO_MANY_CRAWLS" &&
      e.retry_after === 30 &&
      e.server_code === "too_many_crawls" &&
      /shared with its Batch jobs/.test(e.likely_cause),
  );
  assert.equal(calls.length, 1);
});

test("402 maps to CRAWL_QUOTA_EXCEEDED, and AUTH014 to CRAWL_KEY_CAP_REACHED, with the shared advice", async () => {
  const quota = problem(402, "AUTH004", "Usage limit reached.");
  await assert.rejects(
    () => createCrawl({ url: "https://example.com/products/", depth: 1 }, { apiKey: "k", fetchImpl: quota.impl }),
    (e: unknown) =>
      e instanceof ToolkitError && e.code === "CRAWL_QUOTA_EXCEEDED" && e.server_code === "AUTH004" && /zenrows usage/.test(e.next_action),
  );
  const cap = problem(402, "AUTH014", "Key cap reached.");
  await assert.rejects(
    () => getCrawl("c_1", { apiKey: "k", fetchImpl: cap.impl }),
    (e: unknown) =>
      e instanceof ToolkitError &&
      e.code === "CRAWL_KEY_CAP_REACHED" &&
      e.server_code === "AUTH014" &&
      e.crawl_id === "c_1" &&
      /settings\/api-keys/.test(e.next_action),
  );
});

test("an error body without a code leaves server_code unset", async () => {
  const { impl } = stubFetch(500, "upstream exploded");
  await assert.rejects(
    () => getCrawl("c_1", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "CRAWL_FAILED" && !("server_code" in e.toJSON()),
  );
});

test("401 maps to AUTH_INVALID and 500 to CRAWL_FAILED", async () => {
  const a = problem(401, "AUTH002");
  await assert.rejects(() => listCrawls({ apiKey: "k", fetchImpl: a.impl }), (e: unknown) => e instanceof ToolkitError && e.code === "AUTH_INVALID");
  const b = problem(500, "internal_error");
  await assert.rejects(() => getCrawl("c", { apiKey: "k", fetchImpl: b.impl }), (e: unknown) => e instanceof ToolkitError && e.code === "CRAWL_FAILED");
});

test("a transport failure maps to BACKEND_UNAVAILABLE", async () => {
  const impl = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => getCrawl("c", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BACKEND_UNAVAILABLE" && e.crawl_id === "c",
  );
});

/** A stub that serves `pages` in order, recording the cursor each call sent. */
function pagedFetch(pages: Array<Partial<CrawlWithResults>>) {
  const cursors: Array<string | null> = [];
  const limits: Array<string | null> = [];
  let i = 0;
  const impl = (async (url: string) => {
    const u = new URL(url);
    cursors.push(u.searchParams.get("cursor"));
    limits.push(u.searchParams.get("limit"));
    const page = pages[Math.min(i++, pages.length - 1)]!;
    return new Response(JSON.stringify({ ...crawlBody, ...page }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, cursors, limits, calls: () => i };
}

test("listAllResults follows next_cursor with the page size and stops on null", async () => {
  const { impl, cursors, limits } = pagedFetch([
    { status: "completed", results: [{ url: "https://example.com/product/1" }], next_cursor: "c1" },
    { status: "completed", results: [{ url: "https://example.com/product/2" }], next_cursor: "c2" },
    { status: "completed", results: [{ url: "https://example.com/product/3" }], next_cursor: null },
  ]);
  const { results, crawl, partial } = await listAllResults("c_1", { apiKey: "k", fetchImpl: impl, pageSize: 500 });
  assert.equal(partial, false);
  assert.ok(limits.every((l) => l === "500"));
  assert.deepEqual(results.map((r) => r.url), ["https://example.com/product/1", "https://example.com/product/2", "https://example.com/product/3"]);
  assert.deepEqual(cursors, [null, "c1", "c2"]);
  assert.equal(crawl.status, "completed");
});

test("listAllResults returns what a running crawl kept, ending at the first empty page", async () => {
  const { impl, calls } = pagedFetch([
    { status: "running", results: [{ url: "https://example.com/product/1" }], next_cursor: "c1" },
    { status: "running", results: [], next_cursor: "c1" },
  ]);
  const { results, partial } = await listAllResults("c_1", { apiKey: "k", fetchImpl: impl });
  assert.deepEqual(results.map((r) => r.url), ["https://example.com/product/1"]);
  assert.equal(partial, true);
  assert.equal(calls(), 2);
});

test("waitForCrawl polls with limit=1 until the status leaves running, backing off", async () => {
  const { impl, limits, calls } = pagedFetch([
    { status: "running", results: [], next_cursor: "c" },
    { status: "running", results: [], next_cursor: "c" },
    { status: "running", results: [], next_cursor: "c" },
    { status: "completed", results: [], next_cursor: null },
  ]);
  const sleeps: number[] = [];
  const c = await waitForCrawl("c_1", { apiKey: "k", fetchImpl: impl, sleepImpl: async (ms) => void sleeps.push(ms) });
  assert.equal(c.status, "completed");
  assert.equal(calls(), 4);
  assert.ok(limits.every((l) => l === "1"));
  assert.deepEqual(sleeps, [2000, 3000, 4500]);
});

test("waitForCrawl treats failed and stopped as terminal", async () => {
  for (const status of ["failed", "stopped"]) {
    const { impl } = pagedFetch([{ status, results: [], next_cursor: null }]);
    const c = await waitForCrawl("c_1", { apiKey: "k", fetchImpl: impl, sleepImpl: async () => {} });
    assert.equal(c.status, status);
  }
});

test("waitForCrawl returns the running crawl when the timeout runs out, and does not stop it", async () => {
  const methods: string[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return new Response(JSON.stringify({ ...crawlBody, results: [], next_cursor: "c" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const c = await waitForCrawl("c_1", { apiKey: "k", fetchImpl: impl, timeoutMs: 1, sleepImpl: async () => {} });
  assert.equal(c.status, "running");
  assert.equal(c.crawl_id, "c_1");
  assert.ok(methods.every((m) => m === "GET"), "no stop call on timeout");
});
