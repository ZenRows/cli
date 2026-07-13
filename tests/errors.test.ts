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
