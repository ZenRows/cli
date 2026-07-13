import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPolicy } from "../src/core/policy.ts";
import { workspacePaths } from "../src/core/workspace.ts";

test("auto_signup defaults to true", () => {
  assert.equal(defaultPolicy().auto_signup, true);
});

test("workspace exposes account.json path", () => {
  const p = workspacePaths("/tmp/example");
  assert.ok(p.account.endsWith("/.zenrows/account.json"));
});
