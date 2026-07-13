import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { assetRunnable, loadRegistry } from "../src/core/registry.ts";
import { pkgPath } from "../src/core/paths.ts";
import type { AssetType } from "../src/types/index.ts";

const TYPES: AssetType[] = ["plugin", "skill", "template", "workflow", "recipe", "eval"];

test("every registry file loads and is non-empty", () => {
  for (const t of TYPES) {
    const assets = loadRegistry(t);
    assert.ok(assets.length > 0, `${t} registry has assets`);
  }
});

test("every declared asset path exists on disk", () => {
  for (const t of TYPES) {
    for (const a of loadRegistry(t)) {
      assert.ok(existsSync(pkgPath(a.path)), `${t} "${a.name}" path exists: ${a.path}`);
    }
  }
});

test("core skills include the GA set and the master decision-tree skill", () => {
  const skills = loadRegistry("skill").map((s) => s.name);
  for (const required of [
    "zenrows",
    "protected-fetch",
    "extract",
    "batch-jobs",
    "interact-browser",
    "cost-control",
    "trace-debug",
    "compliance-policy",
  ]) {
    assert.ok(skills.includes(required), `skill ${required} present`);
  }
  // Non-GA skills were trimmed from the registry.
  for (const removed of ["discover", "crawl", "monitor"]) {
    assert.ok(!skills.includes(removed), `skill ${removed} removed`);
  }
  assert.ok(existsSync(pkgPath("skills/zenrows/SKILL.md")), "master SKILL.md exists");
});

test("assetRunnable reflects backend capability status", () => {
  const fetchRecipe = loadRegistry("recipe").find((r) => r.name === "fetch-protected-page")!;
  assert.equal(assetRunnable(fetchRecipe), true); // needs protected_fetch (available)
  const batchSkill = loadRegistry("skill").find((s) => s.name === "batch-jobs")!;
  assert.equal(assetRunnable(batchSkill), false); // needs batch (beta = not cloud-runnable)
});
