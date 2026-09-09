import { test } from "node:test";
import assert from "node:assert/strict";
import { quotaExhausted, ToolkitError } from "../src/core/errors.ts";
import { isQuotaError } from "../src/core/http.ts";

test("quotaExhausted surfaces the claim URL", () => {
  const err = quotaExhausted("https://api.zenrows.com/v1/?url=x", "https://x/claim/t");
  assert.ok(err instanceof ToolkitError);
  assert.equal(err.code, "POLICY_MAX_CREDITS_EXCEEDED");
  assert.ok(err.next_action.includes("https://x/claim/t"));
});

test("quotaExhausted says the allowance renews, on both account states", () => {
  // A spent allowance is not a paywall: it comes back at the period boundary. Leaving
  // that out is what makes an exhausted agent retry-loop instead of waiting or upgrading.
  for (const claim of ["https://x/claim/t", undefined]) {
    const err = quotaExhausted("https://api.zenrows.com/v1/?url=x", claim);
    assert.match(err.next_action, /renew/i);
    if (!claim) {
      // The route out is a deep link that lands with the purchase already open,
      // not a generic dashboard URL the reader has to navigate from.
      assert.ok(err.next_action.includes("https://app.zenrows.com/billing?topup=open"));
      assert.ok(err.next_action.includes("https://app.zenrows.com/plans"));
    }
    assert.ok(
      err.suggested_commands?.includes("zenrows usage"),
      "the exact renewal date is one command away, so point at it in both states",
    );
  }
});

test("isQuotaError distinguishes credit exhaustion from concurrency/target 429s", () => {
  // Genuine account credit/quota exhaustion → claim nudge.
  assert.equal(isQuotaError(JSON.stringify({ code: "REQS002", title: "You have used all your credits" })), true);
  assert.equal(isQuotaError(JSON.stringify({ title: "Monthly quota exceeded" })), true);
  assert.equal(isQuotaError("insufficient credits, please upgrade your plan"), true);
  // Concurrency cap → generic retry, never a credit nudge.
  assert.equal(isQuotaError(JSON.stringify({ title: "Concurrency limit reached" })), false);
  // Target-site rate limit / opaque body → generic retry.
  assert.equal(isQuotaError("429 Too Many Requests"), false);
  assert.equal(isQuotaError(""), false);
});
