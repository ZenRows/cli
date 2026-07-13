/**
 * Minimal HTTP client for the ZenRows Universal Scraper API (`/v1/`).
 *
 * Uses the global `fetch` (Node 18+). The API key is sent as the `apikey`
 * query parameter (per docs) and is registered as a secret so it is redacted
 * from any logged URL.
 */
import { ToolkitError, quotaExhausted } from "./errors.ts";
import { readAccount } from "./agent-account.ts";
import { registerSecret } from "./logger.ts";

export interface ScraperResult {
  status: number;
  /** Original target status when `original_status=true` was requested. */
  body: string;
  contentType: string;
  /** Cost in USD reported by X-Request-Cost, if present. */
  costUsd: number | null;
  requestId: string | null;
  finalUrl: string | null;
  concurrencyRemaining: number | null;
  /** The request URL with the apikey redacted — safe to log/persist. */
  redactedUrl: string;
}

export interface ScraperParams {
  url: string;
  [param: string]: string | number | boolean | undefined;
}

function buildUrl(apiBase: string, apiKey: string, params: ScraperParams): { full: string; redacted: string } {
  const u = new URL(apiBase);
  u.searchParams.set("apikey", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    u.searchParams.set(k, typeof v === "boolean" ? String(v) : String(v));
  }
  const full = u.toString();
  const redactedUrl = new URL(full);
  redactedUrl.searchParams.set("apikey", "***REDACTED***");
  return { full, redacted: redactedUrl.toString() };
}

