import { test } from "node:test";
import assert from "node:assert/strict";
import { tempRoot } from "./helpers.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { readAccount, writeAccount, clearAccount, signupAgent, resolveSignupUrl, SIGNUP_URL_ENV, DISCOVERY_URL_ENV, resolveAccountUrl, fetchAccountStatus, _resetDiscoveryCache } from "../src/core/agent-account.ts";
import { saveConfig } from "../src/core/config.ts";
import { AGENT_SIGNUP_API_URL } from "../src/core/open-url.ts";
import { ToolkitError } from "../src/core/errors.ts";

test("account.json round-trips", () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    writeAccount({ accountId: "u1", unclaimed: true, claimUrl: "https://x/claim/t", createdAt: "2026-07-10T00:00:00Z" }, root);
    const back = readAccount(root);
    assert.equal(back?.accountId, "u1");
    assert.equal(back?.unclaimed, true);
  } finally {
    cleanup();
  }
});

test("clearAccount removes account.json", () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    writeAccount({ accountId: "u1", unclaimed: true, claimUrl: "https://x/claim/t", createdAt: "2026-07-10T00:00:00Z" }, root);
    assert.equal(clearAccount(root), true);
    assert.equal(readAccount(root), null);
    assert.equal(clearAccount(root), false);
  } finally {
    cleanup();
  }
});

