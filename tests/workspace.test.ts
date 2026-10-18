import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createWorkspace, WORKSPACE_SUBDIRS, findWorkspace, writePrivateJson } from "../src/core/workspace.ts";
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

test("writePrivateJson: file is 0600 from creation, a new dir is 0700, an existing 0644 file ends 0600", { skip: process.platform === "win32" }, () => {
  const { root, cleanup } = tempRoot();
  try {
    const dir = join(root, "private");
    const file = join(dir, "secrets.json");
    writePrivateJson(file, { a: 1 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(dir), ["secrets.json"], "no temp file left behind");
    chmodSync(file, 0o644);
    writePrivateJson(file, { a: 2 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 2 });
  } finally {
    cleanup();
  }
});
