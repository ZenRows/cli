/**
 * Minimal HTTP client for the Zenrows Fetch and Extract API (`/v1/`).
 *
 * Uses the global `fetch` (Node 18+). The API key is sent as the `apikey`
 * query parameter (per docs) and is registered as a secret so it is redacted
 * from any logged URL.
 */
import { ToolkitError, isKeyCapReached, keyCapReached, quotaExhausted } from "./errors.ts";
import { readAccount } from "./agent-account.ts";
import { ENV_KEY, resolveApiKey } from "./auth.ts";
import { log, registerSecret } from "./logger.ts";
import { CLI_USER_AGENT } from "./config.ts";
import { agentClientHeader } from "./agent-client.ts";
import { defaultSleep, fullJitterMs, retryAfterMs } from "./backoff.ts";

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
  /**
   * True when an Extract request answered 422 with code `no_data_extracted`:
   * Extract knows this kind of page but none of the fields came back filled.
   * The request is not charged, and the same request returns the same answer.
   */
  noDataExtracted?: boolean;
}

export interface ScraperParams {
  url: string;
  [param: string]: string | number | boolean | undefined;
}

/**
 * Client-side timeout for one Fetch and Extract HTTP attempt.
 *
 * It was raised from 90s when the gateway's budget was believed to be 90s, so
 * that our abort would not race the API's own error envelope. The gateway's
 * real budget is `SERVER_BUDGET_MS` (180s), so a request that runs longer than
 * this can still be aborted while the API is working on it. That is why a
 * timeout is never retried: the API keeps running and may still charge a 200.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** The gateway's budget for the whole request: auth, fetch and parse. */
export const SERVER_BUDGET_MS = 180_000;

/** Retries for a retryable failure (`--retries`). 0 sends the request once. */
export const DEFAULT_RETRIES = 2;

/** No retry starts when the time already spent plus its delay would pass this. */
export const RETRY_BUDGET_MS = 90_000;

