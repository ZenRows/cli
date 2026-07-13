import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("SKILL documents auto-signup and claim", () => {
  const skill = readFileSync("skills/zenrows/SKILL.md", "utf8");
  assert.match(skill, /auto[- ]?signup|automatically create/i);
  assert.match(skill, /claim/i);
  assert.match(skill, /--no-signup/);
});
