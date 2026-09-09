import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchUsage, usageUrl } from "../src/core/usage.ts";
import { ToolkitError } from "../src/core/errors.ts";
import { fmt } from "../src/cli/commands/usage.ts";
import type { UsageDetails } from "../src/core/usage.ts";

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

test("formatPlanName maps Trial → Free", async () => {
  const { formatPlanName, formatPlanStatus } = await import("../src/cli/commands/usage.ts");
  assert.equal(formatPlanName("Trial"), "Free");
  assert.equal(formatPlanName("TRIAL"), "Free");
  assert.equal(formatPlanName("Build"), "Build");
  assert.equal(formatPlanStatus("TRIALING"), "active");
  assert.equal(formatPlanStatus("active"), "active");
});

test("fetchUsage maps a 402 (over usage limit) to POLICY_MAX_CREDITS_EXCEEDED", async () => {
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ code: "AUTH004", title: "Usage exceeded (AUTH004)", status: 402 }),
      { status: 402, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchUsage("https://api.zenrows.com/v1/", "x", { fetchImpl: fakeFetch }),
    (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_MAX_CREDITS_EXCEEDED",
  );
});

test("zenrows usage reports credits, which the endpoint has always returned", () => {
  // Verified against the live endpoint: it sends usage_credits and credit_limit
  // alongside the dollar figure. Neither was declared on UsageDetails, so the command
  // printed only dollars and left the reader to convert — which they cannot do, because
  // the rate is per plan (Free $0.001/credit, larger plans a volume rate).
  assert.equal(fmt(62982), "62,982");
  assert.equal(fmt(35999978), "35,999,978");
});

test("UsageDetails carries credits and the per-plan rate", () => {
  const sample: UsageDetails = {
    status: "ACTIVE",
    usage: 5.66823039823616,
    usage_credits: 62982,
    credit_limit: 35999978,
    usage_percent: 0,
    plan: { name: "Business", price: 3239.89, unit_cost: 8.9997e-5, recurrence: "YEARLY" },
  };
  // credit_limit * unit_cost === plan.price is the invariant that makes the rate per-plan
  // rather than a platform constant. Holds on the live response.
  assert.ok(Math.abs(sample.credit_limit! * sample.plan!.unit_cost! - sample.plan!.price!) < 0.01);
  assert.ok(Math.abs(sample.usage! / sample.usage_credits! - sample.plan!.unit_cost!) < 1e-8);
});
