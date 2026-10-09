/**
 * Client for the Zenrows Crawl API.
 *
 * Crawl lives on the same host as Fetch and Extract (`https://api.zenrows.com/v1`)
 * under `/crawls`. Auth is the `X-API-Key` header, never the `apikey` query
 * param: Crawl answers any query parameter it does not know with 400. Bodies are
 * JSON; errors come back as `application/problem+json` (RFC 9457) and we branch
 * on `status` + `code` only. A crawl is an async job: create it, then poll it
 * until its status leaves `running`. Calls retry transient failures the way the
 * Crawl SDKs do (see `retryStatuses`). `fetchImpl` / `sleepImpl` are injectable
 * for tests.
 *
 * `output_format` takes `html` only (absent = URLs only). Response fields we do
 * not model pass through untouched.
 */
import { ToolkitError, isKeyCapReached, keyCapReached, quotaExhausted } from "./errors.ts";
import { readAccount } from "./agent-account.ts";
import { registerSecret } from "./logger.ts";
import { CLI_USER_AGENT, loadConfig } from "./config.ts";
import { agentClientHeader } from "./agent-client.ts";

/** Production Crawl API base (no trailing slash): the Fetch/Extract host. */
export const DEFAULT_CRAWL_API_BASE = "https://api.zenrows.com/v1";
/** Env var to override the Crawl API base (local/staging testing). */
export const CRAWL_API_BASE_ENV = "ZENROWS_CRAWL_API_BASE";

/**
 * Resolve the Crawl API base, trimmed of trailing `/`. `ZENROWS_CRAWL_API_BASE`
 * wins; otherwise Crawl follows the Fetch/Extract `apiBase` (config or
 * `ZENROWS_API_BASE`), since both live on the same API host.
 */
export function crawlBase(): string {
  const env = process.env[CRAWL_API_BASE_ENV];
  const base = env && env.trim() ? env.trim() : loadConfig().apiBase || DEFAULT_CRAWL_API_BASE;
  return base.replace(/\/+$/, "");
}

export interface CrawlCoverage {
  pages_fetched: number;
  pages_failed: number;
  items_found: number;
}

/** Why a crawl ended `failed` (part of the crawl, not an error response). */
export interface CrawlRunError {
  code: string;
  detail: string;
}

/** One crawl. Enum fields are extensible: expect values not listed here. */
export interface Crawl {
  crawl_id: string;
  /** running | completed | stopped | failed. Terminal = anything but `running`. */
  status: string;
  url: string;
  depth: number;
  max_items: number;
  max_pages: number;
  coverage: CrawlCoverage;
  created_at: string;
  /** max_items | max_pages | user. Absent when nothing was left to open. */
  stop_reason?: string;
  error?: CrawlRunError;
  include_patterns?: string[];
  exclude_patterns?: string[];
  output_format?: string;
  duplicates_removed?: number;
  finished_at?: string;
  [k: string]: unknown;
}

/** One URL the crawl kept. */
export interface CrawlResult {
  url: string;
  /** pending | fetched | failed — only when the crawl has an output format. */
  content_status?: string;
  /** e.g. `/v1/crawls/c_x/contents/ct_y`, present once fetched. */
  content_url?: string;
  [k: string]: unknown;
}

/** `GET /crawls/{id}`: the crawl plus one page of results. */
export interface CrawlWithResults extends Crawl {
  results: CrawlResult[];
  /** Never null while the crawl runs; null once it ended and this page is the last. */
  next_cursor: string | null;
}

export interface CrawlList {
  crawls: Crawl[];
  /** Absent on the last page. */
  next_cursor?: string;
}

/** `POST /crawls/{id}/stop`: where the crawl stands, without counts. */
export interface CrawlStop {
  crawl_id: string;
  status: string;
  stop_reason?: string;
  error?: CrawlRunError;
  finished_at?: string;
  [k: string]: unknown;
}

/** Create body. Only the fields the caller set are sent. */
export interface CreateCrawlParams {
  url: string;
  depth: number;
  max_items?: number;
  max_pages?: number;
  include_patterns?: string[];
  exclude_patterns?: string[];
  /** `html` returns each kept URL's page; absent = URLs only. */
  output_format?: "html";
}

/** RFC 9457 problem body. */
interface ProblemJson {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
}

/** The API's "Crawl is not enabled for this account" code (403). */
export const CRAWL_NOT_ENABLED_CODE = "REQS008";

/** A crawl stops progressing once its status is anything but `running`. */
export function isTerminal(status: string | undefined): boolean {
  return !!status && status !== "running";
}

