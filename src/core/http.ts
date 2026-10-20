/**
 * Minimal HTTP client for the Zenrows Fetch and Extract API (`/v1/`).
 *
 * Uses the global `fetch` (Node 18+). The API key is sent as the `apikey`
 * query parameter (per docs) and is registered as a secret so it is redacted
 * from any logged URL.
 */
import { ToolkitError, isKeyCapReached, keyCapReached, quotaExhausted } from "./errors.ts";
import { storedClaimHint, usableClaimUrl } from "./claim-link.ts";
import { readAccount } from "./agent-account.ts";
import { ENV_KEY, resolveApiKey } from "./auth.ts";
import { log, registerSecret } from "./logger.ts";
import { CLI_USER_AGENT } from "./config.ts";
import { agentClientHeader } from "./agent-client.ts";
import { defaultSleep, fullJitterMs, retryAfterDelayMs, retryAfterMs } from "./backoff.ts";
import { normalizeDomain, PAGE_NOT_RECOGNISED_STEPS, prepareCommand } from "./prepared-domains-api.ts";

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
  /** HTTP requests sent for this call, the first one included (1 means no retry). */
  attempts?: number;
}

export interface ScraperParams {
  url: string;
  [param: string]: string | number | boolean | undefined;
}

/**
 * Client-side timeout for one Fetch and Extract HTTP attempt.
 *
 * It sits above the API's own budget (`SERVER_BUDGET_MS`, 180 s), as the public
 * docs advise, so the API normally answers with its own error before the CLI
 * gives up. Giving up earlier would abandon a request the API keeps working on
 * and may still charge, while it holds a concurrency slot. A timeout is still
 * never retried, for the same reason.
 */
export const DEFAULT_TIMEOUT_MS = 200_000;

/** The API's budget for the whole request: auth, fetch and parse. */
export const SERVER_BUDGET_MS = 180_000;

/** Retries for a retryable failure (`--retries`). 0 sends the request once. */
export const DEFAULT_RETRIES = 2;

/** No retry starts when the time already spent plus its delay would pass this. */
export const RETRY_BUDGET_MS = 90_000;

/**
 * Statuses that can succeed on the next attempt. Zenrows charges only
 * successful answers, so none of these is charged.
 */
const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * `error.cause.code` values that mean the request was never written to the
 * API: the connection was refused, the name did not resolve, the connect timed
 * out or the network was unreachable. Only these network errors are retried,
 * plus an `ETIMEDOUT` whose `syscall` is `connect` (see `neverSentCause`).
 * A reset or close after the request was sent (`UND_ERR_SOCKET`, `ECONNRESET`)
 * is not: the API may still be working on it and may charge it.
 */
const NEVER_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

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
  /**
   * The command the user ran, ready to paste. Errors that say "run the same
   * command again" suggest it. Unset means `zenrows fetch|extract <url>`.
   */
  rerunCommand?: string;
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
 * Retries 429, 502, 503 and 504, and network errors that happened before the
 * request was written, up to `retries` times, with full jitter or the server's
 * Retry-After. No retry starts after `RETRY_BUDGET_MS` from the first request. Our own timeout is never retried, and neither is any other
 * status or a status that belongs to the target site (`original_status`,
 * `allowed_status_codes`).
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
    const sent = await sendOnce(full, params.url, opts);
    if (!sent.ok) {
      // A timeout, or a failure after the request was written, is not retried:
      // the API may still be working on it and may charge it.
      if (n >= retries || !sent.neverSent) throw sent.error;
      const delayMs = fullJitterMs(n, opts.randomImpl);
      if (now() - startedAt + delayMs > RETRY_BUDGET_MS) throw sent.error;
      log.dim(`Network error before the request was sent; retry ${n + 1}/${retries} in ${formatMs(delayMs)}`);
      await sleep(delayMs);
      continue;
    }
    const body = sent.raw.toString("utf8");
    if (n < retries && isRetryable(sent.res.status, params)) {
      const delayMs = retryAfterDelayMs(sent.res.headers.get("retry-after")) ?? fullJitterMs(n, opts.randomImpl);
      if (now() - startedAt + delayMs <= RETRY_BUDGET_MS) {
        const code = zrErrorCode(body);
        log.dim(`HTTP ${sent.res.status}${code ? ` ${code}` : ""}; retry ${n + 1}/${retries} in ${formatMs(delayMs)}`);
        await sleep(delayMs);
        continue;
      }
    }
    return interpret(sent.res, sent.raw, params, redacted, {
      retriesUsed: n,
      attempts: n + 1,
      rerunCommand: opts.rerunCommand ?? defaultRerunCommand(params),
    });
  }
}

