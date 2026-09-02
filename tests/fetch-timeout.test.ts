/**
 * The client timeout must not masquerade as backend unreachability (ACT-1605).
 *
 * The CLI used to abort at 90s — exactly the gateway's own request budget — and
 * report every abort as BACKEND_UNAVAILABLE ("Could not reach the Zenrows
 * API"). Both halves were wrong: the API had been reached, and it was about to
 * return a specific error. These tests pin the two halves of the fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scrape,
  DEFAULT_TIMEOUT_MS,
  SERVER_BUDGET_MS,
} from "../src/core/http.ts";
import { buildParams, runFetch, type FetchOptions } from "../src/adapters/protected-fetch.ts";
import { normalizeTimeout } from "../src/cli/commands/fetch.ts";
import { defaultConfig } from "../src/core/config.ts";
import { defaultPolicy } from "../src/core/policy.ts";
import { ToolkitError } from "../src/core/errors.ts";

/**
 * A fetch that never answers and rejects only when the caller's own timer
 * aborts it — exactly what undici does when an AbortController fires
 * mid-request. This is the real failure the ticket reproduced, simulated.
 */
function hangingFetch(): typeof fetch {
  return ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("This operation was aborted", "AbortError"));
      });
    })) as unknown as typeof fetch;
}

function withFetchImpl(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

// Encodes: "Client timeout raised above the server budget."
test("the default client timeout is above the API's own request budget", () => {
  assert.ok(
    DEFAULT_TIMEOUT_MS > SERVER_BUDGET_MS,
    `client default (${DEFAULT_TIMEOUT_MS}ms) must outlive the server budget (${SERVER_BUDGET_MS}ms), ` +
      "otherwise the abort races the API's own error envelope",
  );
});

// Encodes: "Test covering a simulated abort asserting it is not BACKEND_UNAVAILABLE."
test("a client-side timeout is REQUEST_TIMEOUT, never BACKEND_UNAVAILABLE", async () => {
  await withFetchImpl(hangingFetch(), async () => {
    await assert.rejects(
      () => scrape("https://api.zenrows.com/v1/", "k", { url: "https://x" }, { timeoutMs: 20 }),
      (err: unknown) => {
        assert.ok(err instanceof ToolkitError);
        assert.notEqual(err.code, "BACKEND_UNAVAILABLE", "our own abort is not unreachability");
        assert.equal(err.code, "REQUEST_TIMEOUT");
        // The old message claimed the API was never reached. It was.
        assert.doesNotMatch(err.message, /could not reach/i);
        assert.doesNotMatch(err.next_action, /check connectivity/i);
        return true;
      },
    );
  });
});

// Encodes: "Include the elapsed time in the error so the 90s boundary is visible."
test("REQUEST_TIMEOUT names the elapsed time and how to raise the timeout", async () => {
  await withFetchImpl(hangingFetch(), async () => {
    await assert.rejects(
      () => scrape("https://api.zenrows.com/v1/", "k", { url: "https://x" }, { timeoutMs: 20 }),
      (err: unknown) => {
        const e = err as ToolkitError;
        assert.match(e.message, /stopped waiting after [\d.]+s/i);
        assert.match(e.likely_cause, /aborted client-side after [\d.]+s/i);
        assert.match(e.next_action, /--timeout \d+/);
        assert.ok(
          e.suggested_commands.some((c) => /--timeout \d+/.test(c)),
          "must hand the operator a runnable retry with a higher timeout",
        );
        return true;
      },
    );
  });
});

test("a genuine transport failure is still BACKEND_UNAVAILABLE, with the elapsed time", async () => {
  const failing = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
  await withFetchImpl(failing, async () => {
    await assert.rejects(
      () => scrape("https://api.zenrows.com/v1/", "k", { url: "https://x" }),
      (err: unknown) => {
        const e = err as ToolkitError;
        assert.equal(e.code, "BACKEND_UNAVAILABLE");
        assert.match(e.likely_cause, /fetch failed/);
        assert.match(e.likely_cause, /after [\d.]+s/);
        return true;
      },
    );
  });
});

test("runFetch threads --timeout through to the HTTP client", async () => {
  await withFetchImpl(hangingFetch(), async () => {
    await assert.rejects(
      () =>
        runFetch(
          { url: "https://x.com", timeoutMs: 20 },
          defaultConfig(),
          defaultPolicy(),
          "k",
        ),
      (err: unknown) => (err as ToolkitError).code === "REQUEST_TIMEOUT",
    );
  });
});

test("timeoutMs is a client concern and never leaks into the API query string", () => {
  const opts: FetchOptions = { url: "https://x.com", timeoutMs: 150_000 };
  const params = buildParams(opts, defaultConfig());
  assert.equal(params.timeout, undefined);
  assert.equal(params.timeoutMs, undefined);
});

test("--timeout accepts milliseconds and defaults when absent", () => {
  assert.equal(normalizeTimeout("180000"), 180_000);
  assert.equal(normalizeTimeout(undefined), undefined);
});

test("--timeout rejects a non-numeric or non-positive value instead of silently ignoring it", () => {
  for (const bad of ["fast", "0", "-1", ""]) {
    assert.throws(
      () => normalizeTimeout(bad),
      (e: unknown) => e instanceof ToolkitError && e.code === "INVALID_USAGE",
      `--timeout ${JSON.stringify(bad)} must fail loudly`,
    );
  }
});
