import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installAgentSkills, CLIENT_SKILL_DIRS } from "../src/installers/agent-skills.ts";
import { tempRoot } from "./helpers.ts";

const CLAUDE_DIR = CLIENT_SKILL_DIRS["claude-code"] as string;

test("project scope installs where the agent reads, not only in .zenrows", () => {
  const { root, cleanup } = tempRoot();
  try {
    const done = installAgentSkills(["claude-code"], { scope: "project", root });
    assert.ok(done.some((t) => t.client === "claude-code"), "claude-code targeted");
    assert.ok(done.some((t) => t.client === "generic"), "vendor-neutral path always written");
    assert.ok(existsSync(join(root, CLAUDE_DIR, "zenrows", "SKILL.md")));
  } finally {
    cleanup();
  }
});

test("global is the default scope and resolves under the home directory", () => {
  const done = installAgentSkills(["claude-code"], { dryRun: true });
  for (const t of done) assert.ok(t.dir.startsWith(homedir()), `${t.dir} is under home`);
});

test("a rerun replaces our skills and leaves other skills alone", () => {
  const { root, cleanup } = tempRoot();
  try {
    const dir = join(root, CLAUDE_DIR);
    mkdirSync(join(dir, "someone-elses"), { recursive: true });
    writeFileSync(join(dir, "someone-elses", "SKILL.md"), "keep me");

    installAgentSkills(["claude-code"], { scope: "project", root });
    writeFileSync(join(dir, "zenrows", "SKILL.md"), "stale");
    installAgentSkills(["claude-code"], { scope: "project", root });

    assert.equal(readFileSync(join(dir, "someone-elses", "SKILL.md"), "utf8"), "keep me");
    assert.notEqual(readFileSync(join(dir, "zenrows", "SKILL.md"), "utf8"), "stale");
  } finally {
    cleanup();
  }
});

test("dryRun reports the targets without writing", () => {
  const { root, cleanup } = tempRoot();
  try {
    const done = installAgentSkills(["claude-code"], { scope: "project", root, dryRun: true });
    assert.ok(done.length > 0);
    assert.ok(!existsSync(join(root, CLAUDE_DIR)));
  } finally {
    cleanup();
  }
});

test("an unknown client is skipped, not written to a guessed path", () => {
  const { root, cleanup } = tempRoot();
  try {
    const done = installAgentSkills(["not-a-real-agent"], { scope: "project", root });
    assert.deepEqual(done.map((t) => t.client), ["generic"]);
  } finally {
    cleanup();
  }
});
