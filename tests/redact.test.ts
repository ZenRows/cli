import { test } from "node:test";
import assert from "node:assert/strict";
import { mask, redact, redactObject } from "../src/core/redact.ts";

test("mask keeps only the head and tail", () => {
  assert.equal(mask("abcd1234wxyz"), "abcd…wxyz");
  assert.equal(mask("short"), "****");
});

test("redact scrubs apikey query params and known secrets", () => {
  const s = "GET https://api.zenrows.com/v1/?apikey=SECRET123&url=https://x.com";
  const out = redact(s, ["SECRET123"]);
  assert.ok(!out.includes("SECRET123"));
  assert.match(out, /REDACTED/);
});

test("redactObject strips secret-named keys", () => {
  const obj = { apiKey: "SECRET", nested: { token: "T", ok: 1 } };
  const out = redactObject(obj);
  assert.equal(out.apiKey, "***REDACTED***");
  assert.equal(out.nested.token, "***REDACTED***");
  assert.equal(out.nested.ok, 1);
});
