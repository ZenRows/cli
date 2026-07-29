import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { authState, clearApiKey, requireApiKey, resolveApiKey, saveApiKey } from "../src/core/auth.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { ToolkitError } from "../src/core/errors.ts";
import { mask } from "../src/core/redact.ts";
import { tempRoot } from "./helpers.ts";

const FAKE = "zr_test_key_ABCDEFGHIJKLMNOP";

test("saveApiKey persists, resolves, and masks without leaking the key", () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    saveApiKey(FAKE, root);
    const { key, source } = resolveApiKey(root);
    assert.equal(key, FAKE);
    assert.equal(source, "secrets-file");

    const st = authState(root);
    assert.equal(st.hasKey, true);
    assert.equal(st.masked, mask(FAKE));
    assert.notEqual(st.masked, FAKE); // never the full key
    assert.match(st.masked!, /…/);
  } finally {
    cleanup();
  }
});

test("requireApiKey throws AUTH_MISSING when absent", () => {
  const { root, cleanup } = tempRoot();
  const prevEnv = process.env.ZENROWS_API_KEY;
  delete process.env.ZENROWS_API_KEY;
  try {
    createWorkspace(root);
    assert.throws(() => requireApiKey(root), (e: unknown) => e instanceof ToolkitError && e.code === "AUTH_MISSING");
  } finally {
    if (prevEnv !== undefined) process.env.ZENROWS_API_KEY = prevEnv;
    cleanup();
  }
});

test("clearApiKey removes the stored key and it is not present in the file", () => {
  const { root, cleanup } = tempRoot();
  try {
    const paths = createWorkspace(root);
    saveApiKey(FAKE, root);
    assert.equal(clearApiKey(root), true);
    const contents = readFileSync(paths.secrets, "utf8");
    assert.ok(!contents.includes(FAKE), "secrets file no longer contains the key");
  } finally {
    cleanup();
  }
});

test("resolveApiKey prefers secrets file over ZENROWS_API_KEY env", () => {
  const { root, cleanup } = tempRoot();
  const prev = process.env.ZENROWS_API_KEY;
  process.env.ZENROWS_API_KEY = "zr_env_key";
  try {
    createWorkspace(root);
    saveApiKey(FAKE, root);
    assert.equal(resolveApiKey(root).source, "secrets-file");
    clearApiKey(root);
    assert.equal(resolveApiKey(root).source, "env");
    assert.equal(resolveApiKey(root).key, "zr_env_key");
  } finally {
    if (prev !== undefined) process.env.ZENROWS_API_KEY = prev;
    else delete process.env.ZENROWS_API_KEY;
    cleanup();
  }
});
