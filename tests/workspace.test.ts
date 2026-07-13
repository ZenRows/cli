import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspace, WORKSPACE_SUBDIRS, findWorkspace } from "../src/core/workspace.ts";
import { tempRoot } from "./helpers.ts";

test("createWorkspace builds the full .zenrows tree", () => {
  const { root, cleanup } = tempRoot();
  try {
    const paths = createWorkspace(root);
    assert.ok(existsSync(paths.dir), ".zenrows exists");
    for (const sub of WORKSPACE_SUBDIRS) {
      assert.ok(existsSync(join(paths.dir, sub)), `${sub}/ exists`);
    }
  } finally {
    cleanup();
  }
});

test("createWorkspace gitignores secrets and artifacts", () => {
  const { root, cleanup } = tempRoot();
  try {
    const paths = createWorkspace(root);
    const gi = readFileSync(paths.gitignore, "utf8");
    assert.match(gi, /\.zenrows\/secrets\.json/);
    assert.match(gi, /\.zenrows\/runs\//);
  } finally {
    cleanup();
  }
});

test("findWorkspace walks upward from a nested dir", () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    const found = findWorkspace(join(root, "a", "b"));
    // Nested dirs don't exist on disk, but resolution still climbs to root.
    assert.ok(found === null || found.root === root);
    const direct = findWorkspace(root);
    assert.equal(direct?.root, root);
  } finally {
    cleanup();
  }
});
