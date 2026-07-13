import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchUsage, usageUrl } from "../src/core/usage.ts";
import { ToolkitError } from "../src/core/errors.ts";

test("usageUrl derives subscriptions/self/details from the api base", () => {
  assert.equal(usageUrl("https://api.zenrows.com/v1/"), "https://api.zenrows.com/v1/subscriptions/self/details");
  assert.equal(usageUrl("http://localhost:9990/v1"), "http://localhost:9990/v1/subscriptions/self/details");
});

test("fetchUsage parses a 200 body and sends the X-API-Key header", async () => {
  let sentKey: unknown;
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    sentKey = (init?.headers as Record<string, string>)["X-API-Key"];
    return new Response(
      JSON.stringify({
        status: "ACTIVE",
        usage: 10,
        usage_percent: 5,
        period_ends_at: "2026-08-01T00:00:00Z",
        plan: { name: "Business", recurrence: "MONTHLY", products: { api: { concurrency: { limit: 20, usage: 1 } } } },
        top_ups: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const u = await fetchUsage("https://api.zenrows.com/v1/", "zr-key", { fetchImpl: fakeFetch });
  assert.equal(sentKey, "zr-key");
  assert.equal(u.status, "ACTIVE");
  assert.equal(u.plan?.name, "Business");
  assert.equal(u.plan?.products?.api?.concurrency?.limit, 20);
  assert.equal(u.usage_percent, 5);
});

test("fetchUsage throws AUTH_INVALID on 401", async () => {
  const fakeFetch = (async () => new Response("invalid key", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchUsage("https://api.zenrows.com/v1/", "x", { fetchImpl: fakeFetch }),
    (e: unknown) => e instanceof ToolkitError && e.code === "AUTH_INVALID",
  );
});
