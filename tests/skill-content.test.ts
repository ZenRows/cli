import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

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

// Strict YAML parsers (such as the one behind `npx skills add`) reject an unquoted
// value that contains ": ", and skip the whole skill.
test("every SKILL.md frontmatter value with a colon is quoted", () => {
  for (const dir of ["skills", "agent-plugin/skills"]) {
    for (const name of readdirSync(dir)) {
      const frontmatter = readFileSync(`${dir}/${name}/SKILL.md`, "utf8").split("---")[1] ?? "";
      for (const line of frontmatter.split("\n")) {
        const value = line.match(/^[\w-]+: (.*)$/)?.[1];
        if (value && !/^["'[{|>]/.test(value)) {
          assert.doesNotMatch(value, /: /, `${dir}/${name}/SKILL.md: quote "${line}"`);
        }
      }
    }
  }
});
