import { test } from "node:test";
import assert from "node:assert/strict";
import { assertUsable, getCapability, isUsable, loadCapabilities } from "../src/core/capabilities.ts";
import { ToolkitError } from "../src/core/errors.ts";

test("capability matrix loads with the honest classifications", () => {
  const caps = loadCapabilities();
  assert.equal(caps.protected_fetch?.status, "available");
  assert.equal(caps.extract?.status, "available");
  assert.equal(caps.browser?.status, "experimental");
  assert.equal(caps.mcp?.status, "available");
  // Batch is a real product in beta.
  assert.equal(caps.batch?.status, "beta");
});

test("isUsable true for available, false for absent capabilities", () => {
  assert.equal(isUsable("protected_fetch"), true);
  assert.equal(isUsable("extract"), true);
  assert.equal(isUsable("batch"), false); // beta is not usable (cloud needs beta access)
});

test("assertUsable passes for available + experimental, throws for absent", () => {
  assert.doesNotThrow(() => assertUsable("protected_fetch"));
  assert.doesNotThrow(() => assertUsable("browser")); // experimental is allowed (policy gates it)
  assert.throws(() => assertUsable("batch"), (e: unknown) => e instanceof ToolkitError && e.code === "CAPABILITY_UNAVAILABLE"); // beta is not usable
});

test("protected_fetch maps to the confirmed /v1/ endpoint", () => {
  const cap = getCapability("protected_fetch");
  assert.match(cap!.backend, /api\.zenrows\.com\/v1\//);
});
