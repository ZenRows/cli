import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_HOME_ENV, defaultConfig, getOrCreateTelemetryId, saveConfig } from "../src/core/config.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { tempRoot } from "./helpers.ts";

function withConfigHome(fn: (home: string) => void): void {
  const previous = process.env[CONFIG_HOME_ENV];
  const home = mkdtempSync(join(tmpdir(), "zr-home-"));
  process.env[CONFIG_HOME_ENV] = home;
  try {
    fn(home);
  } finally {
    if (previous === undefined) delete process.env[CONFIG_HOME_ENV];
    else process.env[CONFIG_HOME_ENV] = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("two workspaces on the same machine send the same agent id", () => {
  withConfigHome((home) => {
    const a = tempRoot();
    const b = tempRoot();
    try {
      createWorkspace(a.root);
      createWorkspace(b.root);
      const first = getOrCreateTelemetryId(a.root);
      const second = getOrCreateTelemetryId(b.root);
      assert.match(first, /^[0-9a-f-]{36}$/);
      assert.equal(second, first);
      assert.equal(readFileSync(join(home, "telemetry-id"), "utf8").trim(), first);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

test("an id already stored in a workspace is adopted as the machine id", () => {
  withConfigHome(() => {
    const legacy = tempRoot();
    const fresh = tempRoot();
    try {
      createWorkspace(legacy.root);
      createWorkspace(fresh.root);
      saveConfig({ ...defaultConfig(), telemetryId: "legacy-workspace-id" }, legacy.root);
      assert.equal(getOrCreateTelemetryId(legacy.root), "legacy-workspace-id");
      assert.equal(getOrCreateTelemetryId(fresh.root), "legacy-workspace-id");
    } finally {
      legacy.cleanup();
      fresh.cleanup();
    }
  });
});

test("falls back to the workspace when the machine directory is not writable", () => {
  withConfigHome((home) => {
    // A file where the directory should be makes mkdir/write fail on every platform.
    const blocked = join(home, "blocked");
    writeFileSync(blocked, "");
    process.env[CONFIG_HOME_ENV] = join(blocked, "zenrows");
    const ws = tempRoot();
    try {
      createWorkspace(ws.root);
      const id = getOrCreateTelemetryId(ws.root);
      assert.equal(getOrCreateTelemetryId(ws.root), id);
    } finally {
      ws.cleanup();
    }
  });
});
