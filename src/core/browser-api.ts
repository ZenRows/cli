/**
 * Client for the Zenrows Browser Sessions REST API.
 *
 * A managed REST session API (used in production by the official `@zenrows/mcp`
 * server) hosted at `https://mcp.zenrows.com/browser/sessions/*`. Auth is the
 * `Authorization: Bearer <key>` header (same key as the Fetch API). Bodies are
 * JSON; the CLI drives it directly — no CDP/WebSocket, no browser dependency.
 * Structurally the same shape as `batch-api.ts` (separate host, header auth,
 * injectable `fetchImpl` for tests).
 *
 * Sessions are billed by bandwidth + session time, so callers must always close
 * them (`closeSession`) — the `browser run` command does so in a `finally`.
 */
import { ToolkitError, quotaExhausted } from "./errors.ts";
import { readAccount } from "./agent-account.ts";
import { registerSecret } from "./logger.ts";
import { CLI_VERSION } from "./config.ts";

/** Managed Browser session API base (no trailing slash). Tied to the MCP host. */
export const DEFAULT_BROWSER_BASE = "https://mcp.zenrows.com";
/** Env var to override the Browser API base (local/staging testing). */
export const BROWSER_BASE_ENV = "ZENROWS_BROWSER_URL";
/** Direct CDP WebSocket endpoint for the `connect` passthrough (bring your own Playwright). */
export const DEFAULT_CDP_BASE = "wss://browser.zenrows.com";

/** Resolve the Browser API base, honoring the env override, trimmed of trailing `/`. */
export function browserBase(): string {
  const env = process.env[BROWSER_BASE_ENV];
  const base = env && env.trim() ? env.trim() : DEFAULT_BROWSER_BASE;
  return base.replace(/\/+$/, "");
}

export interface BrowserSession {
  session_id: string;
  expires_at: string;
  [k: string]: unknown;
}

/** Proxy knobs accepted at session creation (per the MCP tool schema). */
export interface SessionProxyOpts {
  proxy_country?: string;
  proxy_region?: string;
}

interface RequestOpts {
  apiKey: string;
  body?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Perform a Browser API request. Sets `Authorization: Bearer`, adds a JSON
 * content-type when a body is present, parses the JSON response, and on a
 * non-2xx maps the error body into a normalized ToolkitError. Returns `null`
 * for empty (204 / no-body) responses.
 */
export async function browserRequest<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
  registerSecret(opts.apiKey);
  const url = browserBase() + path;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    Accept: "application/json",
    "User-Agent": `zenrows-cli/${CLI_VERSION}`,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new ToolkitError({
      code: "BACKEND_UNAVAILABLE",
      message: "Could not reach the Zenrows Browser API.",
      likely_cause: err instanceof Error ? err.message : String(err),
      next_action:
        "Check connectivity and retry. Override the host with ZENROWS_BROWSER_URL if you are testing against staging.",
      suggested_commands: ["zenrows status"],
    });
  }
  clearTimeout(timeout);

  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw browserProblemToError(res.status, text, method, path);
  }
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolkitError({
      code: "BROWSER_UNAVAILABLE",
      message: "The Browser API response was not valid JSON.",
      likely_cause: text.slice(0, 240),
      next_action: "Retry; if it persists, contact Zenrows support.",
    });
  }
}

