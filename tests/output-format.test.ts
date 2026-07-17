import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOutput } from "../src/cli/commands/fetch.ts";
import { ToolkitError } from "../src/core/errors.ts";

test("normalizeOutput maps known --output values", () => {
  assert.equal(normalizeOutput("html"), "html");
  assert.equal(normalizeOutput("md"), "markdown");
  assert.equal(normalizeOutput("markdown"), "markdown");
  assert.equal(normalizeOutput("text"), "plaintext");
  assert.equal(normalizeOutput("txt"), "plaintext");
  assert.equal(normalizeOutput("pdf"), "pdf");
});

test("normalizeOutput returns undefined when no --output is given", () => {
  assert.equal(normalizeOutput(undefined), undefined);
});

test("normalizeOutput rejects an unknown --output value instead of silently defaulting to HTML", () => {
  assert.throws(
    () => normalizeOutput("pfd"),
    (e: unknown) => e instanceof ToolkitError && e.code === "INVALID_USAGE",
  );
});
