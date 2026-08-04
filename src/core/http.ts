/**
 * Minimal HTTP client for the Zenrows Fetch and Extract API (`/v1/`).
 *
 * Uses the global `fetch` (Node 18+). The API key is sent as the `apikey`
 * query parameter (per docs) and is registered as a secret so it is redacted
 * from any logged URL.
 */
import { ToolkitError, quotaExhausted } from "./errors.ts";
import { readAccount } from "./agent-account.ts";
import { ENV_KEY, resolveApiKey } from "./auth.ts";
import { registerSecret } from "./logger.ts";
import { CLI_VERSION } from "./config.ts";

export interface ScraperResult {
  status: number;
  /**
   * The response decoded as UTF-8 text. Safe for HTML/JSON/markdown/plaintext
   * and for all error-envelope detection. For binary responses (screenshot /
   * PDF) this is lossy — use `raw` to write the bytes faithfully.
   */
  body: string;
  /** The raw response bytes, exactly as received. The source of truth for output. */
  raw: Buffer;
  /**
   * True when the response carries binary content (a screenshot or a PDF) that
   * must be written from `raw`, not `body`. False for text/HTML/JSON/error bodies.
   */
  isBinary: boolean;
  contentType: string;
  /** Cost in USD reported by X-Request-Cost, if present. */
  costUsd: number | null;
  /** Credits consumed, reported by X-Request-Credits, if present. */
  costCredits: number | null;
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

/** Perform a Fetch and Extract API request. Throws ToolkitError on failure. */
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
      headers: { "User-Agent": `zenrows-cli/${CLI_VERSION}`, "Accept-Encoding": "gzip, deflate" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const cause = err instanceof Error ? err.message : String(err);
    throw new ToolkitError({
      code: "BACKEND_UNAVAILABLE",
      message: `Could not reach the Zenrows API.`,
      likely_cause: `Network error or timeout: ${cause}`,
      next_action: "Check connectivity and retry. Verify api base in `zenrows config show`.",
      suggested_commands: ["zenrows status", "zenrows config show"],
    });
  }
  clearTimeout(timeout);

  // Read the raw bytes once. `body` (UTF-8) drives all error detection and text
  // output; `raw` preserves the exact bytes so binary responses (screenshot /
  // PDF) can be written without the UTF-8 round-trip that corrupts them.
  const raw = Buffer.from(await res.arrayBuffer());
  const body = raw.toString("utf8");
  // A binary body is only ever produced by a successful screenshot/PDF request.
  // Zenrows error responses are always a JSON envelope (text), so exclude those.
  const wantedBinary = params.screenshot === true || params.response_type === "pdf";
  const isBinary = wantedBinary && !isZenrowsErrorEnvelope(body);
  const result: ScraperResult = {
    status: res.status,
    body,
    raw,
    isBinary,
    contentType: res.headers.get("content-type") ?? "",
    costUsd: parseCost(res.headers.get("x-request-cost")),
    costCredits: numOrNull(res.headers.get("x-request-credits")),
    requestId: res.headers.get("x-request-id"),
    finalUrl: res.headers.get("zr-final-url"),
    concurrencyRemaining: numOrNull(res.headers.get("concurrency-remaining")),
    redactedUrl: redacted,
  };