interface CallOpts {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Per HTTP attempt. */
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface RequestOpts extends CallOpts {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  accept?: string;
  /** Set on every call about one crawl, so its errors carry `crawl_id`. */
  crawlId?: string;
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

const MAX_RETRIES = 3;
const READ_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
// 429 on create is the active-job limit: a retry only waits for a slot that may never free.
const CREATE_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * The statuses to retry, or undefined when the request must run once: a GET is
 * safe to repeat, a create only with an Idempotency-Key, and stop never.
 */
function retryStatuses(method: string, headers: Record<string, string>): ReadonlySet<number> | undefined {
  if (method === "GET") return READ_RETRY_STATUSES;
  return headers["Idempotency-Key"] ? CREATE_RETRY_STATUSES : undefined;
}

/** 250 ms x 2^attempt, capped at 10 s, +/-20% jitter. */
function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 10_000) * (0.8 + Math.random() * 0.4);
}

/** `Retry-After` in whole seconds, as milliseconds. */
function retryAfterMs(value: string | null): number | undefined {
  return value && /^\d+$/.test(value.trim()) ? Number(value) * 1000 : undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One HTTP attempt with its own timeout; the body is read inside it. */
async function attempt(url: string, init: RequestInit, opts: RequestOpts): Promise<RawResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Perform a Crawl API request and return the raw body. Sets `X-API-Key`, adds a
 * JSON content-type when a body is present, retries transient failures as
 * `retryStatuses` allows, and on a non-2xx parses the problem+json body into a
 * normalized ToolkitError.
 */
async function crawlFetch(method: string, path: string, opts: RequestOpts): Promise<RawResponse> {
  registerSecret(opts.apiKey);
  const url = new URL(crawlBase() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: opts.accept ?? "application/json",
    "User-Agent": CLI_USER_AGENT,
    ...agentClientHeader(),
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined };
  const retryOn = retryStatuses(method, headers);
  const sleep = opts.sleepImpl ?? defaultSleep;

  for (let n = 0; ; n++) {
    const canRetry = retryOn !== undefined && n < MAX_RETRIES;
    let res: RawResponse;
    try {
      res = await attempt(url.toString(), init, opts);
    } catch (err) {
      if (canRetry) {
        await sleep(backoffMs(n));
        continue;
      }
      throw new ToolkitError({
        code: "BACKEND_UNAVAILABLE",
        message: "Could not reach the Zenrows Crawl API.",
        likely_cause: err instanceof Error ? err.message : String(err),
        next_action:
          "Check connectivity and retry. Override the host with ZENROWS_CRAWL_API_BASE if you are testing against staging.",
        suggested_commands: ["zenrows status"],
        crawl_id: opts.crawlId,
      });
    }
    const retryAfter = res.headers.get("retry-after");
    if (canRetry && retryOn.has(res.status)) {
      await sleep(retryAfterMs(retryAfter) ?? backoffMs(n));
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw problemToError(res.status, res.text, `${method} ${path}`, retryAfter, opts.crawlId);
    }
    return res;
  }
}

/** `crawlFetch` + JSON parse. */
async function crawlJson<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
  const { text } = await crawlFetch(method, path, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolkitError({
      code: "CRAWL_FAILED",
      message: "The Crawl API response was not valid JSON.",
      likely_cause: text.slice(0, 240) || "Empty response body.",
      next_action: "Retry, or check the crawl with `zenrows crawl get <id>`.",
      crawl_id: opts.crawlId,
    });
  }
}

/**
 * Map a problem+json body + HTTP status to a normalized ToolkitError that
 * carries the API's `code` as `server_code`, and `crawl_id` when known.
 */
function problemToError(
  status: number,
  body: string,
  request: string,
  retryAfter: string | null,
  crawlId?: string,
): ToolkitError {
  let problem: ProblemJson = {};
  try {
    problem = JSON.parse(body) as ProblemJson;
  } catch {
    // non-JSON error body — fall through with an empty problem
  }
  const serverCode = problem.code || undefined;
  const seconds = status === 429 && retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : undefined;
  const err = classifyProblem(status, problem, body, request, serverCode, seconds);
  return new ToolkitError({ ...err.toJSON(), server_code: serverCode, crawl_id: crawlId, retry_after: seconds });
}

