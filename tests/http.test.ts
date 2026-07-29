import { test } from "node:test";
import assert from "node:assert/strict";
import { scrape } from "../src/core/http.ts";
import { CLI_VERSION } from "../src/core/config.ts";

// The exact shape Zenrows returns when an account is out of credits / over its
// usage limit: HTTP 402 with a non-empty JSON error envelope.
const AUTH004 = JSON.stringify({
  code: "AUTH004",
  detail:
    "This account has reached its usage limit. Purchase a new subscription to continue using the service.",
  instance: "/v1",
  status: 402,
  title: "Usage exceeded (AUTH004)",
  type: "https://docs.zenrows.com/api-error-codes#AUTH004",
});

function withFetch(res: () => Response, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => res()) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

// A binary response body: the PNG magic signature starts with 0x89 (>0x7F).
// Reading it as UTF-8 text mangles every high byte into U+FFFD (ef bf bd),
// which is exactly the screenshot/PDF corruption we are guarding against.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef]);

test("scrape preserves raw bytes for a screenshot (no UTF-8 corruption)", async () => {
  await withFetch(
    () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
    async () => {
      const r = await scrape("https://api.zenrows.com/v1/", "k", {
        url: "https://x",
        screenshot: true,
      });
      assert.equal(r.isBinary, true);
      assert.ok(Buffer.isBuffer(r.raw), "raw should be a Buffer");
      assert.deepEqual([...r.raw], [...PNG_BYTES], "raw bytes must survive byte-for-byte");
      assert.equal(r.raw[0], 0x89, "PNG signature byte must not be mangled");
    },
  );
});

test("scrape preserves raw bytes for a PDF response_type", async () => {
  const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0xff, 0xfe]);
  await withFetch(
    () => new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } }),
    async () => {
      const r = await scrape("https://api.zenrows.com/v1/", "k", {
        url: "https://x",
        response_type: "pdf",
      });
      assert.equal(r.isBinary, true);
      assert.deepEqual([...r.raw], [...PDF_BYTES]);
    },
  );
});

test("scrape marks ordinary text responses as non-binary", async () => {
  await withFetch(
    () => new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } }),
    async () => {
      const r = await scrape("https://api.zenrows.com/v1/", "k", { url: "https://x" });
      assert.equal(r.isBinary, false);
      assert.equal(r.body, "<html>hi</html>");
    },
  );
});

test("scrape sends a User-Agent carrying the current CLI version", async () => {
  let seenUA: string | undefined;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seenUA = new Headers(init.headers).get("user-agent") ?? undefined;
    return new Response("ok", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    await scrape("https://api.zenrows.com/v1/", "k", { url: "https://x" });
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(seenUA, `zenrows-cli/${CLI_VERSION}`);
});

test("scrape treats a 402 credit/quota response as an error, not success", async () => {
  await withFetch(
    () => new Response(AUTH004, { status: 402, headers: { "content-type": "application/json" } }),
    async () => {
      await assert.rejects(
        () => scrape("https://api.zenrows.com/v1/", "test-key", { url: "https://example.net" }),
        (err: unknown) => {
          assert.ok(err && typeof err === "object" && "code" in err);
          assert.equal((err as { code: string }).code, "POLICY_MAX_CREDITS_EXCEEDED");
          return true;
        },
      );
    },
  );
});

test("scrape maps REQS001 (forbidden domain) to a non-retryable DOMAIN_FORBIDDEN error", async () => {
  const REQS001 = JSON.stringify({
    code: "REQS001",
    detail: "Requests to this domain are forbidden.",
    status: 400,
    title: "Requests to this domain are forbidden (REQS001)",
    type: "https://docs.zenrows.com/api-error-codes#REQS001",
  });
  await withFetch(
    () => new Response(REQS001, { status: 400, headers: { "content-type": "application/json" } }),
    async () => {
      await assert.rejects(
        () => scrape("https://api.zenrows.com/v1/", "k", { url: "https://books.toscrape.com/" }),
        (err: unknown) => {
          const e = err as { code?: string; next_action?: string };
          assert.equal(e.code, "DOMAIN_FORBIDDEN");
          // Must NOT advise a retry — the block is permanent.
          assert.doesNotMatch(e.next_action ?? "", /retry/i);
          return true;
        },
      );
    },
  );
});

test("scrape still returns non-Zenrows 4xx bodies (allowed_status_codes / original_status)", async () => {
  // A target site's own 404 (real page content) must NOT be swallowed as an
  // error — original_status / allowed_status_codes legitimately return it.
  await withFetch(
    () => new Response("<html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } }),
    async () => {
      const r = await scrape("https://api.zenrows.com/v1/", "k", {
        url: "https://x",
        original_status: true,
      });
      assert.equal(r.status, 404);
      assert.match(r.body, /Not Found/);
    },
  );
});
