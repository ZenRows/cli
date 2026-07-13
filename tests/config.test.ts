import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, loadConfig, saveConfig, DEFAULT_API_BASE } from "../src/core/config.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { tempRoot } from "./helpers.ts";

test("default config points at the confirmed /v1/ base in auto mode", () => {
  const cfg = defaultConfig();
  assert.equal(cfg.apiBase, DEFAULT_API_BASE);
  assert.equal(cfg.apiBase, "https://api.zenrows.com/v1/");
  assert.equal(cfg.defaultMode, "auto");
});

test("config save/load roundtrip", () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    const cfg = defaultConfig();
    cfg.defaultMode = "manual";
    cfg.telemetry = "off";
    saveConfig(cfg, root);
    const loaded = loadConfig(root);
    assert.equal(loaded.defaultMode, "manual");
    assert.equal(loaded.telemetry, "off");
    assert.equal(loaded.apiBase, DEFAULT_API_BASE);
  } finally {
    cleanup();
  }
});