/** Perform a Universal Scraper API request. Throws ToolkitError on failure. */
export async function scrape(
  apiBase: string,
  apiKey: string,
  params: ScraperParams,
  opts: { timeoutMs?: number } = {},
): Promise<ScraperResult> {
  registerSecret(apiKey);
  const { full, redacted } = buildUrl(apiBase, apiKey, params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000);

  let res: Response;
  try {
    res = await fetch(full, {
      method: "GET",
      headers: { "User-Agent": "zenrows-cli/0.1.0", "Accept-Encoding": "gzip, deflate" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const cause = err instanceof Error ? err.message : String(err);
    throw new ToolkitError({
      code: "BACKEND_UNAVAILABLE",
      message: `Could not reach the ZenRows API.`,
      likely_cause: `Network error or timeout: ${cause}`,
      next_action: "Check connectivity and retry. Verify api base in `zenrows config show`.",
      suggested_commands: ["zenrows status", "zenrows config show"],
    });
  }
  clearTimeout(timeout);

  const body = await res.text();
  const result: ScraperResult = {
    status: res.status,
    body,
    contentType: res.headers.get("content-type") ?? "",
    costUsd: parseCost(res.headers.get("x-request-cost")),
    requestId: res.headers.get("x-request-id"),
    finalUrl: res.headers.get("zr-final-url"),
    concurrencyRemaining: numOrNull(res.headers.get("concurrency-remaining")),
    redactedUrl: redacted,
  };

  if (res.status === 401 || res.status === 403) {
    // Distinguish ZenRows auth errors from target-site 403s. ZenRows auth
    // failures surface AUTH00x codes in the body.
    if (/AUTH00\d|API key|apikey/i.test(body)) {
      const cause = `HTTP ${res.status}: ${zrErrorDetail(body) ?? snippet(body)}`;
      const acct = readAccount();
      if (acct?.unclaimed) {
        // The key was auto-provisioned by the toolkit — do NOT tell the user to
        // fetch a key from a dashboard they never used.
        throw new ToolkitError({
          code: "AUTH_INVALID",
          message: "The auto-provisioned trial key was rejected by the ZenRows API.",
          likely_cause: `${cause}. The signup endpoint issued this key, but the scraping API did not accept it.`,
          next_action:
            "If you are testing against a local/staging backend, ensure `apiBase` (zenrows config) points at the same environment that issued the key. Otherwise re-provision with `zenrows signup --agent`, or claim the account: " +
            acct.claimUrl,
          suggested_commands: ["zenrows status", "zenrows signup --agent"],
        });
      }
      throw new ToolkitError({
        code: "AUTH_INVALID",
        message: "ZenRows rejected the API key.",
        likely_cause: cause,
        next_action: "Re-check your key in the ZenRows dashboard and log in again.",
        suggested_commands: ["zenrows login --api-key <your-key>"],
      });
    }
  }
  if (res.status === 429) {
    // A 429 is not always trial-credit exhaustion: it can also be a ZenRows
    // account concurrency cap or a target-site rate limit. Only nudge to
    // claim/add credits when the body indicates an actual account credit/quota
    // limit; otherwise advise a brief retry.
    if (isQuotaError(body)) {
      const acct = readAccount();
      throw quotaExhausted(redacted, acct?.unclaimed ? acct.claimUrl : undefined);
    }
    const detail = zrErrorDetail(body) ?? snippet(body);
    throw new ToolkitError({
      code: "FETCH_FAILED",
      message: "Rate limited (HTTP 429).",
      likely_cause: detail
        ? `${detail}. This looks like a concurrency cap or a target-site rate limit, not trial-credit exhaustion.`
        : "A concurrency cap or a target-site rate limit was hit, not trial-credit exhaustion.",
      next_action: "Wait a few seconds and retry. If it persists, lower concurrency / parallel requests.",
      suggested_commands: [`zenrows fetch ${params.url}`],
    });
  }
  if (res.status === 422 || res.status >= 500 || (res.status >= 400 && !looksLikeContent(result))) {
    throw new ToolkitError({
      code: "FETCH_FAILED",
      message: `Protected Fetch failed with HTTP ${res.status}.`,
      likely_cause: snippet(body) || "The target may require js_render and/or premium_proxy.",
      next_action:
        "Retry with --manual --js-render --premium-proxy, or inspect the trace for the exact reason.",
      suggested_commands: [`zenrows fetch ${params.url} --manual --js-render --premium-proxy`],
    });
  }
  if (!body) {
    throw new ToolkitError({
      code: "FETCH_EMPTY_RESPONSE",
      message: "Protected Fetch returned an empty response.",
      likely_cause: "The page may render content via JavaScript, or a wait condition is needed.",
      next_action: "Retry with --js-render and a --wait-for selector or --wait <ms>.",
      suggested_commands: [`zenrows fetch ${params.url} --manual --js-render --wait 3000`],
    });
  }
  return result;
}

function looksLikeContent(r: ScraperResult): boolean {
  // allowed_status_codes / original_status can legitimately return 4xx bodies.
  return r.body.length > 0;
}

function parseCost(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function numOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function snippet(s: string): string {
  return s.slice(0, 240).replace(/\s+/g, " ").trim();
}

/**
 * Extract a clean one-line detail from a ZenRows JSON error body
 * (e.g. `(AUTH003) Invalid apikey provided`) instead of dumping a
 * truncated, mangled JSON string. Returns null if the body isn't the
 * expected JSON shape.
 */
/**
 * Decide whether a 429 body indicates a ZenRows *account* credit/quota limit
 * (trial exhausted, out of credits) rather than a concurrency cap or a
 * target-site rate limit. Only the former warrants the "claim / add credits"
 * nudge; concurrency and target 429s are handled generically.
 */
export function isQuotaError(body: string): boolean {
  let code = "";
  let text = "";
  try {
    const j = JSON.parse(body) as { code?: string; title?: string; detail?: string };
    code = (j.code ?? "").toLowerCase();
    text = `${j.title ?? ""} ${j.detail ?? ""}`.toLowerCase();
  } catch {
    text = body.toLowerCase();
  }
  const haystack = `${code} ${text}`;
  // Concurrency caps and target-site limits are never credit exhaustion.
  if (/concurren/.test(haystack)) return false;
  return /quota|credit|out of requests|used all|plan limit|exhaust|insufficient|billing|payment|upgrade/.test(
    haystack,
  );
}

function zrErrorDetail(body: string): string | null {
  try {
    const j = JSON.parse(body) as { code?: string; title?: string; detail?: string };
    const label = j.title ?? j.detail;
    if (!label) return null;
    return j.code ? `(${j.code}) ${label}` : label;
  } catch {
    return null;
  }
}
