import { test } from "node:test";
import assert from "node:assert/strict";
import { tempRoot } from "./helpers.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { readAccount, writeAccount } from "../src/core/agent-account.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { account } from "../src/cli/commands/account.ts";

test("account status returns 0 with an existing account", async () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    writeAccount({ accountId: "u1", unclaimed: true, claimUrl: "https://x/claim/t", createdAt: "2026-07-10T00:00:00Z" }, root);
    const prev = process.cwd(); process.chdir(root);
    try {
      assert.equal(await account.run(["status"], { json: true, yes: true }), 0);
    } finally { process.chdir(prev); }
  } finally { cleanup(); }
});

test("account claim: an expired stored link is replaced by a fresh one; a claimed account says so", async () => {
  const { root, cleanup } = tempRoot();
  const prevFetch = globalThis.fetch;
  const prevEnv = process.env.ZENROWS_AGENT_SIGNUP_URL;
  const prevCwd = process.cwd();
  const out: string[] = [];
  const prevWrite = process.stdout.write.bind(process.stdout);
  try {
    createWorkspace(root);
    saveApiKey("zr-key", root);
    writeAccount({ accountId: "u1", unclaimed: true, claimUrl: "https://app.zenrows.com/claim/old", createdAt: "2020-01-01T00:00:00Z" }, root);
    process.env.ZENROWS_AGENT_SIGNUP_URL = "https://stub.test/api/agent/signup";
    let claimed = false;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/account")) return new Response(JSON.stringify({ accountId: "u1", claimed, isAgent: true }), { status: 200 });
      if (url.endsWith("/claim")) return new Response(JSON.stringify({ status: "unclaimed", claimUrl: "https://app.zenrows.com/claim/fresh" }), { status: 200 });
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch;
    process.chdir(root);
    process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
    assert.equal(await account.run(["claim", "--no-open"], { json: true, yes: true }), 0);
    assert.equal(readAccount(root)?.claimUrl, "https://app.zenrows.com/claim/fresh");
    assert.match(out.join(""), /"claimUrl": "https:\/\/app\.zenrows\.com\/claim\/fresh"/);
    claimed = true;
    out.length = 0;
    assert.equal(await account.run(["claim", "--no-open"], { json: true, yes: true }), 0);
    assert.match(out.join(""), /"claimed": true/);
    assert.equal(readAccount(root)?.unclaimed, false);
  } finally {
    process.stdout.write = prevWrite;
    process.chdir(prevCwd);
    globalThis.fetch = prevFetch;
    if (prevEnv === undefined) delete process.env.ZENROWS_AGENT_SIGNUP_URL; else process.env.ZENROWS_AGENT_SIGNUP_URL = prevEnv;
    cleanup();
  }
});
