import { test } from "node:test";
import assert from "node:assert/strict";
import { tempRoot } from "./helpers.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { resolveApiKey } from "../src/core/auth.ts";
import { readAccount } from "../src/core/agent-account.ts";
import { ensureApiKey } from "../src/core/ensure-key.ts";
import { ToolkitError } from "../src/core/errors.ts";
import { defaultPolicy } from "../src/core/policy.ts";

const fakeSignup = async () => ({ apiKey: "zr-auto", accountId: "u9", claimUrl: "https://x/claim/tok" });

test("auto-provisions and persists key + account when policy allows", async () => {
  const { root, cleanup } = tempRoot();
  const prev = process.env.ZENROWS_API_KEY; delete process.env.ZENROWS_API_KEY;
  try {
    createWorkspace(root);
    const key = await ensureApiKey(defaultPolicy(), { projectRoot: root, signupImpl: fakeSignup });
    assert.equal(key, "zr-auto");
    assert.equal(resolveApiKey(root).key, "zr-auto");
    assert.equal(readAccount(root)?.accountId, "u9");
    assert.equal(readAccount(root)?.unclaimed, true);
  } finally {
    if (prev !== undefined) process.env.ZENROWS_API_KEY = prev;
    cleanup();
  }
});

test("throws AUTH_MISSING when auto_signup disabled and no key", async () => {
  const { root, cleanup } = tempRoot();
  const prev = process.env.ZENROWS_API_KEY; delete process.env.ZENROWS_API_KEY;
  try {
    createWorkspace(root);
    await assert.rejects(
      () => ensureApiKey({ ...defaultPolicy(), auto_signup: false }, { projectRoot: root, signupImpl: fakeSignup }),
      (e: unknown) => e instanceof ToolkitError && e.code === "AUTH_MISSING",
    );
  } finally {
    if (prev !== undefined) process.env.ZENROWS_API_KEY = prev;
    cleanup();
  }
});
