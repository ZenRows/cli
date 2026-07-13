import { test } from "node:test";
import assert from "node:assert/strict";
import { tempRoot } from "./helpers.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { writeAccount } from "../src/core/agent-account.ts";
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