test("signupAgent parses a 201 response and sends provenance headers", async () => {
  let sentHeaders: Record<string, string> = {};
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    sentHeaders = (init?.headers as Record<string, string>) ?? {};
    return new Response(JSON.stringify({ apiKey: "zr-key", accountId: "u1", claimUrl: "https://x/claim/t" }),
      { status: 201, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const res = await signupAgent({ url: "https://x/api/agent/signup", fetchImpl: fakeFetch });
  assert.equal(res.apiKey, "zr-key");
  assert.equal(res.accountId, "u1");
  assert.equal(res.claimUrl, "https://x/claim/t");
  // Anonymous provenance headers (shared contract with the Zenrows signup API).
  assert.ok(sentHeaders["X-ZR-Agent-Id"] && sentHeaders["X-ZR-Agent-Id"].length > 0);
  assert.equal(sentHeaders["X-ZR-Source"], "cli");
  assert.ok(typeof sentHeaders["X-ZR-Client"] === "string");
  assert.ok(typeof sentHeaders["X-ZR-CLI-Version"] === "string");
  assert.ok(typeof sentHeaders["X-ZR-OS"] === "string");
  assert.ok(sentHeaders["X-ZR-CI"] === "0" || sentHeaders["X-ZR-CI"] === "1");
});

test("signupAgent omits all provenance headers when opted out via env", async () => {
  const prev = process.env.ZENROWS_TELEMETRY;
  process.env.ZENROWS_TELEMETRY = "off";
  let sentHeaders: Record<string, string> = {};
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    sentHeaders = (init?.headers as Record<string, string>) ?? {};
    return new Response(JSON.stringify({ apiKey: "k", accountId: "u1", claimUrl: "https://x/claim/t" }),
      { status: 201, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    await signupAgent({ url: "https://x/api/agent/signup", fetchImpl: fakeFetch });
    for (const h of ["X-ZR-Agent-Id", "X-ZR-Client", "X-ZR-Source", "X-ZR-CLI-Version", "X-ZR-OS", "X-ZR-Node", "X-ZR-CI"]) {
      assert.equal(sentHeaders[h], undefined, `${h} must not be sent when opted out`);
    }
  } finally {
    if (prev !== undefined) process.env.ZENROWS_TELEMETRY = prev;
    else delete process.env.ZENROWS_TELEMETRY;
  }
});

test("resolveSignupUrl: default, config override, env override precedence", async () => {
  const { root, cleanup } = tempRoot();
  const prevSignup = process.env[SIGNUP_URL_ENV];
  const prevDisco = process.env[DISCOVERY_URL_ENV];
  delete process.env[SIGNUP_URL_ENV];
  delete process.env[DISCOVERY_URL_ENV];
  _resetDiscoveryCache();
  // A discovery fetch that returns nothing usable, so we exercise the default.
  const noDisco = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  try {
    createWorkspace(root);
    // 1. default (no config, no env, discovery yields null)
    assert.equal(await resolveSignupUrl(root, { fetchImpl: noDisco }), AGENT_SIGNUP_API_URL);
    // 2. config override (beats discovery/default)
    saveConfig({ apiBase: "https://api.zenrows.com/v1/", defaultMode: "auto", telemetry: "off", version: "0.1.0", signupUrl: "http://localhost.com:8000/api/agent/signup" }, root);
    assert.equal(await resolveSignupUrl(root), "http://localhost.com:8000/api/agent/signup");
    // 3. env beats config
    process.env[SIGNUP_URL_ENV] = "http://127.0.0.1:9/api/agent/signup";
    assert.equal(await resolveSignupUrl(root), "http://127.0.0.1:9/api/agent/signup");
  } finally {
    if (prevSignup !== undefined) process.env[SIGNUP_URL_ENV] = prevSignup;
    else delete process.env[SIGNUP_URL_ENV];
    if (prevDisco !== undefined) process.env[DISCOVERY_URL_ENV] = prevDisco;
    else delete process.env[DISCOVERY_URL_ENV];
    _resetDiscoveryCache();
    cleanup();
  }
});

test("resolveSignupUrl: discovers via .well-known when no env/config", async () => {
  const { root, cleanup } = tempRoot();
  const prevSignup = process.env[SIGNUP_URL_ENV];
  const prevDisco = process.env[DISCOVERY_URL_ENV];
  delete process.env[SIGNUP_URL_ENV];
  delete process.env[DISCOVERY_URL_ENV];
  _resetDiscoveryCache();
  let calledUrl: string | undefined;
  const fakeFetch = (async (url: string) => {
    calledUrl = url;
    return new Response(
      JSON.stringify({ agent_auth: { signup_endpoint: "https://disco.example/api/agent/signup" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    createWorkspace(root);
    assert.equal(await resolveSignupUrl(root, { fetchImpl: fakeFetch }), "https://disco.example/api/agent/signup");
    assert.ok(calledUrl?.endsWith("/.well-known/oauth-protected-resource"));
    // resolveAccountUrl derives /account from the discovered (cached) signup URL.
    assert.equal(await resolveAccountUrl(root), "https://disco.example/api/agent/account");
  } finally {
    if (prevSignup !== undefined) process.env[SIGNUP_URL_ENV] = prevSignup;
    else delete process.env[SIGNUP_URL_ENV];
    if (prevDisco !== undefined) process.env[DISCOVERY_URL_ENV] = prevDisco;
    else delete process.env[DISCOVERY_URL_ENV];
    _resetDiscoveryCache();
    cleanup();
  }
});

test("resolveAccountUrl derives /account from the signup URL", async () => {
  const { root, cleanup } = tempRoot();
  const prev = process.env[SIGNUP_URL_ENV];
  process.env[SIGNUP_URL_ENV] = "http://localhost.com:8000/api/agent/signup";
  try {
    createWorkspace(root);
    assert.equal(await resolveAccountUrl(root), "http://localhost.com:8000/api/agent/account");
  } finally {
    if (prev !== undefined) process.env[SIGNUP_URL_ENV] = prev;
    else delete process.env[SIGNUP_URL_ENV];
    cleanup();
  }
});

test("fetchAccountStatus parses claim state and sends X-API-Key", async () => {
  let sentKey: unknown;
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    sentKey = (init?.headers as Record<string, string>)["X-API-Key"];
    return new Response(JSON.stringify({ accountId: "u1", claimed: true, isAgent: false }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const s = await fetchAccountStatus("zr-key", { url: "https://x/api/agent/account", fetchImpl: fakeFetch });
  assert.equal(sentKey, "zr-key");
  assert.equal(s.claimed, true);
  assert.equal(s.accountId, "u1");
});

test("signupAgent throws SIGNUP_RATE_LIMITED on 429", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(
    () => signupAgent({ fetchImpl: fakeFetch }),
    (e: unknown) => e instanceof ToolkitError && e.code === "SIGNUP_RATE_LIMITED",
  );
});
