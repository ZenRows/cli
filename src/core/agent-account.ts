/**
 * Agent account persistence + public signup client.
 *
 * `account.json` records an auto-provisioned, unclaimed Zenrows Free plan account.
 * It never holds the API key (that lives in secrets.json, 0600) — only the
 * accountId, the human-facing claim URL, and claim metadata.
 */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { AgentAccount } from "../types/index.ts";
import { attributionEnabled, getOrCreateTelemetryId, loadConfig, CLI_VERSION } from "./config.ts";
import { ToolkitError } from "./errors.ts";
import { AGENT_SIGNUP_API_URL, WELL_KNOWN_PROTECTED_RESOURCE } from "./open-url.ts";
import { detectClient } from "./provenance.ts";
import { findWorkspace, readJson, workspacePaths, writeJson } from "./workspace.ts";

/** Env var to override the signup endpoint (highest priority; for local testing). */
export const SIGNUP_URL_ENV = "ZENROWS_AGENT_SIGNUP_URL";
/** Env var to override the discovery base origin (for local testing). */
export const DISCOVERY_URL_ENV = "ZENROWS_DISCOVERY_URL";

/**
 * Cache for a discovered signup URL, so the well-known lookup runs at most once
 * per process. Explicit env/config overrides are checked first and always win.
 */
let discoveredSignupUrl: string | null | undefined;

/** Reset the discovery cache. Test-only. */
export function _resetDiscoveryCache(): void {
  discoveredSignupUrl = undefined;
}

/**
 * Discover the agent-signup endpoint from the well-known protected-resource
 * document. Base origin precedence:
 *   1. ZENROWS_DISCOVERY_URL env var
 *   2. `discoveryUrl` in .zenrows/config.json
 *   3. the production origin (derived from AGENT_SIGNUP_API_URL)
 * Returns the advertised `agent_auth.signup_endpoint` if present, else null.
 * Swallows all errors (offline, non-JSON, missing field) → null.
 */
