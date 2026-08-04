import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/cli/command.ts";
import { ToolkitError } from "../src/core/errors.ts";

const OPTS = {
  output: { type: "boolean" },
  "js-render": { type: "boolean" },
  session: { type: "string" },
} as const;

test("parse accepts declared flags + positionals", () => {
  const { values, positionals } = parse(["https://x.com", "--output", "--session", "s1"], OPTS);
  assert.equal(values.output, true);
  assert.equal(values.session, "s1");
  assert.deepEqual(positionals, ["https://x.com"]);
});

test("parse rejects an unknown flag with UNKNOWN_FLAG (no silent swallow)", () => {
  assert.throws(
    () => parse(["--bogus-flag"], OPTS),
    (e: unknown) => e instanceof ToolkitError && e.code === "UNKNOWN_FLAG",
  );
});

test("parse names the offending flag and suggests the closest match", () => {
  try {
    parse(["--outputt"], OPTS); // one char off from --output
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof ToolkitError);
    assert.match(e.message, /--outputt/);
    assert.match(e.next_action, /Did you mean --output\?/);
  }
});

test("parse rejects the homepage's --format (the silent-HTML bug), no charge path reached", () => {
  assert.throws(
    () => parse(["https://x.com", "--format", "markdown"], OPTS),
    (e: unknown) => e instanceof ToolkitError && e.code === "UNKNOWN_FLAG",
  );
});

test("parse still tolerates the global flags stripped by the router", () => {
  // --json/--yes/--help/--version are consumed by the top-level router; if they
  // reach a command's parse (e.g. in tests) they must not read as unknown.
  assert.doesNotThrow(() => parse(["--json", "--yes", "https://x.com"], OPTS));
});