function classifyProblem(
  status: number,
  problem: ProblemJson,
  body: string,
  request: string,
  serverCode: string | undefined,
  retryAfter: number | undefined,
): ToolkitError {
  const detail = problem.detail || problem.title || body.slice(0, 240) || `HTTP ${status}`;
  const cause = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""} for ${request}: ${detail}`;

  if (status === 403 && serverCode === CRAWL_NOT_ENABLED_CODE) {
    return new ToolkitError({
      code: "CRAWL_NOT_ENABLED",
      message: "Crawl is not enabled for this account.",
      likely_cause: `${cause}. Crawl is not enabled for this account yet.`,
      next_action:
        "Ask Zenrows support to enable Crawl for this account. Meanwhile fetch known URLs with `zenrows fetch`.",
      suggested_commands: ["zenrows fetch <url>"],
    });
  }
  if (status === 401) {
    return new ToolkitError({
      code: "AUTH_INVALID",
      message: "Zenrows rejected the API key for the Crawl API.",
      likely_cause: cause,
      next_action: "Re-check your key and log in again.",
      suggested_commands: ["zenrows login --api-key <your-key>"],
    });
  }
  if (status === 404 && serverCode === "content_not_found") {
    return new ToolkitError({
      code: "CRAWL_CONTENT_NOT_FOUND",
      message: "Crawl content not found.",
      likely_cause: `${cause}. The page was not fetched (yet), its fetch failed, or the crawl ran without --output-format html.`,
      next_action: "Read the result's content_status with `zenrows crawl results <id>`; only `fetched` results have content.",
      suggested_commands: ["zenrows crawl list"],
    });
  }
  if (status === 404) {
    return new ToolkitError({
      code: "CRAWL_NOT_FOUND",
      message: "Crawl not found.",
      likely_cause: `${cause}. The id may be wrong or the crawl is not owned by this account.`,
      next_action: "Check the crawl id, or list your crawls with `zenrows crawl list`.",
      suggested_commands: ["zenrows crawl list"],
    });
  }
  if (status === 429) {
    return new ToolkitError({
      code: "CRAWL_TOO_MANY_CRAWLS",
      message: "The account has reached its limit of active jobs.",
      likely_cause: `${cause}. The account has reached its limit of active jobs (3 by default), shared with its Batch jobs.`,
      next_action: `Nothing was created. ${retryAfter !== undefined ? `Retry after ${retryAfter} seconds` : "Retry later"}, or stop one of your crawls (\`zenrows crawl stop <id>\`) or Batch jobs first.`,
      suggested_commands: ["zenrows crawl list"],
    });
  }
  if (status === 402) {
    // Same advice as the shared credit errors, under Crawl's own codes.
    const detail = problem.detail || problem.title || undefined;
    if (isKeyCapReached(serverCode)) {
      return new ToolkitError({ ...keyCapReached(request, { status, detail }).toJSON(), code: "CRAWL_KEY_CAP_REACHED" });
    }
    const acct = readAccount();
    const quota = quotaExhausted(request, acct?.unclaimed ? acct.claimUrl : undefined, { status, detail });
    return new ToolkitError({ ...quota.toJSON(), code: "CRAWL_QUOTA_EXCEEDED" });
  }
  if (status === 409) {
    return new ToolkitError({
      code: "CRAWL_REQUEST_IN_FLIGHT",
      message: "A request with the same Idempotency-Key is still in flight.",
      likely_cause: `${cause}.`,
      next_action: "Retry the same request once the first one has finished.",
    });
  }
  if (status === 400 || status === 422) {
    return new ToolkitError({
      code: "CRAWL_INVALID_REQUEST",
      message: `Crawl rejected the request (HTTP ${status}).`,
      likely_cause: `${cause}.`,
      next_action:
        serverCode === "idempotency_key_reused"
          ? "This Idempotency-Key was already used for a different request. Send a new key, or no key. Do not retry as is."
          : "Fix the reported parameter and retry. See `zenrows crawl --help` for the accepted flags and ranges.",
    });
  }
  return new ToolkitError({
    code: "CRAWL_FAILED",
    message: `Crawl request failed (HTTP ${status}).`,
    likely_cause: `${cause}.`,
    next_action:
      status >= 500 ? "Retry with a short backoff." : "Fix the reported problem and retry.",
  });
}

/** Start a crawl (202). Sends only the fields set in `params`. */
export function createCrawl(params: CreateCrawlParams, opts: CallOpts & { idempotencyKey?: string }): Promise<Crawl> {
  const body: Record<string, unknown> = { url: params.url, depth: params.depth };
  if (params.max_items !== undefined) body.max_items = params.max_items;
  if (params.max_pages !== undefined) body.max_pages = params.max_pages;
  if (params.include_patterns?.length) body.include_patterns = params.include_patterns;
  if (params.exclude_patterns?.length) body.exclude_patterns = params.exclude_patterns;
  if (params.output_format !== undefined) body.output_format = params.output_format;
  return crawlJson<Crawl>("POST", "/crawls", {
    ...opts,
    body,
    headers: opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined,
  });
}

