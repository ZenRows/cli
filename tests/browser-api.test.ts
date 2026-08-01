import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserBase,
  browserRequest,
  createSession,
  closeSession,
  decodeBinary,
  connectUrl,
  normalizeSelectValue,
  DEFAULT_BROWSER_BASE,
  BROWSER_BASE_ENV,
} from "../src/core/browser-api.ts";
import { ToolkitError } from "../src/core/errors.ts";

/** fetch stub returning a JSON (or text) body, recording calls. */
function stub(status: number, payload: unknown, contentType = "application/json") {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(payload === undefined ? null : typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "content-type": contentType },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("browserBase defaults to mcp.zenrows.com and honors the env override", () => {
  const prev = process.env[BROWSER_BASE_ENV];
  delete process.env[BROWSER_BASE_ENV];
  try {
    assert.equal(browserBase(), DEFAULT_BROWSER_BASE);
    assert.equal(DEFAULT_BROWSER_BASE, "https://mcp.zenrows.com");
    process.env[BROWSER_BASE_ENV] = "https://staging.example.com/";
    assert.equal(browserBase(), "https://staging.example.com"); // trailing slash trimmed
  } finally {
    if (prev === undefined) delete process.env[BROWSER_BASE_ENV];
    else process.env[BROWSER_BASE_ENV] = prev;
  }
});

test("browserRequest sends Bearer auth + JSON body and parses the JSON response", async () => {
  const { impl, calls } = stub(200, { ok: true });
  const out = await browserRequest<{ ok: boolean }>("POST", "/browser/sessions/x/click", {
    apiKey: "zr-key",
    body: { selector: "#go" },
    fetchImpl: impl,
  });
  assert.deepEqual(out, { ok: true });
  const call = calls[0]!;
  assert.match(call.url, /\/browser\/sessions\/x\/click$/);
  assert.equal(call.init?.method, "POST");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer zr-key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(call.init?.body)), { selector: "#go" });
});

test("browserRequest returns null on an empty (204) body", async () => {
  const { impl } = stub(204, undefined);
  const out = await browserRequest("DELETE", "/browser/sessions/x", { apiKey: "k", fetchImpl: impl });
  assert.equal(out, null);
});

test("browserRequest maps 401 → AUTH_INVALID", async () => {
  const { impl } = stub(401, { error: "invalid key" });
  await assert.rejects(
    () => browserRequest("POST", "/browser/sessions", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "AUTH_INVALID",
  );
});

test("browserRequest maps 404 → BROWSER_UNAVAILABLE (session expired/not found)", async () => {
  const { impl } = stub(404, { error: "session not found" });
  await assert.rejects(
    () => browserRequest("POST", "/browser/sessions/gone/click", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BROWSER_UNAVAILABLE",
  );
});

test("browserRequest maps 402 → POLICY_MAX_CREDITS_EXCEEDED", async () => {
  const { impl } = stub(402, { error: "no credit" });
  await assert.rejects(
    () => browserRequest("POST", "/browser/sessions", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_MAX_CREDITS_EXCEEDED",
  );
});

test("browserRequest maps 5xx → BROWSER_UNAVAILABLE", async () => {
  const { impl } = stub(503, "upstream down", "text/plain");
  await assert.rejects(
    () => browserRequest("POST", "/browser/sessions", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BROWSER_UNAVAILABLE",
  );
});

test("createSession posts /browser/sessions and returns session_id + expires_at", async () => {
  const { impl, calls } = stub(200, { session_id: "sess-1", expires_at: "2026-07-31T15:00:00Z" });
  const s = await createSession("k", { proxy_country: "us" }, impl);
  assert.equal(s.session_id, "sess-1");
  assert.equal(s.expires_at, "2026-07-31T15:00:00Z");
  assert.match(calls[0]!.url, /\/browser\/sessions$/);
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { proxy_country: "us" });
});

test("closeSession DELETEs the session", async () => {
  const { impl, calls } = stub(204, undefined);
  await closeSession("k", "sess-1", impl);
  assert.equal(calls[0]!.init?.method, "DELETE");
  assert.match(calls[0]!.url, /\/browser\/sessions\/sess-1$/);
});

test("decodeBinary turns base64 into bytes with the right extension", () => {
  const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const png = decodeBinary({ data: pngB64, mime_type: "image/png" });
  assert.ok(Buffer.isBuffer(png.buf));
  assert.equal(png.buf[0], 0x89);
  assert.equal(png.ext, "png");
  assert.equal(decodeBinary({ data: "AA==", mime_type: "application/pdf" }).ext, "pdf");
  assert.equal(decodeBinary({ data: "AA==", mime_type: "image/jpeg" }).ext, "jpg");
});

test("connectUrl builds the CDP wss URL with the key and proxy params", () => {
  const url = connectUrl("zr-key", { proxy_country: "de" });
  const u = new URL(url);
  assert.equal(u.protocol, "wss:");
  assert.equal(u.hostname, "browser.zenrows.com");
  assert.equal(u.searchParams.get("apikey"), "zr-key");
  assert.equal(u.searchParams.get("proxy_country"), "de");
});

test("normalizeSelectValue wraps plain option values as option[value=…] selectors", () => {
  assert.equal(normalizeSelectValue("2"), 'option[value="2"]');
  assert.equal(normalizeSelectValue("large"), 'option[value="large"]');
  // Dots / colons / hashes are common in values — must wrap, not passthrough.
  assert.equal(normalizeSelectValue("1.5"), 'option[value="1.5"]');
  assert.equal(normalizeSelectValue("10:30"), 'option[value="10:30"]');
  assert.equal(normalizeSelectValue("en:US"), 'option[value="en:US"]');
  assert.equal(normalizeSelectValue('option[value="2"]'), 'option[value="2"]');
  assert.equal(normalizeSelectValue('[value="2"]'), '[value="2"]');
  assert.equal(normalizeSelectValue("option.foo"), "option.foo");
  assert.equal(normalizeSelectValue('say "hi"'), 'option[value="say \\"hi\\""]');
});