  if (res.status === 401 || res.status === 403) {
    // Distinguish Zenrows auth errors from target-site 403s. Zenrows auth
    // failures surface AUTH00x codes in the body.
    if (/AUTH00\d|API key|apikey/i.test(body)) {
      const cause = `HTTP ${res.status}: ${zrErrorDetail(body) ?? snippet(body)}`;
      const acct = readAccount();
      if (acct?.unclaimed) {
        // The key was auto-provisioned by the toolkit — do NOT tell the user to
        // fetch a key from a dashboard they never used.
        throw new ToolkitError({
          code: "AUTH_INVALID",
          message: "The auto-provisioned Free plan key was rejected by the Zenrows API.",
          likely_cause: `${cause}. The signup endpoint issued this key, but the scraping API did not accept it.`,
          next_action:
            "If you are testing against a local/staging backend, ensure `apiBase` (zenrows config) points at the same environment that issued the key. Otherwise re-provision with `zenrows signup --agent`, or claim the account: " +
            acct.claimUrl,
          suggested_commands: ["zenrows status", "zenrows signup --agent"],
        });
      }
      const { source } = resolveApiKey();
      throw new ToolkitError({
        code: "AUTH_INVALID",
        message: "Zenrows rejected the API key.",
        likely_cause: cause,
        next_action:
          source === "env"
            ? `This key came from ${ENV_KEY} in your environment. Unset it (\`unset ${ENV_KEY}\`) or replace the value, then retry — or log in with a valid key.`
            : "Re-check your key in the Zenrows dashboard and log in again.",
        suggested_commands:
          source === "env"
            ? [`unset ${ENV_KEY}`, "zenrows login --api-key <your-key>", "zenrows signup --agent"]
            : ["zenrows login --api-key <your-key>"],
      });
    }
  }
  if (res.status === 402 && isZenrowsErrorEnvelope(body)) {
    // AUTH010 on extract=auto means the target domain is not in the Extract
    // beta — distinct from credit exhaustion (AUTH004). Let the extract
    // adapter fall back to autoparse.
    if (params.extract !== undefined && zrErrorCode(body) === "AUTH010") {
      throw new ToolkitError({
        code: "EXTRACT_DOMAIN_NOT_ENABLED",
        message: "Extract is not enabled for this domain yet.",
        likely_cause: zrErrorDetail(body) ?? "This domain is not part of the Extract open beta.",
        next_action:
          "Retry with --autoparse for general-purpose extraction on any site, or contact Zenrows support to enable this domain for Extract.",
        suggested_commands: [`zenrows extract ${params.url} --autoparse`],
      });
    }
    // Zenrows returns 402 with a JSON error envelope (e.g. AUTH004 "reached its
    // usage limit" / "Subscription has no credit available") when the account is
    // out of credits. This is NOT scraped content — surface it as a credits
    // error (claim link for an unclaimed Free plan, dashboard/upgrade otherwise).
    const acct = readAccount();
    throw quotaExhausted(redacted, acct?.unclaimed ? acct.claimUrl : undefined, {
      status: 402,
      detail: zrErrorDetail(body) ?? undefined,
    });
  }
  if (res.status === 429) {
    // A 429 is not always Free-plan credit exhaustion: it can also be a Zenrows
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
        ? `${detail}. This looks like a concurrency cap or a target-site rate limit, not Free-plan credit exhaustion.`
        : "A concurrency cap or a target-site rate limit was hit, not Free-plan credit exhaustion.",
      next_action: "Wait a few seconds and retry. If it persists, lower concurrency / parallel requests.",
      suggested_commands: [`zenrows fetch ${params.url}`],
    });
  }
  if (isForbiddenDomain(body)) {
    // REQS001 — Zenrows refuses this domain at the policy layer (returned as a
    // 4xx envelope). It's PERMANENT: js_render / premium_proxy / any retry will
    // fail identically, so say so rather than suggesting the generic retry.
    const detail = zrErrorDetail(body) ?? snippet(body);
    throw new ToolkitError({
      code: "DOMAIN_FORBIDDEN",
      message: "Zenrows does not allow scraping this domain.",
      likely_cause: `${detail}. This domain is blocked by Zenrows policy.`,
      next_action:
        "This is a permanent policy block, not a transient failure — the same request will fail again with any parameters (--js-render, --premium-proxy, …). Use a different source, or contact Zenrows if you believe this domain should be allowed.",
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
  // allowed_status_codes / original_status can legitimately return 4xx bodies
  // (the target's real page content). But Zenrows' OWN error responses also
  // carry a non-empty JSON body — those are errors, not content, and must fail
  // loudly rather than be reported as a successful fetch.
  if (isZenrowsErrorEnvelope(r.body)) return false;
  return r.body.length > 0;
}

/**
 * True when `body` is a Zenrows API error envelope (as opposed to scraped page
 * content). Zenrows errors carry a stable `code` (e.g. AUTH004, REQS002) and a
 * `type` pointing at the api-error-codes docs. A target site's returned body
 * (even a 4xx page) does not match this shape, so allowed_status_codes /
 * original_status content is preserved.
 */
/** True when `body` is a Zenrows REQS001 "domain forbidden" error. */
function isForbiddenDomain(body: string): boolean {
  try {
    const j = JSON.parse(body) as { code?: unknown };
    return typeof j.code === "string" && j.code.toUpperCase() === "REQS001";
  } catch {
    return false;
  }
}

function isZenrowsErrorEnvelope(body: string): boolean {
  try {
    const j = JSON.parse(body) as { code?: unknown; type?: unknown };
    if (typeof j.code === "string" && /^[A-Z]+\d+$/.test(j.code)) return true;
    if (typeof j.type === "string" && /docs\.zenrows\.com\/api-error-codes/.test(j.type)) return true;
    return false;
  } catch {
    return false;
  }
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

/** Human cost line for CLI success logs: `$0.0004 · 1 credit`. */
export function formatRequestCost(costUsd: number | null | undefined, costCredits: number | null | undefined): string {
  const usd = `$${((costUsd ?? 0)).toFixed(4)}`;
  if (costCredits == null) return `cost ${usd}`;
  const unit = costCredits === 1 ? "credit" : "credits";
  return `cost ${usd} · ${costCredits} ${unit}`;
}
function snippet(s: string): string {
  return s.slice(0, 240).replace(/\s+/g, " ").trim();
}

/**
 * Decide whether a 429 body indicates a Zenrows *account* credit/quota limit
 * (out of credits) rather than a concurrency cap or a target-site rate limit.
 * Only the former warrants the "claim / add credits" nudge; concurrency and
 * target 429s are handled generically.
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

/** Uppercased Zenrows error `code` from a JSON envelope, or null. */
export function zrErrorCode(body: string): string | null {
  try {
    const j = JSON.parse(body) as { code?: unknown };
    return typeof j.code === "string" ? j.code.toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * Clean one-line detail from a Zenrows JSON error body
 * (e.g. `(AUTH003) Invalid apikey provided`).
 */
export function zrErrorDetail(body: string): string | null {
  try {
    const j = JSON.parse(body) as { code?: string; title?: string; detail?: string };
    const label = j.title ?? j.detail;
    if (!label) return null;
    return j.code ? `(${j.code}) ${label}` : label;
  } catch {
    return null;
  }
}