/** Read a crawl and one page of its results. */
export function getCrawl(id: string, opts: CallOpts & { cursor?: string; limit?: number }): Promise<CrawlWithResults> {
  return crawlJson<CrawlWithResults>("GET", `/crawls/${encodeURIComponent(id)}`, {
    ...opts,
    crawlId: id,
    query: { cursor: opts.cursor, limit: opts.limit },
  });
}

/** One page of the account's crawls, newest first. */
export function listCrawls(opts: CallOpts & { cursor?: string; limit?: number }): Promise<CrawlList> {
  return crawlJson<CrawlList>("GET", "/crawls", { ...opts, query: { cursor: opts.cursor, limit: opts.limit } });
}

/** Stop a running crawl. Idempotent: an ended crawl answers as it ended. */
export function stopCrawl(id: string, opts: CallOpts): Promise<CrawlStop> {
  return crawlJson<CrawlStop>("POST", `/crawls/${encodeURIComponent(id)}/stop`, { ...opts, crawlId: id });
}

/** The page of one kept URL (HTML for `output_format: html`). */
export async function getCrawlContent(
  id: string,
  contentId: string,
  opts: CallOpts,
): Promise<{ contentType: string; body: string }> {
  const res = await crawlFetch("GET", `/crawls/${encodeURIComponent(id)}/contents/${encodeURIComponent(contentId)}`, {
    ...opts,
    crawlId: id,
    accept: "text/html, application/json;q=0.9, application/problem+json;q=0.8",
  });
  return { contentType: res.headers.get("content-type") ?? "", body: res.text };
}

/**
 * Every result in one NDJSON file (`{url, content_status?, content?}` per line).
 * `status` is the `X-Crawl-Status` header: `running` means the file is partial.
 */
export async function downloadCrawl(id: string, opts: CallOpts): Promise<{ status?: string; ndjson: string }> {
  const res = await crawlFetch("GET", `/crawls/${encodeURIComponent(id)}/download`, {
    ...opts,
    crawlId: id,
    accept: "application/x-ndjson, application/problem+json;q=0.8",
    timeoutMs: opts.timeoutMs ?? 300_000,
  });
  return { status: res.headers.get("x-crawl-status") ?? undefined, ndjson: res.text };
}

/**
 * The content id of a fetched result: the last segment of its `content_url`.
 * Undefined when the result has no content yet.
 */
export function contentIdOf(result: CrawlResult): string | undefined {
  if (!result.content_url) return undefined;
  const last = result.content_url.split("?")[0]!.replace(/\/+$/, "").split("/").pop();
  return last ? decodeURIComponent(last) : undefined;
}

/**
 * Read every kept result, following `next_cursor`. While a crawl runs its
 * `next_cursor` is never null, so the read also ends at the first empty page;
 * `partial` is true when the crawl was still running or a cursor remains.
 */
export async function listAllResults(
  id: string,
  opts: CallOpts & { pageSize?: number },
): Promise<{ crawl: CrawlWithResults; results: CrawlResult[]; partial: boolean }> {
  const results: CrawlResult[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await getCrawl(id, { ...opts, cursor, limit: opts.pageSize });
    const rows = page.results ?? [];
    results.push(...rows);
    if (!rows.length || !page.next_cursor || page.next_cursor === cursor) {
      return { crawl: page, results, partial: !isTerminal(page.status) || !!page.next_cursor };
    }
    cursor = page.next_cursor;
  }
}

/**
 * Poll `GET /crawls/{id}?limit=1` until the status leaves `running` or
 * `timeoutMs` (default 600 s) runs out, backing off 2s → ×1.5 → capped at 15s.
 * A timeout is not an error: it returns the crawl, still `running`.
 */
export async function waitForCrawl(id: string, opts: CallOpts): Promise<CrawlWithResults> {
  const sleep = opts.sleepImpl ?? defaultSleep;
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  let delay = 2000;
  for (;;) {
    const crawl = await getCrawl(id, { apiKey: opts.apiKey, fetchImpl: opts.fetchImpl, sleepImpl: opts.sleepImpl, limit: 1 });
    if (isTerminal(crawl.status)) return crawl;
    if (Date.now() + delay > deadline) return crawl;
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15_000);
  }
}
