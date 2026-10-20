import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tempRoot } from "./helpers.ts";
import { createWorkspace, workspacePaths } from "../src/core/workspace.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { readAccount, writeAccount, requestClaimLink } from "../src/core/agent-account.ts";
import {
  _claimLockPath,
  isTrustedClaimUrl,
  refreshClaimAdvice,
  refreshClaimState,
  storedClaimHint,
  usableClaimUrl,
} from "../src/core/claim-link.ts";
import { CLAIM_LINK_REFRESH, ToolkitError, quotaExhausted } from "../src/core/errors.ts";
import type { AgentAccount } from "../src/types/index.ts";

const ACCOUNT_URL = "https://stub.test/api/agent/account";
const CLAIM_ENDPOINT = "https://stub.test/api/agent/claim";
const OLD_LINK = "https://app.zenrows.com/claim/old?utm_source=agent";
const NEW_LINK = "https://app.zenrows.com/claim/new?utm_source=agent";
const NOW = new Date("2026-08-01T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function acct(over: Partial<AgentAccount> = {}): AgentAccount {
  return { accountId: "u1", unclaimed: true, claimUrl: OLD_LINK, createdAt: daysAgo(1), ...over };
}

interface Stub {
  fetchImpl: typeof fetch;
  calls: { method: string; url: string; key: string | null }[];
}