export async function discoverSignupUrl(
  projectRoot?: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  try {
    const base =
      process.env[DISCOVERY_URL_ENV]?.trim() ||
      loadConfig(projectRoot).discoveryUrl?.trim() ||
      new URL(AGENT_SIGNUP_API_URL).origin;
    const url = base.replace(/\/$/, "") + WELL_KNOWN_PROTECTED_RESOURCE;
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "zenrows-cli" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { agent_auth?: { signup_endpoint?: unknown } };
    const endpoint = json?.agent_auth?.signup_endpoint;
    if (typeof endpoint === "string" && endpoint.trim()) return endpoint.trim();
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the agent-signup endpoint. Precedence:
 *   1. ZENROWS_AGENT_SIGNUP_URL env var (local testing)
 *   2. `signupUrl` in .zenrows/config.json
 *   3. discovery via /.well-known/oauth-protected-resource (cached per process)
 *   4. the production default (AGENT_SIGNUP_API_URL)
 */
export async function resolveSignupUrl(
  projectRoot?: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const fromEnv = process.env[SIGNUP_URL_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const configured = loadConfig(projectRoot).signupUrl;
  if (configured && configured.trim()) return configured.trim();
  if (discoveredSignupUrl === undefined) {
    discoveredSignupUrl = await discoverSignupUrl(projectRoot, opts);
  }
  if (discoveredSignupUrl) return discoveredSignupUrl;
  return AGENT_SIGNUP_API_URL;
}

function accountPath(projectRoot?: string): string {
  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  return ws.account;
}

export function readAccount(projectRoot?: string): AgentAccount | null {
  return readJson<AgentAccount>(accountPath(projectRoot));
}

export function writeAccount(acct: AgentAccount, projectRoot?: string): void {
  const file = accountPath(projectRoot);
  writeJson(file, acct);
  try {
    // account.json holds the single-use claim token — restrict to owner-only.
    chmodSync(file, 0o600);
  } catch {
    // best-effort on platforms without POSIX permissions
  }
}

/** Remove local agent account metadata (used by `zenrows logout`). */
export function clearAccount(projectRoot?: string): boolean {
  const file = accountPath(projectRoot);
  if (!existsSync(file)) return false;
  try {
    unlinkSync(file);
  } catch {
    return false;
  }
  return true;
}

export interface SignupResponse {
  apiKey: string;
  accountId: string;
  claimUrl: string;
}

export async function signupAgent(
  opts: { url?: string; fetchImpl?: typeof fetch } = {},
): Promise<SignupResponse> {
  const url = opts.url ?? (await resolveSignupUrl(undefined, { fetchImpl: opts.fetchImpl }));
  const doFetch = opts.fetchImpl ?? fetch;

  // Signup is the one functional request the CLI must make — no separate
  // telemetry beacon exists. When attribution is enabled we ride anonymous
  // provenance on it (a random id + coarse host/runtime brand). No PII, no URLs.
  // `telemetry:"off"` / ZENROWS_TELEMETRY=off suppresses every X-ZR-* header.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "User-Agent": "zenrows-cli",
  };
  if (attributionEnabled()) {
    const p = detectClient();
    headers["X-ZR-Agent-Id"] = getOrCreateTelemetryId();
    headers["X-ZR-Client"] = p.client;
    headers["X-ZR-Source"] = "cli";
    headers["X-ZR-CLI-Version"] = CLI_VERSION;
    headers["X-ZR-OS"] = p.os;
    headers["X-ZR-Node"] = p.node;
    headers["X-ZR-CI"] = p.ci ? "1" : "0";
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers,
    });
  } catch (err) {
    throw new ToolkitError({
      code: "BACKEND_UNAVAILABLE",
      message: "Could not reach the Zenrows signup endpoint.",
      likely_cause: err instanceof Error ? err.message : String(err),
      next_action: "Check connectivity and retry, or sign up manually with: zenrows signup --no-open",
    });
  }
  if (res.status !== 201) {
    const body = await res.text();
    if (res.status === 429) {
      throw new ToolkitError({
        code: "SIGNUP_RATE_LIMITED",
        message: "Zenrows blocked the auto-signup: too many new accounts from this network.",
        likely_cause: body.slice(0, 240) || "The signup endpoint is rate-limited for this IP.",
        next_action:
          "Wait a few minutes and retry — the toolkit will try again automatically. If you already have a Zenrows API key, use it now with: zenrows login --api-key <key> (or set ZENROWS_API_KEY).",
        suggested_commands: ["zenrows login --api-key <your-key>"],
      });
    }
    throw new ToolkitError({
      code: "FETCH_FAILED",
      message: `Agent signup failed (HTTP ${res.status}).`,
      likely_cause: body.slice(0, 240),
      next_action: "Retry, or use an existing key: zenrows login --api-key <key>.",
      suggested_commands: ["zenrows login --api-key <your-key>"],
    });
  }
  return (await res.json()) as SignupResponse;
}

export interface AccountStatus {
  accountId: string;
  /** True once a human has claimed the account. */
  claimed: boolean;
  isAgent: boolean;
}

/**
 * The claim-status endpoint shares the signup base (…/api/agent/signup →
 * …/api/agent/account). Derived so the `ZENROWS_AGENT_SIGNUP_URL` /
 * `signupUrl` override applies here too (local/staging testing).
 */
export async function resolveAccountUrl(
  projectRoot?: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<string> {
  return (await resolveSignupUrl(projectRoot, opts)).replace(/\/signup\/?$/, "/account");
}

/**
 * Ask the backend whether the account behind `apiKey` has been claimed
 * (claiming happens in the browser, out-of-band from the CLI). Auth via the
 * `X-API-Key` header. Throws ToolkitError on failure.
 */
export async function fetchAccountStatus(
  apiKey: string,
  opts: { url?: string; fetchImpl?: typeof fetch } = {},
): Promise<AccountStatus> {
  const url = opts.url ?? (await resolveAccountUrl());
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: "GET",
    headers: { "X-API-Key": apiKey, Accept: "application/json", "User-Agent": "zenrows-cli" },
  });
  if (res.status !== 200) {
    const body = await res.text();
    throw new ToolkitError({
      code: res.status === 401 || res.status === 403 ? "AUTH_INVALID" : "FETCH_FAILED",
      message: `Account status request failed (HTTP ${res.status}).`,
      likely_cause: body.slice(0, 240),
      next_action: "Retry, or check the account in the Zenrows dashboard.",
    });
  }
  return (await res.json()) as AccountStatus;
}