/** Map an error body + HTTP status to a normalized ToolkitError. */
export function browserProblemToError(status: number, body: string, method: string, path: string): ToolkitError {
  let parsed: { error?: string; detail?: string; title?: string; code?: string } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    // non-JSON error body — fall through
  }
  const serverCode = parsed.code ?? "";
  const detail = parsed.error || parsed.detail || parsed.title || body.slice(0, 240) || `HTTP ${status}`;
  const cause = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""} for ${method} ${path}: ${detail}`;

  if (status === 401) {
    return new ToolkitError({
      code: "AUTH_INVALID",
      message: "Zenrows rejected the API key for the Browser API.",
      likely_cause: cause,
      next_action: "Re-check your key and log in again.",
      suggested_commands: ["zenrows login --api-key <your-key>"],
    });
  }
  if (status === 402) {
    // Out of credits — same exhausted state as the scraper/batch 402.
    const acct = readAccount();
    return quotaExhausted(`${method} ${path}`, acct?.unclaimed ? acct.claimUrl : undefined, {
      status: 402,
      detail: parsed.error || parsed.detail || parsed.title || undefined,
    });
  }
  if (status === 404) {
    return new ToolkitError({
      code: "BROWSER_UNAVAILABLE",
      message: "Browser session not found.",
      likely_cause: `${cause}. The session id may be wrong, or the session expired (sessions have a short TTL and an idle timeout).`,
      next_action: "Open a fresh session with `zenrows browser open <url>`, or use `zenrows browser run <script.json>` for multi-step flows.",
    });
  }

  const transient = status >= 500 || status === 429 || status === 403;
  return new ToolkitError({
    code: "BROWSER_UNAVAILABLE",
    message: `Browser request failed (HTTP ${status}).`,
    likely_cause: cause,
    next_action: transient
      ? "This may be transient (rate limit / concurrency cap / upstream). Wait a moment and retry; close idle sessions with `zenrows browser close`."
      : "Fix the reported problem and retry. Verify the session id, selector, and arguments.",
  });
}

/** Create a browser session. Returns { session_id, expires_at }. */
export function createSession(apiKey: string, proxy: SessionProxyOpts = {}, fetchImpl?: typeof fetch): Promise<BrowserSession> {
  const body: SessionProxyOpts = {};
  if (proxy.proxy_country) body.proxy_country = proxy.proxy_country;
  if (proxy.proxy_region) body.proxy_region = proxy.proxy_region;
  return browserRequest<BrowserSession>("POST", "/browser/sessions", { apiKey, body, fetchImpl });
}

/** Call a session verb (e.g. navigate/click/get_text). Most are POST; a few are GET/DELETE. */
export function sessionCall<T = unknown>(
  apiKey: string,
  sessionId: string,
  verb: string,
  opts: { method?: string; body?: unknown; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  return browserRequest<T>(opts.method ?? "POST", `/browser/sessions/${sessionId}/${verb}`, {
    apiKey,
    body: opts.body,
    fetchImpl: opts.fetchImpl,
  });
}

/** Close a browser session and free its slot. */
export function closeSession(apiKey: string, sessionId: string, fetchImpl?: typeof fetch): Promise<null> {
  return browserRequest<null>("DELETE", `/browser/sessions/${sessionId}`, { apiKey, fetchImpl });
}

/** Decode a base64 capture body ({data, mime_type}) into bytes + a file extension. */
export function decodeBinary(data: { data: string; mime_type: string }): { buf: Buffer; ext: string } {
  const mime = (data.mime_type || "").toLowerCase();
  const ext = mime.includes("pdf") ? "pdf" : mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
  return { buf: Buffer.from(data.data ?? "", "base64"), ext };
}

/**
 * The `/select` backend matches() each `<option>` against `value` as a CSS
 * selector (not the option's value attribute). Plain values like `"2"` throw;
 * wrap them as `option[value="2"]`. Leave real selectors untouched.
 *
 * Only treat as "already a selector" when it looks like an attribute selector
 * or an explicit `option…` / `*` qualifier — dots/colons/hashes alone are
 * common in option values (`1.5`, `10:30`, `en:US`) and must still be wrapped.
 */
export function normalizeSelectValue(value: string): string {
  const v = value.trim();
  if (v.includes("[") || /^\s*(option[[.:#*\s]|\*)/i.test(v)) return v;
  const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `option[value="${escaped}"]`;
}

/**
 * Build the direct CDP WebSocket endpoint (`wss://browser.zenrows.com?apikey=…`)
 * for the `connect` passthrough. NOTE: the returned string contains the API key.
 */
export function connectUrl(apiKey: string, proxy: SessionProxyOpts = {}): string {
  const u = new URL(DEFAULT_CDP_BASE);
  u.searchParams.set("apikey", apiKey);
  if (proxy.proxy_country) u.searchParams.set("proxy_country", proxy.proxy_country);
  if (proxy.proxy_region) u.searchParams.set("proxy_region", proxy.proxy_region);
  return u.toString();
}
