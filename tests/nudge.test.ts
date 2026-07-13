import { test } from "node:test";
import assert from "node:assert/strict";
import { tempRoot } from "./helpers.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { readAccount, writeAccount } from "../src/core/agent-account.ts";
import { defaultConfig } from "../src/core/config.ts";
import { nudgeMessage, maybeNudgeClaim } from "../src/core/nudge.ts";
import type { AgentAccount } from "../src/types/index.ts";

const CLAIM_URL = "https://x/claim/tok";

function acct(over: Partial<AgentAccount> = {}): AgentAccount {
  return {
    accountId: "u1",
    unclaimed: true,
    claimUrl: CLAIM_URL,
    createdAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

test("nudgeMessage: unclaimed + high usage → message with claim URL", () => {
  const msg = nudgeMessage(acct(), 85, new Date("2026-07-11T00:00:00Z"));
  assert.ok(msg && msg.includes(CLAIM_URL));
  assert.ok(msg.includes("85%"));
});

test("nudgeMessage: unclaimed + low usage → null", () => {
  assert.equal(nudgeMessage(acct(), 10, new Date("2026-07-11T00:00:00Z")), null);
});

test("nudgeMessage: claimed account never nudges", () => {
  assert.equal(nudgeMessage(acct({ unclaimed: false }), 99, new Date("2026-07-11T00:00:00Z")), null);
});

test("nudgeMessage: unclaimed + trial within 1 day + low usage → message", () => {
  const now = new Date("2026-07-11T00:00:00Z");
  const msg = nudgeMessage(acct({ trialEndsAt: "2026-07-12T00:00:00Z" }), 10, now);
  assert.ok(msg && msg.includes(CLAIM_URL));
  assert.ok(msg.includes("2026-07-12T00:00:00Z"));
});

test("maybeNudgeClaim: records lastUsageCheckAt after a usage fetch", async () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    saveApiKey("zr-key", root);
    writeAccount(acct(), root);
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ usage_percent: 90 }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const now = new Date("2026-07-11T12:00:00Z");
    await maybeNudgeClaim(defaultConfig(), { projectRoot: root, fetchImpl: fakeFetch, now });
    assert.equal(readAccount(root)?.lastUsageCheckAt, now.toISOString());
  } finally {
    cleanup();
  }
});

test("maybeNudgeClaim: claimed account never calls fetch", async () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    saveApiKey("zr-key", root);
    writeAccount(acct({ unclaimed: false }), root);
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await maybeNudgeClaim(defaultConfig(), { projectRoot: root, fetchImpl: fakeFetch });
    assert.equal(called, false);
  } finally {
    cleanup();
  }
});

test("maybeNudgeClaim: throttle skips fetch when checked recently", async () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    saveApiKey("zr-key", root);
    const now = new Date("2026-07-11T12:00:00Z");
    writeAccount(acct({ lastUsageCheckAt: now.toISOString() }), root);
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    await maybeNudgeClaim(defaultConfig(), { projectRoot: root, fetchImpl: fakeFetch, now });
    assert.equal(called, false);
  } finally {
    cleanup();
  }
});
