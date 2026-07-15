import { test } from "node:test";
import assert from "node:assert/strict";
import { scrape } from "../src/core/http.ts";

// The exact shape ZenRows returns when an account is out of credits / over its
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

test("scrape still returns non-ZenRows 4xx bodies (allowed_status_codes / original_status)", async () => {
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
