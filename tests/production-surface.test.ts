import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli/index.ts";

test("removed non-GA commands are not registered", async () => {
  for (const cmd of ["crawl", "discover", "monitor"]) {
    const code = await main([cmd]);
    assert.equal(code, 1, `${cmd} should be unknown (exit 1)`);
  }
});

test("GA commands remain registered", async () => {
  // --help path returns 0 for a known command without side effects
  assert.equal(await main(["fetch", "--help"]), 0);
  assert.equal(await main(["account", "--help"]), 0);
  // batch is registered again (beta) — --help exits 0
  assert.equal(await main(["batch", "--help"]), 0);
});