/**
 * Statuses that can succeed on the next attempt. The gateway charges only
 * 2xx, 304, 404 and 410, so none of these is charged.
 */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export interface ScrapeOptions {
  /** Per HTTP attempt. */
  timeoutMs?: number;
  projectRoot?: string;
  /** Retries after the first attempt; defaults to `DEFAULT_RETRIES`. */
  retries?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Clock for the retry budget. */
  nowImpl?: () => number;
  /** Source of the jitter. */
  randomImpl?: () => number;
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

/**
 * Perform a Fetch and Extract API request. Throws ToolkitError on failure.
 *
 * Retries 429, 502, 503 and 504 and network errors that came before any
 * response, up to `retries` times, with full jitter or the server's
 * Retry-After. A retry never starts past `RETRY_BUDGET_MS`. Our own timeout is
 * never retried, and neither is any other status.
 */
export async function scrape(
  apiBase: string,
  apiKey: string,
  params: ScraperParams,
  opts: ScrapeOptions = {},
): Promise<ScraperResult> {
  registerSecret(apiKey);
  const { full, redacted } = buildUrl(apiBase, apiKey, params);
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const now = opts.nowImpl ?? Date.now;
  const startedAt = now();

  for (let n = 0; ; n++) {
    let sent: { res: Response; raw: Buffer };
    try {
      sent = await sendOnce(full, params.url, opts);
    } catch (err) {
      // REQUEST_TIMEOUT is not retried: the API keeps working and may still charge.
      if (n >= retries || !(err instanceof ToolkitError) || err.code !== "BACKEND_UNAVAILABLE") throw err;
      const delayMs = fullJitterMs(n, opts.randomImpl);
      if (now() - startedAt + delayMs > RETRY_BUDGET_MS) throw err;
      log.dim(`Network error; retry ${n + 1}/${retries} in ${formatMs(delayMs)}`);
      await sleep(delayMs);
      continue;
    }
    const body = sent.raw.toString("utf8");
    if (n < retries && isRetryable(sent.res.status, body)) {
      const delayMs = retryAfterMs(sent.res.headers.get("retry-after")) ?? fullJitterMs(n, opts.randomImpl);
      if (now() - startedAt + delayMs <= RETRY_BUDGET_MS) {
        const code = zrErrorCode(body);
        log.dim(`HTTP ${sent.res.status}${code ? ` ${code}` : ""}; retry ${n + 1}/${retries} in ${formatMs(delayMs)}`);
        await sleep(delayMs);
        continue;
      }
    }
    return interpret(sent.res, sent.raw, params, redacted, n);
  }
}

/**
 * True for a status worth another attempt. A 429 that says the account is out
 * of credits is excluded: it answers the same until the account changes.
 */
function isRetryable(status: number, body: string): boolean {
  if (!RETRY_STATUSES.has(status)) return false;
  return !(status === 429 && isQuotaError(body));
}

/** One HTTP attempt with its own timeout; the body is read inside it. */
async function sendOnce(
  full: string,
  targetUrl: string,
  opts: ScrapeOptions,
): Promise<{ res: Response; raw: Buffer }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  // Our own timer is the only thing that aborts this controller, so this flag —
  // not `err.name === "AbortError"` — is what tells a client-side give-up apart
  // from a genuine transport failure. The two must never share an error code.
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(full, {
      method: "GET",
      headers: { "User-Agent": CLI_USER_AGENT, "Accept-Encoding": "gzip, deflate", ...agentClientHeader({ projectRoot: opts.projectRoot }) },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const elapsedMs = Date.now() - startedAt;
    if (timedOut) throw requestTimeout(targetUrl, timeoutMs, elapsedMs);
    const cause = err instanceof Error ? err.message : String(err);
    throw new ToolkitError({
      code: "BACKEND_UNAVAILABLE",
      message: `Could not reach the Zenrows API.`,
      likely_cause: `Network error after ${formatMs(elapsedMs)}: ${cause}`,
      next_action: "Check connectivity and retry. Verify api base in `zenrows config show`.",
      suggested_commands: ["zenrows status", "zenrows config show"],
    });
  }
  clearTimeout(timeout);

  // Read the raw bytes once. `body` (UTF-8) drives all error detection and text
  // output; `raw` preserves the exact bytes so binary responses (screenshot /
  // PDF) can be written without the UTF-8 round-trip that corrupts them.
  const raw = Buffer.from(await res.arrayBuffer());
  return { res, raw };
}

/** Turn one final response into a result, or a normalized error. */
function interpret(
  res: Response,
  raw: Buffer,
  params: ScraperParams,
  redacted: string,
  retriesUsed: number,
): ScraperResult {
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

  // REQS007 on extract=auto: the domain hasn't been prepared for Extract yet.
  // Same recovery as AUTH010 (the extract adapter falls back to autoparse), so it
  // maps to the same code. Checked before the 403 auth branch below.
  if (res.status === 403 && params.extract !== undefined && zrErrorCode(body) === "REQS007") {
    throw new ToolkitError({
      code: "EXTRACT_DOMAIN_NOT_ENABLED",
      message: "Extract has not been prepared for this domain yet.",
      likely_cause: zrErrorDetail(body) ?? "This domain is not prepared for Extract.",
      next_action:
        "Retry with --autoparse for general-purpose extraction on any site, or get the domain prepared for Extract (POST /v1/extract/prepared-domains).",
      suggested_commands: [`zenrows extract ${params.url} --autoparse`],
    });
  }
  // 422 no_data_extracted on an Extract request: the page was processed and had
  // nothing to extract. It is an answer, not a failure to reach the target, so
  // return it for the extract adapter to report as an empty result instead of
  // advising escalation (which would repeat a slow, deterministic request).
  if (res.status === 422 && params.extract !== undefined && zrErrorCode(body) === "NO_DATA_EXTRACTED") {
    return { ...result, noDataExtracted: true };
  }
  // 422 blocked_document on an Extract request: the fetched page was a bot wall,
  // an error page or an empty shell, so Extract had nothing real to read. Not
  // charged. The fix is a stronger fetch of the same URL, not another extractor.
  if (res.status === 422 && params.extract !== undefined && zrErrorCode(body) === "BLOCKED_DOCUMENT") {
    throw new ToolkitError({
      code: "EXTRACT_FAILED",
      message: "Extract could not read this page: the site answered with a block or error page (HTTP 422 blocked_document, not charged).",
      likely_cause: zrErrorDetail(body) ?? "The fetched page was a bot challenge, an error page or a page that had not finished loading.",
      next_action:
        "Retry with a stronger fetch: --manual --js-render --premium-proxy. Check the URL if the site may be returning an error page.",
      suggested_commands: [`zenrows extract ${params.url} --manual --js-render --premium-proxy`],
    });
  }
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
    // AUTH010 on extract=auto means the target domain is not enabled for
    // Extract, distinct from credit exhaustion (AUTH004). Let the extract
    // adapter fall back to autoparse.
    if (params.extract !== undefined && zrErrorCode(body) === "AUTH010") {
      throw new ToolkitError({
        code: "EXTRACT_DOMAIN_NOT_ENABLED",
        message: "Extract is not enabled for this domain yet.",
        likely_cause: zrErrorDetail(body) ?? "This domain is not enabled for Extract.",
        next_action:
          "Retry with --autoparse for general-purpose extraction on any site, or get the domain prepared for Extract (POST /v1/extract/prepared-domains).",
        suggested_commands: [`zenrows extract ${params.url} --autoparse`],
      });
    }
    // AUTH014: this key hit one of its credit caps; the account still has credits.
    if (isKeyCapReached(zrErrorCode(body) ?? undefined)) {
      // `detail` names the cap and its reset date; the title alone says neither.
      throw keyCapReached(redacted, { status: 402, detail: zrErrorProblemDetail(body) ?? zrErrorDetail(body) ?? undefined });
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
  const unrecoverable = unrecoverableTargetCode(body);
  if (unrecoverable) {
    // The target itself does not resolve (RESP007) or does not exist (RESP002, 404).
    // No fetch configuration can change that, so we must NOT advise a retry — a
    // retry fails identically and still costs credits. (A human is free to try a
    // corrected URL; we just don't hand an agent an escalation command here.)
    const detail = zrErrorDetail(body) ?? snippet(body);
    const noResolve = unrecoverable === "RESP007";
    throw new ToolkitError({
      code: "FETCH_FAILED",
      message: noResolve
        ? "The target domain could not be resolved."
        : "The target returned 404 Not Found.",
      likely_cause: `${detail}. This is a property of the target, not a transient block.`,
      next_action: noResolve
        ? "Check the URL for typos. No configuration (--js-render, --premium-proxy) can reach a host with no DNS record — do not retry; it will fail identically and still cost credits."
        : "Verify the URL. Rendering or premium proxies will not turn a 404 into content — do not retry; it will fail identically and still cost credits.",
    });
  }
  if (res.status === 503 && zrErrorCode(body) === "RESP009") throw serviceBusy(params, body, res.headers.get("retry-after"), retriesUsed);
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

/**
 * 503 RESP009: Zenrows had no capacity for this request yet. It is temporary
 * and not charged, so the fix is to wait and send the same request, not to
 * escalate to --js-render / --premium-proxy (which costs more and helps nothing).
 */
function serviceBusy(params: ScraperParams, body: string, retryAfter: string | null, retriesUsed: number): ToolkitError {
  const isExtract = params.extract !== undefined;
  const command = `zenrows ${isExtract ? "extract" : "fetch"} ${params.url}`;
  const detail = zrErrorDetail(body);
  const tried = retriesUsed > 0 ? ` after ${retriesUsed} ${retriesUsed === 1 ? "retry" : "retries"}` : "";
  const waitSeconds = retryAfterMs(retryAfter);
  return new ToolkitError({
    code: "SERVICE_BUSY",
    message: `Zenrows could not take this request yet (HTTP 503 RESP009${tried}). It was not charged.`,
    likely_cause:
      (isExtract
        ? "The extraction service is still preparing this layout; the request was not charged."
        : "Zenrows scraping capacity is busy right now; the request was not charged.") +
      (detail ? ` Server said: ${detail}.` : ""),
    next_action:
      "Retry the same command shortly (in about a minute). Do not add --js-render or --premium-proxy: they cost more and do not help here.",
    suggested_commands: [command],
    server_code: "RESP009",
    retry_after: waitSeconds !== undefined ? waitSeconds / 1000 : undefined,
  });
}

/**
 * The CLI gave up waiting before the API answered. This is NOT unreachability:
 * the connection was established and the gateway was still working, so telling
 * the operator to check connectivity would send them at the wrong problem. The
 * elapsed time is included so the server budget is visible in the output.
 */
export function requestTimeout(url: string, timeoutMs: number, elapsedMs: number): ToolkitError {
  const suggestedMs = Math.max(timeoutMs + 60_000, SERVER_BUDGET_MS + 60_000);
  const atBudget = elapsedMs >= SERVER_BUDGET_MS;
  return new ToolkitError({
    code: "REQUEST_TIMEOUT",
    message: `The CLI stopped waiting after ${formatMs(timeoutMs)}. The Zenrows API did not respond in time.`,
    likely_cause:
      `The request was aborted client-side after ${formatMs(elapsedMs)}. The API was reached — this is not a ` +
      (atBudget
        ? `connectivity problem. The request also passed the API's own ${formatMs(SERVER_BUDGET_MS)} budget, so the target is very likely rendering slowly or a wait condition never matched.`
        : `connectivity problem, and the API's own ${formatMs(SERVER_BUDGET_MS)} budget had not run out yet, so the API may still finish this request and charge it.`),
    next_action:
      `Retry with a longer client timeout (\`--timeout ${suggestedMs}\`). If the target needs a long render, drop ` +
      "`--wait-for` so the request finishes inside the API's budget and the API can return its own error instead.",
    suggested_commands: [`zenrows fetch ${url} --timeout ${suggestedMs}`],
  });
}

/** `89677` → `89.7s`; `120004` → `120s`. One decimal, and never a bare `.0`. */
function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
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

/**
 * Codes where the target is unreachable/nonexistent — RESP007 (domain does not
 * resolve) and RESP002 (target 404). Permanent: no proxy/render setting fixes
 * them, so the caller must not advise a (billed) retry.
 */
function unrecoverableTargetCode(body: string): "RESP007" | "RESP002" | null {
  try {
    const j = JSON.parse(body) as { code?: unknown };
    const code = typeof j.code === "string" ? j.code.toUpperCase() : "";
    return code === "RESP007" || code === "RESP002" ? code : null;
  } catch {
    return null;
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

/** The problem body's `detail` field alone, prefixed with its code. */
function zrErrorProblemDetail(body: string): string | null {
  try {
    const j = JSON.parse(body) as { code?: string; detail?: string };
    if (!j.detail) return null;
    return j.code ? `(${j.code}) ${j.detail}` : j.detail;
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
