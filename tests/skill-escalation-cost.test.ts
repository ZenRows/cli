import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pkgPath } from "../src/core/paths.ts";

/**
 * Skills are prose we ship into other people's agents, so the usual tests say
 * nothing about them. This one encodes a single lesson from a real regression:
 * a skill offered `--js-render --premium-proxy` as an ordinary example, and the
 * agent then recommended that pair for routine work. It is 25 credits per
 * request against 1, and `mode=auto` reaches the same place only when the
 * target needs it.
 *
 * The rule is narrow on purpose. It fires on a runnable example that turns both
 * on with no price attached. A synopsis listing optional flags in brackets is
 * documentation, not a recommendation, and prose about escalating after a
 * failure is the behaviour we want.
 */
const SKILLS_DIR = pkgPath("skills");
const skillFiles = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => ({ name: e.name, path: join(SKILLS_DIR, e.name, "SKILL.md") }));

/** A runnable example, as opposed to a synopsis with `[--optional]` flags. */
function isRunnableExample(line: string): boolean {
  return /\bzenrows\s/.test(line) && !/\[--/.test(line);
}

function enablesBothEscalations(line: string): boolean {
  return /--js-render\b/.test(line) && /--premium-proxy\b/.test(line);
}

function statesCost(line: string): boolean {
  return /\bcredits?\b|\bcosts?\b|\b25\b/i.test(line);
}

test("a runnable example that enables both escalations states its cost", () => {
  const offenders: string[] = [];
  for (const s of skillFiles) {
    readFileSync(s.path, "utf8").split("\n").forEach((line, i) => {
      if (isRunnableExample(line) && enablesBothEscalations(line) && !statesCost(line)) {
        offenders.push(`${s.name}/SKILL.md:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `--js-render with --premium-proxy is 25 credits per request. An example that turns both on must say so on the same line, or use mode=auto instead:\n${offenders.join("\n")}`,
  );
});

test("skills that show an escalation also point at auto mode somewhere", () => {
  for (const s of skillFiles) {
    const text = readFileSync(s.path, "utf8");
    if (!/--js-render|--premium-proxy/.test(text)) continue;
    assert.match(
      text,
      /mode=auto|auto mode|Adaptive Stealth/i,
      `${s.name}/SKILL.md shows an escalation flag but never mentions auto mode`,
    );
  }
});
