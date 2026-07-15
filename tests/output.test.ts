import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOut } from "../src/cli/output.ts";
import { ToolkitError } from "../src/core/errors.ts";

test("writeOut writes to a file path", () => {
  const dir = mkdtempSync(join(tmpdir(), "zr-out-"));
  const file = join(dir, "results.jsonl");
  writeOut(file, "line\n");
  assert.equal(readFileSync(file, "utf8"), "line\n");
});

test("writeOut rejects a directory path with an actionable INVALID_USAGE", () => {
  const dir = mkdtempSync(join(tmpdir(), "zr-out-"));
  assert.throws(
    () => writeOut(dir, "x"),
    (e: unknown) =>
      e instanceof ToolkitError && e.code === "INVALID_USAGE" && /is a directory/.test(e.message),
  );
});

test("writeOut rejects a missing parent directory with an actionable INVALID_USAGE", () => {
  const dir = mkdtempSync(join(tmpdir(), "zr-out-"));
  assert.throws(
    () => writeOut(join(dir, "nope", "results.jsonl"), "x"),
    (e: unknown) =>
      e instanceof ToolkitError && e.code === "INVALID_USAGE" && /parent directory does not exist/.test(e.message),
  );
});
