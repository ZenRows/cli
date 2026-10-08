/**
 * Client for the Zenrows Crawl API.
 *
 * Crawl lives on the same host as Fetch and Extract (`https://api.zenrows.com/v1`)
 * under `/crawls`. Auth is the `X-API-Key` header, never the `apikey` query
 * param: Crawl answers any query parameter it does not know with 400. Bodies are
 * JSON; errors come back as `application/problem+json` (RFC 9457) and we branch
 * on `status` + `code` only. A crawl is an async job: create it, then poll it
 * until its status leaves `running`. `fetchImpl` / `sleepImpl` are injectable
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

interface RequestOpts {
  apiKey: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  accept?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

/**
 * Perform a Crawl API request and return the raw body. Sets `X-API-Key`, adds a
 * JSON content-type when a body is present, and on a non-2xx parses the
 * problem+json body into a normalized ToolkitError.
 */
async function crawlFetch(method: string, path: string, opts: RequestOpts): Promise<RawResponse> {
  registerSecret(opts.apiKey);
  const url = new URL(crawlBase() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: opts.accept ?? "application/json",
    "User-Agent": CLI_USER_AGENT,
    ...agentClientHeader(),
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  let text: string;
  try {
    res = await doFetch(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    throw new ToolkitError({
      code: "BACKEND_UNAVAILABLE",
      message: "Could not reach the Zenrows Crawl API.",
      likely_cause: err instanceof Error ? err.message : String(err),
      next_action:
        "Check connectivity and retry. Override the host with ZENROWS_CRAWL_API_BASE if you are testing against staging.",
      suggested_commands: ["zenrows status"],
    });
  } finally {
    clearTimeout(timeout);
  }

  if (res.status < 200 || res.status >= 300) {
    throw problemToError(res.status, text, method, path, res.headers.get("retry-after"));
  }
  return { status: res.status, headers: res.headers, text };
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
      next_action: "Retry, or check the crawl with `zenrows crawl status <id>`.",
    });
  }
}

