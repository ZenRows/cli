import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installProjectSkills, CLIENT_SKILL_DIRS } from "../src/installers/agent-skills.ts";
import { tempRoot } from "./helpers.ts";

const CLAUDE_DIR = CLIENT_SKILL_DIRS["claude-code"] as string;

test("installs skills where the agent reads them, not only in .zenrows", () => {
  const { root, cleanup } = tempRoot();
  try {
    const done = installProjectSkills(root, ["claude-code"]);
    assert.ok(done.some((t) => t.client === "claude-code"), "claude-code targeted");
    assert.ok(done.some((t) => t.client === "generic"), "vendor-neutral path always written");
    assert.ok(existsSync(join(root, CLAUDE_DIR, "zenrows", "SKILL.md")));
  } finally {
    cleanup();
  }
});

test("a rerun replaces our skills and leaves other skills alone", () => {
  const { root, cleanup } = tempRoot();
  try {
    const dir = join(root, CLAUDE_DIR);
    mkdirSync(join(dir, "someone-elses"), { recursive: true });
    writeFileSync(join(dir, "someone-elses", "SKILL.md"), "keep me");

    installProjectSkills(root, ["claude-code"]);
    writeFileSync(join(dir, "zenrows", "SKILL.md"), "stale");
    installProjectSkills(root, ["claude-code"]);

    assert.equal(readFileSync(join(dir, "someone-elses", "SKILL.md"), "utf8"), "keep me");
    assert.notEqual(readFileSync(join(dir, "zenrows", "SKILL.md"), "utf8"), "stale");
  } finally {
    cleanup();
  }
});

test("dryRun reports the targets without writing", () => {
  const { root, cleanup } = tempRoot();
  try {
    const done = installProjectSkills(root, ["claude-code"], { dryRun: true });
    assert.ok(done.length > 0);
    assert.ok(!existsSync(join(root, CLAUDE_DIR)));
  } finally {
    cleanup();
  }
});

test("an unknown client is skipped, not written to a guessed path", () => {
  const { root, cleanup } = tempRoot();
  try {
    const done = installProjectSkills(root, ["not-a-real-agent"]);
    assert.deepEqual(done.map((t) => t.client), ["generic"]);
  } finally {
    cleanup();
  }
});