/**
 * True for a status worth another attempt. Not retried: any status the target
 * site sent. The out-of-credits codes (`AUTH004`, `AUTH014`) arrive as a 402,
 * which is not a retried status, so they need no rule here.
 */
function isRetryable(status: number, params: ScraperParams): boolean {
  return RETRY_STATUSES.has(status) && !isTargetStatus(status, params);
}

/**
 * True when `status` may be the target site's own answer, passed through by
 * `original_status` or `allowed_status_codes`. Retrying it would hit the
 * target again, and the API may charge a request that reached the target.
 */
function isTargetStatus(status: number, params: ScraperParams): boolean {
  if (params.original_status === true || params.original_status === "true") return true;
  const allowed = params.allowed_status_codes;
  if (allowed === undefined || allowed === false) return false;
  return String(allowed)
    .split(",")
    .some((code) => code.trim() === String(status));
}

/**
 * True when a fetch() rejection means the request never reached the API.
 * undici wraps every failure as `TypeError("fetch failed")` with the real
 * error in `cause`. A connect to a host with several addresses (happy
 * eyeballs) fails as an AggregateError with one error per address; it counts
 * only when every one of them is a connect failure.
 */
export function failedBeforeSend(err: unknown): boolean {
  return neverSentCause(err instanceof Error ? err.cause : undefined);
}

function neverSentCause(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  // Node copies the first inner error's `code` onto the AggregateError, so
  // the inner errors decide, never that copied code.
  const errors = (cause as { errors?: unknown }).errors;
  if (Array.isArray(errors)) return errors.length > 0 && errors.every(neverSentCause);
  const { code, syscall } = cause as { code?: unknown; syscall?: unknown };
  // The OS connect timeout. ETIMEDOUT on a read is after the request was sent.
  if (code === "ETIMEDOUT") return syscall === "connect";
  return typeof code === "string" && NEVER_SENT_CODES.has(code);
}

/** Shell-safe form of one argument for a suggested command. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** `zenrows fetch|extract <url>` for a caller that did not pass the command it ran. */
function defaultRerunCommand(params: ScraperParams): string {
  const isExtract =
    params.extract !== undefined || params.autoparse !== undefined || params.css_extractor !== undefined || params.outputs !== undefined;
  return `zenrows ${isExtract ? "extract" : "fetch"} ${shellQuote(params.url)}`;
}

type SendResult =
  | { ok: true; res: Response; raw: Buffer }
  | { ok: false; error: ToolkitError; neverSent: boolean };

/**
 * One HTTP attempt. Its timeout covers only the wait for the response
 * headers: the timer is cleared before the body is read, so reading the body
 * has no timeout, and a failure while reading it rejects with the raw error
 * (for example a TypeError), not a ToolkitError.
 */
async function sendOnce(full: string, targetUrl: string, opts: ScrapeOptions): Promise<SendResult> {
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
    if (timedOut) return { ok: false, error: requestTimeout(targetUrl, timeoutMs, elapsedMs), neverSent: false };
    const cause = err instanceof Error ? err.message : String(err);
    const causeCode = err instanceof Error ? (err.cause as { code?: unknown } | undefined)?.code : undefined;
    return {
      ok: false,
      neverSent: failedBeforeSend(err),
      error: new ToolkitError({
        code: "BACKEND_UNAVAILABLE",
        message: `Could not reach the Zenrows API.`,
        likely_cause: `Network error after ${formatMs(elapsedMs)}: ${cause}${typeof causeCode === "string" ? ` (${causeCode})` : ""}`,
        next_action: "Check connectivity and retry. Verify api base in `zenrows config show`.",
        suggested_commands: ["zenrows status", "zenrows config show"],
      }),
    };
  }
  clearTimeout(timeout);

  // Read the raw bytes once. `body` (UTF-8) drives all error detection and text
  // output; `raw` preserves the exact bytes so binary responses (screenshot /
  // PDF) can be written without the UTF-8 round-trip that corrupts them.
  const raw = Buffer.from(await res.arrayBuffer());
  return { ok: true, res, raw };
}

/** What `interpret` needs to know about the attempts behind a final response. */
interface AttemptContext {
  /** Retries this request made before the final response. */
  retriesUsed: number;
  /** Requests sent for this call (see `ScraperResult.attempts`). */
  attempts: number;
  /** The command to suggest when the advice is "run the same command again". */
  rerunCommand: string;
}