/** Map a problem+json body + HTTP status to a normalized ToolkitError. */
function problemToError(
  status: number,
  body: string,
  method: string,
  path: string,
  retryAfter: string | null,
): ToolkitError {
  let problem: ProblemJson = {};
  try {
    problem = JSON.parse(body) as ProblemJson;
  } catch {
    // non-JSON error body — fall through with an empty problem
  }
  const serverCode = problem.code ?? "";
  const detail = problem.detail || problem.title || body.slice(0, 240) || `HTTP ${status}`;
  const cause = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""} for ${method} ${path}: ${detail}`;

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
  if (status === 404) {
    const content = serverCode === "content_not_found";
    return new ToolkitError({
      code: "CRAWL_NOT_FOUND",
      message: content ? "Crawl content not found." : "Crawl not found.",
      likely_cause: content
        ? `${cause}. The page was not fetched (yet), its fetch failed, or the crawl ran without --html.`
        : `${cause}. The id may be wrong or the crawl is not owned by this account.`,
      next_action: content
        ? "Read the result's content_status with `zenrows crawl results <id>`; only `fetched` results have content."
        : "Check the crawl id, or list your crawls with `zenrows crawl list`.",
      suggested_commands: ["zenrows crawl list"],
    });
  }
  if (status === 429) {
    const wait = retryAfter && /^\d+$/.test(retryAfter.trim()) ? ` Retry after ${retryAfter.trim()}s.` : "";
    return new ToolkitError({
      code: "CRAWL_QUOTA_EXCEEDED",
      message: "Too many crawls running.",
      likely_cause: `${cause}. The account has too many crawls running.${wait}`,
      next_action:
        "Retry after Retry-After, or stop one of your crawls with `zenrows crawl stop <id>` first. Nothing was created.",
      suggested_commands: ["zenrows crawl list"],
    });
  }
  if (status === 402 && isKeyCapReached(serverCode)) {
    return keyCapReached(`${method} ${path}`, { status: 402, detail: problem.detail || problem.title || undefined });
  }
  if (status === 402) {
    const acct = readAccount();
    return quotaExhausted(`${method} ${path}`, acct?.unclaimed ? acct.claimUrl : undefined, {
      status: 402,
      detail: problem.detail || problem.title || undefined,
    });
  }
  if (status === 400 || status === 409 || status === 422) {
    return new ToolkitError({
      code: "CRAWL_INVALID",
      message: `Crawl rejected the request (HTTP ${status}).`,
      likely_cause: `${cause}.`,
      next_action:
        status === 409
          ? "A request with the same Idempotency-Key is still in flight; retry once it has finished."
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

interface CallOpts {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
    apiKey: opts.apiKey,
    body,
    headers: opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

/** Read a crawl and one page of its results. */
export function getCrawl(id: string, opts: CallOpts & { cursor?: string; limit?: number }): Promise<CrawlWithResults> {
  return crawlJson<CrawlWithResults>("GET", `/crawls/${encodeURIComponent(id)}`, {
    apiKey: opts.apiKey,
    query: { cursor: opts.cursor, limit: opts.limit },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

/** One page of the account's crawls, newest first. */
export function listCrawls(opts: CallOpts & { cursor?: string; limit?: number }): Promise<CrawlList> {
  return crawlJson<CrawlList>("GET", "/crawls", {
    apiKey: opts.apiKey,
    query: { cursor: opts.cursor, limit: opts.limit },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

/** Stop a running crawl. Idempotent: an ended crawl answers as it ended. */
export function stopCrawl(id: string, opts: CallOpts): Promise<CrawlStop> {
  return crawlJson<CrawlStop>("POST", `/crawls/${encodeURIComponent(id)}/stop`, {
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

/** The page of one kept URL (HTML for `output_format: html`). */
export async function getCrawlContent(
  id: string,
  contentId: string,
  opts: CallOpts,
): Promise<{ contentType: string; body: string }> {
  const res = await crawlFetch("GET", `/crawls/${encodeURIComponent(id)}/contents/${encodeURIComponent(contentId)}`, {
    apiKey: opts.apiKey,
    accept: "text/html, application/json;q=0.9, application/problem+json;q=0.8",
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  return { contentType: res.headers.get("content-type") ?? "", body: res.text };
}

/**
 * Every result in one NDJSON file (`{url, content_status?, content?}` per line).
 * `crawlStatus` is the `X-Crawl-Status` header: `running` means the file is partial.
 */
export async function downloadCrawl(id: string, opts: CallOpts): Promise<{ crawlStatus?: string; ndjson: string }> {
  const res = await crawlFetch("GET", `/crawls/${encodeURIComponent(id)}/download`, {
    apiKey: opts.apiKey,
    accept: "application/x-ndjson, application/problem+json;q=0.8",
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 300_000,
  });
  return { crawlStatus: res.headers.get("x-crawl-status") ?? undefined, ndjson: res.text };
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
 * Read every result, following `next_cursor` until it is null. Only call this
 * on an ended crawl: while a crawl runs `next_cursor` is never null, so this
 * refuses a `running` crawl instead of looping forever (wait first).
 */
export async function listAllResults(
  id: string,
  opts: CallOpts & { pageSize?: number },
): Promise<{ crawl: CrawlWithResults; results: CrawlResult[] }> {
  const results: CrawlResult[] = [];
  let cursor: string | undefined;
  let first: CrawlWithResults | undefined;
  for (;;) {
    const page = await getCrawl(id, { ...opts, cursor, limit: opts.pageSize });
    if (!isTerminal(page.status)) {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: `Crawl ${id} is still running.`,
        likely_cause: "Reading all results needs an ended crawl: while it runs, more results keep arriving.",
        next_action: "Wait for it first (`zenrows crawl wait <id>`), or stop it with `zenrows crawl stop <id>`.",
        suggested_commands: [`zenrows crawl wait ${id}`, `zenrows crawl status ${id}`],
      });
    }
    first ??= page;
    results.push(...(page.results ?? []));
    if (page.next_cursor === null || page.next_cursor === undefined || page.next_cursor === cursor) break;
    cursor = page.next_cursor;
  }
  return { crawl: first!, results };
}

/**
 * Poll `GET /crawls/{id}?limit=1` until the status leaves `running`, backing off
 * 2s → ×1.5 → capped at 15s. On timeout throws CRAWL_TIMEOUT
 * and leaves the crawl running. `sleepImpl` is injectable for tests.
 */
export async function waitForCrawl(
  id: string,
  opts: CallOpts & { sleepImpl?: (ms: number) => Promise<void> },
): Promise<CrawlWithResults> {
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;
  let delay = 2000;
  for (;;) {
    const crawl = await getCrawl(id, { apiKey: opts.apiKey, fetchImpl: opts.fetchImpl, limit: 1 });
    if (isTerminal(crawl.status)) return crawl;
    if (Date.now() + delay > deadline) {
      throw new ToolkitError({
        code: "CRAWL_TIMEOUT",
        message: `Timed out waiting for crawl ${id} to finish.`,
        likely_cause: `The crawl was still running after ${Math.round(timeoutMs / 1000)}s. It keeps running; it was not stopped.`,
        next_action: "Re-check progress with `zenrows crawl status <id>`, wait again with a larger --timeout, or stop it.",
        suggested_commands: [`zenrows crawl status ${id}`, `zenrows crawl wait ${id}`, `zenrows crawl stop ${id}`],
      });
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15_000);
  }
}
