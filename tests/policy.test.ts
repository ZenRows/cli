import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertBrowserAllowed,
  assertDomainAllowed,
  assertExperimentalAllowed,
  assertWithinLimits,
  defaultPolicy,
} from "../src/core/policy.ts";
import { ToolkitError } from "../src/core/errors.ts";

test("blocked_domains rejects matching hosts (incl. subdomains)", () => {
  const pol = defaultPolicy();
  pol.blocked_domains = ["example.com"];
  assert.throws(() => assertDomainAllowed("https://example.com/x", pol), (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_BLOCKED_DOMAIN");
  assert.throws(() => assertDomainAllowed("https://sub.example.com/x", pol), (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_BLOCKED_DOMAIN");
});

test("allowed_domains switches to allow-list mode", () => {
  const pol = defaultPolicy();
  pol.allowed_domains = ["mysite.com"];
  assert.doesNotThrow(() => assertDomainAllowed("https://mysite.com/a", pol));
  assert.throws(() => assertDomainAllowed("https://other.com/a", pol), (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_BLOCKED_DOMAIN");
});

test("empty policy allows any valid host but rejects malformed URLs", () => {
  const pol = defaultPolicy();
  assert.doesNotThrow(() => assertDomainAllowed("https://anything.example/x", pol));
  assert.throws(() => assertDomainAllowed("not-a-url", pol), (e: unknown) => e instanceof ToolkitError && e.code === "INVALID_USAGE");
});

test("experimental gated off by default; browser on by default (opt-out)", () => {
  const pol = defaultPolicy();
  assert.equal(pol.allow_experimental, false);
  assert.equal(pol.allow_browser, true);
  assert.throws(() => assertExperimentalAllowed(pol, "zenrows browser"), (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_EXPERIMENTAL_DISABLED");
  // Browser is a GA product, on by default — the gate only fires if opted out.
  assert.doesNotThrow(() => assertBrowserAllowed(pol));
  assert.throws(
    () => assertBrowserAllowed({ ...pol, allow_browser: false }),
    (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_BROWSER_DISABLED",
  );
});

test("assertWithinLimits allows runs within the caps (and no-ops on omitted fields)", () => {
  const pol = { ...defaultPolicy(), max_pages_per_run: 100, max_credits_per_run: 500 };
  assert.doesNotThrow(() => assertWithinLimits({ pages: 100, credits: 500 }, pol)); // at the cap, ok
  assert.doesNotThrow(() => assertWithinLimits({ pages: 10 }, pol)); // credits omitted
  assert.doesNotThrow(() => assertWithinLimits({}, pol)); // nothing to check
});

test("assertWithinLimits rejects a run over the page cap", () => {
  const pol = { ...defaultPolicy(), max_pages_per_run: 100 };
  assert.throws(
    () => assertWithinLimits({ pages: 101 }, pol, "batch"),
    (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_LIMIT_EXCEEDED",
  );
});

test("assertWithinLimits rejects a run over the credit cap", () => {
  const pol = { ...defaultPolicy(), max_credits_per_run: 500 };
  assert.throws(
    () => assertWithinLimits({ pages: 1, credits: 501 }, pol, "batch"),
    (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_LIMIT_EXCEEDED",
  );
});