/** A fake backend: `account` answers GET /account, `claim` answers POST /claim; "throw" simulates a network error. */
function stub(opts: { account?: { claimed: boolean } | number | "throw"; claim?: { claimUrl: string } | number | "throw" }): Stub {
  const calls: Stub["calls"] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = (init?.headers as Record<string, string>)?.["X-API-Key"] ?? null;
    calls.push({ method, url, key });
    const spec = url === ACCOUNT_URL ? opts.account : url === CLAIM_ENDPOINT ? opts.claim : undefined;
    if (spec === undefined) throw new Error(`unexpected ${method} ${url}`);
    if (spec === "throw") throw new TypeError("fetch failed");
    if (typeof spec === "number") {
      return spec === 409 ? json({ error: "already_claimed" }, 409) : json({ error: "x" }, spec);
    }
    if ("claimed" in spec) return json({ accountId: "u1", claimed: spec.claimed, isAgent: true });
    return json({ status: "unclaimed", claimUrl: spec.claimUrl, expiresAt: "2026-08-31T00:00:00Z" });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function withWorkspace(a: AgentAccount | null, fn: (root: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = tempRoot();
  createWorkspace(root);
  saveApiKey("zr-key", root);
  if (a) writeAccount(a, root);
  return fn(root).finally(cleanup);
}

const endpoints = { accountUrl: ACCOUNT_URL, claimUrl: CLAIM_ENDPOINT, now: NOW };

test("isTrustedClaimUrl: only https zenrows.com links", () => {
  assert.equal(isTrustedClaimUrl("https://app.zenrows.com/claim/t"), true);
  assert.equal(isTrustedClaimUrl("https://zenrows.com/claim/t"), true);
  assert.equal(isTrustedClaimUrl("http://app.zenrows.com/claim/t"), false);
  assert.equal(isTrustedClaimUrl("https://zenrows.com.evil.test/claim/t"), false);
  assert.equal(isTrustedClaimUrl("https://evilzenrows.com/claim/t"), false);
  assert.equal(isTrustedClaimUrl("javascript:alert(1)"), false);
  assert.equal(isTrustedClaimUrl(undefined), false);
});

test("usableClaimUrl: a link is usable under 30 days, falling back to createdAt for its age", () => {
  assert.equal(usableClaimUrl(acct({ createdAt: daysAgo(29) }), NOW), OLD_LINK);
  assert.equal(usableClaimUrl(acct({ createdAt: daysAgo(30) }), NOW), undefined);
  assert.equal(usableClaimUrl(acct({ createdAt: daysAgo(60), claimUrlIssuedAt: daysAgo(2) }), NOW), OLD_LINK);
  assert.equal(usableClaimUrl(acct({ claimUrl: "https://x.test/claim/t" }), NOW), undefined);
});

test("storedClaimHint: link, refresh marker, or nothing", () => {
  assert.equal(storedClaimHint(acct(), NOW), OLD_LINK);
  assert.equal(storedClaimHint(acct({ createdAt: daysAgo(31) }), NOW), CLAIM_LINK_REFRESH);
  assert.equal(storedClaimHint(acct({ unclaimed: false }), NOW), undefined);
  assert.equal(storedClaimHint(null, NOW), undefined);
});

test("quotaExhausted: the refresh marker tells the user to run `zenrows account claim`", () => {
  const err = quotaExhausted("u", CLAIM_LINK_REFRESH, { status: 402 });
  assert.match(err.next_action, /zenrows account claim/);
  assert.doesNotMatch(err.next_action, /https:\/\//);
});

test("requestClaimLink: POSTs with X-API-Key; 409 already_claimed → claimed", async () => {
  const s = stub({ claim: { claimUrl: NEW_LINK } });
  const res = await requestClaimLink("zr-key", { url: CLAIM_ENDPOINT, fetchImpl: s.fetchImpl });
  assert.deepEqual(res, { status: "unclaimed", claimUrl: NEW_LINK, expiresAt: "2026-08-31T00:00:00Z" });
  assert.deepEqual(s.calls, [{ method: "POST", url: CLAIM_ENDPOINT, key: "zr-key" }]);
  const s2 = stub({ claim: 409 });
  assert.deepEqual(await requestClaimLink("zr-key", { url: CLAIM_ENDPOINT, fetchImpl: s2.fetchImpl }), { status: "claimed" });
  const s3 = stub({ claim: 429 });
  await assert.rejects(requestClaimLink("zr-key", { url: CLAIM_ENDPOINT, fetchImpl: s3.fetchImpl }), ToolkitError);
});

test("refreshClaimState: fresh link (<25 days) is kept, no new link requested", () =>
  withWorkspace(acct({ claimUrlIssuedAt: daysAgo(24) }), async (root) => {
    const s = stub({ account: { claimed: false } });
    const st = await refreshClaimState({ projectRoot: root, force: true, fetchImpl: s.fetchImpl, ...endpoints });
    assert.deepEqual(st, { status: "unclaimed", claimUrl: OLD_LINK, refreshed: false });
    assert.equal(s.calls.filter((c) => c.method === "POST").length, 0);
  }));

test("refreshClaimState: link 25+ days old is replaced and stored (0600) with its issue time", () =>
  withWorkspace(acct({ claimUrlIssuedAt: daysAgo(25) }), async (root) => {
    const s = stub({ account: { claimed: false }, claim: { claimUrl: NEW_LINK } });
    const st = await refreshClaimState({ projectRoot: root, force: true, fetchImpl: s.fetchImpl, ...endpoints });
    assert.deepEqual(st, { status: "unclaimed", claimUrl: NEW_LINK, refreshed: true });
    const saved = readAccount(root)!;
    assert.equal(saved.claimUrl, NEW_LINK);
    assert.equal(saved.claimUrlIssuedAt, NOW.toISOString());
    if (process.platform !== "win32") assert.equal(statSync(workspacePaths(root).account).mode & 0o777, 0o600);
  }));

test("refreshClaimState: missing link is requested", () =>
  withWorkspace(acct({ claimUrl: "" }), async (root) => {
    const s = stub({ account: { claimed: false }, claim: { claimUrl: NEW_LINK } });
    const st = await refreshClaimState({ projectRoot: root, force: true, fetchImpl: s.fetchImpl, ...endpoints });
    assert.equal(st.status === "unclaimed" && st.claimUrl, NEW_LINK);
  }));

test("refreshClaimState: claimed account is recorded and hints stop", () =>
  withWorkspace(acct(), async (root) => {
    const s = stub({ account: { claimed: true } });
    const st = await refreshClaimState({ projectRoot: root, force: true, fetchImpl: s.fetchImpl, ...endpoints });
    assert.deepEqual(st, { status: "claimed" });
    assert.equal(readAccount(root)?.unclaimed, false);
    assert.equal(storedClaimHint(readAccount(root), NOW), undefined);
  }));

test("refreshClaimState: 409 already_claimed from the claim endpoint also marks claimed", () =>
  withWorkspace(acct({ createdAt: daysAgo(40) }), async (root) => {
    const s = stub({ account: "throw", claim: 409 });
    const st = await refreshClaimState({ projectRoot: root, force: true, fetchImpl: s.fetchImpl, ...endpoints });
    assert.deepEqual(st, { status: "claimed" });
    assert.equal(readAccount(root)?.unclaimed, false);
  }));

test("refreshClaimState: a non-zenrows claimUrl from the server is never stored", () =>
  withWorkspace(acct({ createdAt: daysAgo(26) }), async (root) => {
    const s = stub({ account: { claimed: false }, claim: { claimUrl: "https://evil.test/claim/x" } });
    const st = await refreshClaimState({ projectRoot: root, force: false, fetchImpl: s.fetchImpl, ...endpoints });
    assert.deepEqual(st, { status: "unclaimed", claimUrl: OLD_LINK, refreshed: false });
    assert.equal(readAccount(root)?.claimUrl, OLD_LINK);
  }));

test("refreshClaimState: network down, link under 30 days → keep it", () =>
  withWorkspace(acct({ createdAt: daysAgo(27) }), async (root) => {
    const s = stub({ account: "throw", claim: "throw" });
    const st = await refreshClaimState({ projectRoot: root, fetchImpl: s.fetchImpl, ...endpoints });
    assert.deepEqual(st, { status: "unclaimed", claimUrl: OLD_LINK, refreshed: false });
  }));

test("refreshClaimState: network down, link 30+ days old → no link (error path) / throws (forced)", () =>
  withWorkspace(acct({ createdAt: daysAgo(31) }), async (root) => {
    const s = stub({ account: "throw", claim: "throw" });
    const st = await refreshClaimState({ projectRoot: root, fetchImpl: s.fetchImpl, ...endpoints });
    assert.deepEqual(st, { status: "unclaimed", claimUrl: undefined, refreshed: false });
    await assert.rejects(
      refreshClaimState({ projectRoot: root, force: true, fetchImpl: s.fetchImpl, ...endpoints }),
      (e: unknown) => e instanceof ToolkitError && e.code === "BACKEND_UNAVAILABLE" && /zenrows account claim/.test(e.next_action),
    );
  }));

test("refreshClaimState: error-path checks are throttled to one per 6 hours; force bypasses", () =>
  withWorkspace(acct(), async (root) => {
    const s = stub({ account: { claimed: false } });
    await refreshClaimState({ projectRoot: root, fetchImpl: s.fetchImpl, ...endpoints });
    assert.equal(s.calls.length, 1);
    const later = new Date(NOW.getTime() + 5 * 3_600_000);
    await refreshClaimState({ projectRoot: root, fetchImpl: s.fetchImpl, ...endpoints, now: later });
    assert.equal(s.calls.length, 1, "within 6h: no network");
    await refreshClaimState({ projectRoot: root, force: true, fetchImpl: s.fetchImpl, ...endpoints, now: later });
    assert.equal(s.calls.length, 2, "forced: checks");
    const muchLater = new Date(NOW.getTime() + 12 * 3_600_000);
    await refreshClaimState({ projectRoot: root, fetchImpl: s.fetchImpl, ...endpoints, now: muchLater });
    assert.equal(s.calls.length, 3, "after 6h: checks again");
  }));

test("refreshClaimAdvice: rewrites a quota error once the account turns out claimed", () =>
  withWorkspace(acct(), async (root) => {
    const s = stub({ account: { claimed: true } });
    const before = quotaExhausted("u", OLD_LINK, { status: 402 });
    const after = (await refreshClaimAdvice(before, { projectRoot: root, fetchImpl: s.fetchImpl, ...endpoints })) as ToolkitError;
    assert.doesNotMatch(after.next_action, /claim/i);
    assert.match(after.next_action, /out of Zenrows credits/);
    assert.equal(after.code, before.code);
  }));

test("refreshClaimAdvice: swaps in a fresh link; leaves unrelated errors alone", () =>
  withWorkspace(acct({ createdAt: daysAgo(28) }), async (root) => {
    const s = stub({ account: { claimed: false }, claim: { claimUrl: NEW_LINK } });
    const after = (await refreshClaimAdvice(quotaExhausted("u", OLD_LINK), { projectRoot: root, fetchImpl: s.fetchImpl, ...endpoints })) as ToolkitError;
    assert.ok(after.next_action.includes(NEW_LINK));
    const other = new ToolkitError({ code: "FETCH_FAILED", message: "m", likely_cause: "c", next_action: "n" });
    assert.equal(await refreshClaimAdvice(other, { projectRoot: root, fetchImpl: s.fetchImpl, ...endpoints }), other);
  }));

test("isTrustedClaimUrl: a URL with userinfo is rejected", () => {
  assert.equal(isTrustedClaimUrl("https://user:pw@app.zenrows.com/claim/t"), false);
  assert.equal(isTrustedClaimUrl("https://user@app.zenrows.com/claim/t"), false);
});

test("refreshClaimState: 409 not_agent_account is final (marked claimed, no retry)", () =>
  withWorkspace(acct({ createdAt: daysAgo(40) }), async (root) => {
    const s = stub({ account: "throw", claim: 409 });
    // the stub's 409 says already_claimed; swap in not_agent_account
    const fetchImpl = (async (url: string, init?: RequestInit) =>
      url === CLAIM_ENDPOINT
        ? new Response(JSON.stringify({ error: "not_agent_account" }), { status: 409 })
        : s.fetchImpl(url, init)) as unknown as typeof fetch;
    assert.deepEqual(await refreshClaimState({ projectRoot: root, force: true, fetchImpl, ...endpoints }), { status: "claimed" });
    assert.equal(readAccount(root)?.unclaimed, false);
  }));

test("refreshClaimState: parallel refreshes mint one link, not one each", () =>
  withWorkspace(acct({ createdAt: daysAgo(40) }), async (root) => {
    const s = stub({ account: { claimed: false }, claim: { claimUrl: NEW_LINK } });
    const slow = (async (url: string, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 30));
      return s.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const results = await Promise.all(
      [0, 1, 2, 3].map(() => refreshClaimState({ projectRoot: root, fetchImpl: slow, ...endpoints })),
    );
    assert.equal(s.calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(results.filter((r) => r.status === "unclaimed" && r.refreshed).length, 1);
    assert.equal(readAccount(root)?.claimUrl, NEW_LINK);
    assert.equal(existsSync(workspacePaths(root).account + ".lock"), false, "lock released");
  }));

test("refreshClaimState: skips the POST when another process stored a fresh link meanwhile", () =>
  withWorkspace(acct({ createdAt: daysAgo(40) }), async (root) => {
    const s = stub({ account: { claimed: false }, claim: { claimUrl: NEW_LINK } });
    const racing = (async (url: string, init?: RequestInit) => {
      // While our status check is in flight, another process writes a fresh link.
      if (url === ACCOUNT_URL) writeAccount(acct({ createdAt: daysAgo(40), claimUrl: "https://app.zenrows.com/claim/other", claimUrlIssuedAt: daysAgo(0) }), root);
      return s.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const st = await refreshClaimState({ projectRoot: root, force: true, fetchImpl: racing, ...endpoints });
    assert.deepEqual(st, { status: "unclaimed", claimUrl: "https://app.zenrows.com/claim/other", refreshed: false });
    assert.equal(s.calls.filter((c) => c.method === "POST").length, 0);
  }));

test("refreshClaimState: a live lock held elsewhere means no network; a stale one is taken over", () =>
  withWorkspace(acct({ createdAt: daysAgo(40) }), async (root) => {
    const lock = workspacePaths(root).account + ".lock";
    writeFileSync(lock, "99999");
    const s = stub({ account: { claimed: false }, claim: { claimUrl: NEW_LINK } });
    await refreshClaimState({ projectRoot: root, fetchImpl: s.fetchImpl, ...endpoints });
    assert.equal(s.calls.length, 0);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    await refreshClaimState({ projectRoot: root, fetchImpl: s.fetchImpl, ...endpoints });
    assert.equal(s.calls.filter((c) => c.method === "POST").length, 1);
  }));

test("claim lock: release never deletes a lock another process now holds", () =>
  withWorkspace(acct({ createdAt: daysAgo(40) }), async (root) => {
    const lock = _claimLockPath(root);
    const s = stub({ account: { claimed: false }, claim: { claimUrl: NEW_LINK } });
    const stealing = (async (url: string, init?: RequestInit) => {
      // Simulate our lock being taken over (we looked stale) by another process.
      if (url === ACCOUNT_URL) writeFileSync(lock, "someone-else");
      return s.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    await refreshClaimState({ projectRoot: root, force: true, fetchImpl: stealing, ...endpoints });
    assert.equal(readFileSync(lock, "utf8"), "someone-else");
  }));
