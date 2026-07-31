import { test } from "node:test";
import assert from "node:assert/strict";
import { assertUsable, getCapability, isUsable, loadCapabilities } from "../src/core/capabilities.ts";
import { ToolkitError } from "../src/core/errors.ts";

test("capability matrix loads with the honest classifications", () => {
  const caps = loadCapabilities();
  assert.equal(caps.protected_fetch?.status, "available");
  assert.equal(caps.extract?.status, "beta");
  assert.equal(caps.browser?.status, "available");
  assert.equal(caps.mcp?.status, "available");
  // Batch is a real product in open beta.
  assert.equal(caps.batch?.status, "beta");
});

test("isUsable true for available + open beta, false for absent capabilities", () => {
  assert.equal(isUsable("protected_fetch"), true);
  assert.equal(isUsable("extract"), true);
  assert.equal(isUsable("batch"), true); // open beta is usable
  assert.equal(isUsable("nope"), false);
});

test("assertUsable passes for available + experimental + beta", () => {
  assert.doesNotThrow(() => assertUsable("protected_fetch"));
  assert.doesNotThrow(() => assertUsable("browser")); // experimental is allowed (policy gates it)
  assert.doesNotThrow(() => assertUsable("extract"));
  assert.doesNotThrow(() => assertUsable("batch"));
  assert.throws(
    () => assertUsable("nope"),
    (e: unknown) => e instanceof ToolkitError && e.code === "CAPABILITY_UNAVAILABLE",
  );
});

test("protected_fetch maps to the confirmed /v1/ endpoint", () => {
  const cap = getCapability("protected_fetch");
  assert.match(cap!.backend, /api\.zenrows\.com\/v1\//);
});
