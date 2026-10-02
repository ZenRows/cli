import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("SKILL documents auto-signup and claim", () => {
  const skill = readFileSync("skills/zenrows/SKILL.md", "utf8");
  assert.match(skill, /auto[- ]?signup|automatically create/i);
  assert.match(skill, /claim/i);
  assert.match(skill, /--no-signup/);
});

test("trace-debug maps the key-cap and out-of-credits codes to an action", () => {
  const skill = readFileSync("skills/trace-debug/SKILL.md", "utf8");
  assert.match(skill, /KEY_CREDIT_CAP_REACHED/);
  assert.match(skill, /settings\/api-keys/);
  assert.match(skill, /POLICY_MAX_CREDITS_EXCEEDED/);
});