/** Turn one final response into a result, or a normalized error. */
function interpret(
  res: Response,
  raw: Buffer,
  params: ScraperParams,
  redacted: string,
  attempt: AttemptContext,
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
    attempts: attempt.attempts,
  };

  // REQS007 on extract=auto: Extract has not prepared the domain yet. Reported,
  // never retried: the fix is to prepare the domain, which the error names.
  if (res.status === 403 && params.extract !== undefined && zrErrorCode(body) === "REQS007") {
    throw extractDomainNotPrepared(params.url, body);
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
            (usableClaimUrl(acct) ?? "run `zenrows account claim` for a link"),
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
    // AUTH010 on extract=auto is the legacy code for REQS007: the domain is
    // not prepared for Extract. Distinct from credit exhaustion (AUTH004).
    if (params.extract !== undefined && zrErrorCode(body) === "AUTH010") {
      throw extractDomainNotPrepared(params.url, body);
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
    throw quotaExhausted(redacted, storedClaimHint(acct), {
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
      throw quotaExhausted(redacted, storedClaimHint(acct));
    }
    const detail = zrErrorDetail(body) ?? snippet(body);
    throw new ToolkitError({
      code: "FETCH_FAILED",
      message: `Rate limited (HTTP 429${triedText(attempt.retriesUsed)}).`,
      likely_cause: detail
        ? `${detail}. This looks like a concurrency cap or a target-site rate limit, not Free-plan credit exhaustion.`
        : "A concurrency cap or a target-site rate limit was hit, not Free-plan credit exhaustion.",
      next_action: "Wait a few seconds and retry. If it persists, lower concurrency / parallel requests.",
      suggested_commands: [attempt.rerunCommand],
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
  if (res.status === 503 && zrErrorCode(body) === "RESP009") throw serviceBusy(params, body, res.headers.get("retry-after"), attempt);
  if (RETRY_STATUSES.has(res.status) && !isTargetStatus(res.status, params)) {
    // A temporary answer from the API side that outlasted the retries. A
    // stronger (and up to 25x dearer) fetch configuration does not fix it.
    throw new ToolkitError({
      code: "FETCH_FAILED",
      message: `The Zenrows API answered HTTP ${res.status}${triedText(attempt.retriesUsed)}. It was not charged.`,
      likely_cause: `${snippet(body) || `HTTP ${res.status}`}. The Zenrows API gave a temporary answer, and the CLI already retried it.`,
      next_action:
        "Wait a minute, then run the same command again. Do not add --js-render or --premium-proxy: they cost more and do not help here.",
      suggested_commands: [attempt.rerunCommand],
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

/** ` after 2 retries`, or nothing when the request was sent once. */
function triedText(retriesUsed: number): string {
  return retriesUsed > 0 ? ` after ${retriesUsed} ${retriesUsed === 1 ? "retry" : "retries"}` : "";
}

/**
 * 503 RESP009: Zenrows could not take this request now. It is temporary and
 * not charged, so the fix is to wait and send the same command, not to
 * escalate to --js-render / --premium-proxy (which costs more and helps nothing).
 *
 * On Extract the docs give RESP009 two meanings, and the answer's `title` says
 * which: Extract could not finish this page right now (retry in a minute), or
 * Extract is at capacity for pages it has not seen before (retry later). The
 * cause therefore quotes the API's own words instead of guessing.
 */
function serviceBusy(params: ScraperParams, body: string, retryAfter: string | null, attempt: AttemptContext): ToolkitError {
  const isExtract = params.extract !== undefined;
  const said = zrErrorTitleAndDetail(body);
  const waitSeconds = retryAfterMs(retryAfter);
  const cause = said
    ? `The API said: ${said}`
    : isExtract
      ? "Extract could not take this request now: either it could not finish this page yet, or it is at capacity for pages it has not seen before."
      : "Zenrows scraping capacity is busy right now.";
  const when =
    waitSeconds !== undefined
      ? `Wait at least ${waitSeconds / 1000} s (the API's Retry-After)`
      : isExtract
        ? "Wait: about a minute if the API says it could not finish this page, longer if it says it is at capacity for new pages"
        : "Wait a short time";
  return new ToolkitError({
    code: "SERVICE_BUSY",
    message: `Zenrows could not take this request yet (HTTP 503 RESP009${triedText(attempt.retriesUsed)}). It was not charged.`,
    likely_cause: `${cause.replace(/\.\s*$/, "")}. The request was not charged.`,
    next_action: `${when}, then run the same command again. Do not add --js-render or --premium-proxy: they cost more and do not help here.`,
    suggested_commands: [attempt.rerunCommand],
    server_code: "RESP009",
    retry_after: waitSeconds !== undefined ? waitSeconds / 1000 : undefined,
  });
}

/** Why a REQS007 refused, as the gateway's `reason` field names it. */
export type RefusalReason = "domain_not_prepared" | "page_not_recognised" | "domain_not_enabled";

const REFUSAL_REASONS: readonly string[] = ["domain_not_prepared", "page_not_recognised", "domain_not_enabled"];

/**
 * Which REQS007 this is. Only domain_not_prepared is fixed by preparing the
 * domain: on page_not_recognised the domain is already prepared, and
 * resubmitting it returns the existing ready record, so pointing there would
 * loop.
 *
 * The gateway says it in the problem's `reason` field, read first. The sentence
 * match below is only the fallback for a gateway deployed before that field
 * existed, and reads the titles that gateway sends; remove it once every gateway
 * sends `reason`.
 */
export function refusalReason(body: string): RefusalReason {
  let j: { reason?: unknown; title?: unknown; detail?: unknown };
  try {
    j = JSON.parse(body) as typeof j;
  } catch {
    return "domain_not_prepared";
  }
  if (typeof j.reason === "string" && REFUSAL_REASONS.includes(j.reason)) return j.reason as RefusalReason;
  const title = typeof j.title === "string" ? j.title : "";
  const detail = typeof j.detail === "string" ? j.detail : "";
  if (/did not recogni[sz]e this page/i.test(title) || /^Extract serves /.test(detail)) return "page_not_recognised";
  if (/^Extract is not enabled/i.test(title)) return "domain_not_enabled";
  return "domain_not_prepared";
}

/**
 * REQS007 (or the legacy AUTH010) on extract=auto. Each reason names its own
 * next step, because agents copy it: the exact prepare command for a domain not
 * prepared yet, the gateway's advice in the gateway's order for a page it did not
 * recognise. None offers Autoparse.
 */
export function extractDomainNotPrepared(url: string, body: string): ToolkitError {
  const domain = normalizeDomain(url);
  const detail = zrErrorDetail(body);
  const css = `zenrows extract ${url} --css '{"title":"h1"}'`;
  const reason = refusalReason(body);
  if (reason === "page_not_recognised") {
    return new ToolkitError({
      code: "EXTRACT_PAGE_NOT_RECOGNISED",
      message: `Extract serves ${domain} but did not recognise this page as one it can extract (it may be a page with nothing to extract, such as a home page). ${PAGE_NOT_RECOGNISED_STEPS} The request was not charged.`,
      likely_cause: detail ?? `Extract serves ${domain} but did not recognise this page.`,
      next_action: PAGE_NOT_RECOGNISED_STEPS,
      suggested_commands: [css],
      server_code: "REQS007",
    });
  }
  if (reason === "domain_not_enabled") {
    return new ToolkitError({
      code: "EXTRACT_DOMAIN_NOT_ENABLED",
      message: `Extract is not enabled for ${domain}, and preparing it does not change this.`,
      likely_cause: detail ?? `Extract is not enabled for ${domain}.`,
      next_action: "Extract this page with --css and explicit selectors, or contact Zenrows support to have the site enabled.",
      suggested_commands: [css],
      server_code: "REQS007",
    });
  }
  const prepare = prepareCommand(url);
  return new ToolkitError({
    code: "EXTRACT_DOMAIN_NOT_PREPARED",
    message: `Extract hasn't prepared ${domain} yet. Prepare it with \`${prepare}\` (a few example URLs, a few minutes, no credits), then retry; meanwhile use --css.`,
    likely_cause: detail ?? `Extract has not prepared ${domain} yet.`,
    next_action: `Run \`${prepare} --wait\` (up to 5 --url pages, one per page kind you want), then retry \`zenrows extract ${url}\`. Without --wait, check progress about every 30 seconds with \`zenrows extract prepare status ${domain}\`. Meanwhile extract with --css and explicit selectors.`,
    suggested_commands: [`${prepare} --wait`, `zenrows extract prepare status ${domain}`, css],
    server_code: "REQS007",
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

/** `(CODE) title: detail` from a problem body, or null when it has neither. */
function zrErrorTitleAndDetail(body: string): string | null {
  try {
    const j = JSON.parse(body) as { code?: unknown; title?: unknown; detail?: unknown };
    const parts = [j.title, j.detail].filter((v): v is string => typeof v === "string" && v.trim() !== "");
    if (parts.length === 0) return null;
    const text = parts.map((v) => v.trim().replace(/\.$/, "")).join(": ");
    return typeof j.code === "string" && !text.includes(j.code) ? `(${j.code}) ${text}` : text;
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
