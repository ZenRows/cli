/**
 * Client for the ZenRows Batch Scraper API.
 *
 * A SEPARATE host from the Universal Scraper API (`api.zenrows.com/v1`): batch
 * jobs live at `https://async.api.zenrows.com/v1`. Auth is the `X-API-Key`
 * header (same key as the scraper API), never the `apikey` query param. Bodies
 * are JSON; errors come back as `application/problem+json` (RFC 7807) with a
 * stable `code` we branch on. The key is registered as a secret so it is
 * redacted from any logged output. `fetchImpl` is injectable for tests, mirroring
 * `usage.ts` / `agent-account.ts`.
 *
 * Deferred (documented, not wired here): CSV upload (`/job_inputs` + presigned
 * PUT), open/queue jobs (`/tasks`, `last_batch`), scheduled jobs
 * (`schedule` / `PUT /schedule` / `schedule/state`), webhooks + HMAC, ZIP
 * archive export, and the `Idempotency-Key` header.
 */
import { ToolkitError } from "./errors.ts";
import { registerSecret } from "./logger.ts";

/** Confirmed Batch Scraper API base (no trailing slash). */
export const DEFAULT_BATCH_API_BASE = "https://async.api.zenrows.com/v1";
/** Env var to override the Batch API base (local/staging testing). */
export const BATCH_API_BASE_ENV = "ZENROWS_BATCH_API_BASE";

/** Resolve the Batch API base, honoring the env override, trimmed of trailing `/`. */
export function batchBase(): string {
  const env = process.env[BATCH_API_BASE_ENV];
  const base = env && env.trim() ? env.trim() : DEFAULT_BATCH_API_BASE;
  return base.replace(/\/+$/, "");
}

export interface JobStats {
  total: number;
  completed: number;
  successful: number;
  failed: number;
}

export interface JobRun {
  status: string;
  stats: JobStats;
  run_id?: string;
  [k: string]: unknown;
}

export interface Job {
  job_id: string;
  latest_run: JobRun;
  [k: string]: unknown;
}

export interface ResultRow {
  external_id?: string;
  task_id: string;
  status?: string;
  result_url?: string;
  [k: string]: unknown;
}

export interface ResultsPage {
  results: ResultRow[];
  next_cursor: string | null;
}

/** RFC 7807 problem body returned by the Batch API on non-2xx. */
interface ProblemJson {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  invalid_tasks?: Array<{ index: number; reason: string }>;
}

/** Terminal run states — a run stops progressing once it reaches one of these. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "stopped", "deleted"]);

interface RequestOpts {
  apiKey: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Perform a Batch API request. Sets `X-API-Key`, adds a JSON content-type when a
 * body is present, parses the JSON response, and on a non-2xx parses the
 * problem+json body into a normalized ToolkitError. Returns `null` for empty
 * (204 / no-body) responses.
 */
export async function batchRequest<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
  registerSecret(opts.apiKey);
  const url = new URL(batchBase() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: "application/json",
    "User-Agent": "zenrows-cli",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new ToolkitError({
      code: "BACKEND_UNAVAILABLE",
      message: "Could not reach the ZenRows Batch Scraper API.",
      likely_cause: err instanceof Error ? err.message : String(err),
      next_action:
        "Check connectivity and retry. Override the host with ZENROWS_BATCH_API_BASE if you are testing against staging.",
      suggested_commands: ["zenrows status"],
    });
  }
  clearTimeout(timeout);

  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw problemToError(res.status, text, method, path);
  }
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolkitError({
      code: "BATCH_FAILED",
      message: "The Batch API response was not valid JSON.",
      likely_cause: text.slice(0, 240),
      next_action: "Retry, or inspect the job in the ZenRows dashboard.",
    });
  }
}

/** Map an RFC 7807 problem body + HTTP status to a normalized ToolkitError. */
function problemToError(status: number, body: string, method: string, path: string): ToolkitError {
  let problem: ProblemJson = {};
  try {
    problem = JSON.parse(body) as ProblemJson;
  } catch {
    // non-JSON error body — fall through with an empty problem
  }
  const serverCode = problem.code ?? "";
  const detail = problem.detail || problem.title || body.slice(0, 240) || `HTTP ${status}`;
  const cause = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""} for ${method} ${path}: ${detail}`;

  if (status === 403) {
    return new ToolkitError({
      code: "BATCH_ACCESS_DENIED",
      message: "The Batch Scraper API rejected this request (access denied).",
      likely_cause: `${cause}. The Batch Scraper API is in private beta and this account is not invited.`,
      next_action:
        "Request Batch Scraper API beta access from ZenRows. Meanwhile validate/estimate specs locally and fan out with `zenrows fetch` per URL.",
      suggested_commands: ["zenrows batch estimate jobs.jsonl"],
    });
  }
  if (status === 401) {
    return new ToolkitError({
      code: "AUTH_INVALID",
      message: "ZenRows rejected the API key for the Batch Scraper API.",
      likely_cause: cause,
      next_action: "Re-check your key and log in again.",
      suggested_commands: ["zenrows login --api-key <your-key>"],
    });
  }
  if (status === 404) {
    return new ToolkitError({
      code: "BATCH_NOT_FOUND",
      message: "Batch job, run, or task not found.",
      likely_cause: `${cause}. The id may be wrong or the job is not owned by this account.`,
      next_action: "Check the job id, or list your recent jobs in the ZenRows dashboard.",
    });
  }
  if (status === 429) {
    return new ToolkitError({
      code: "BATCH_QUOTA_EXCEEDED",
      message: "Batch quota exceeded.",
      likely_cause: `${cause}. An account limit was reached (e.g. the maximum of 3 concurrent active jobs).`,
      next_action:
        "Wait for an in-flight job to finish (or stop one with `zenrows batch cancel <id>`), then retry.",
      suggested_commands: ["zenrows batch status <id>"],
    });
  }

  // 400 invalid_argument, 409 conflict, 402 payment_required, 5xx, etc.
  const invalid = problem.invalid_tasks?.length
    ? ` invalid_tasks: ${problem.invalid_tasks
        .slice(0, 10)
        .map((t) => `#${t.index}: ${t.reason}`)
        .join("; ")}`
    : "";
  return new ToolkitError({
    code: "BATCH_FAILED",
    message: `Batch request failed (HTTP ${status}).`,
    likely_cause: `${cause}.${invalid}`,
    next_action:
      status >= 500
        ? "This is transient — retry with a short backoff."
        : "Fix the reported problem and retry. For validation errors, correct the flagged tasks.",
  });
}

interface CallOpts {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Create a job. Accepts both 201 (<10k tasks) and 202 (≥10k) as success. */
export function createJob(body: unknown, opts: CallOpts): Promise<Job> {
  return batchRequest<Job>("POST", "/jobs", { apiKey: opts.apiKey, body, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

/** Read a job (`latest_run.status` + `latest_run.stats`). */
export function getJob(id: string, opts: CallOpts): Promise<Job> {
  return batchRequest<Job>("GET", `/jobs/${encodeURIComponent(id)}`, { apiKey: opts.apiKey, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

/** Abort an in-flight run. */
export function stopJob(id: string, opts: CallOpts): Promise<Job> {
  return batchRequest<Job>("POST", `/jobs/${encodeURIComponent(id)}/stop`, { apiKey: opts.apiKey, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

/**
 * Replay a job as a new run. `status="failed"` re-runs only the failures
 * (append `,pending` to also include tasks that never started). Already-
 * successful tasks carry over, so you only re-scrape what failed.
 */
export function rerunJob(id: string, opts: CallOpts & { status?: string }): Promise<Job> {
  return batchRequest<Job>("POST", `/jobs/${encodeURIComponent(id)}/rerun`, {
    apiKey: opts.apiKey,
    query: opts.status ? { status: opts.status } : undefined,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

/** List all result rows for a run, paginating over the `cursor` until `next_cursor` is null. */
export async function listResults(
  id: string,
  opts: CallOpts & { status?: "successful" | "failed" | "all" },
): Promise<ResultRow[]> {
  const all: ResultRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await batchRequest<ResultsPage>("GET", `/jobs/${encodeURIComponent(id)}/results`, {
      apiKey: opts.apiKey,
      query: { status: opts.status, cursor },
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
    if (page?.results) all.push(...page.results);
    cursor = page?.next_cursor ?? undefined;
  } while (cursor);
  return all;
}

/**
 * Poll `GET /jobs/{id}` until `latest_run.status` is terminal, backing off
 * 2s → ×1.5 → capped at 15s. Throws BATCH_FAILED on timeout. `sleepImpl` is
 * injectable for tests.
 */
export async function waitForJob(
  id: string,
  opts: CallOpts & { sleepImpl?: (ms: number) => Promise<void> },
): Promise<Job> {
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  let delay = 2000;
  for (;;) {
    const job = await getJob(id, { apiKey: opts.apiKey, fetchImpl: opts.fetchImpl });
    if (job.latest_run && TERMINAL_STATUSES.has(job.latest_run.status)) return job;
    if (Date.now() > deadline) {
      throw new ToolkitError({
        code: "BATCH_FAILED",
        message: `Timed out waiting for batch job ${id} to finish.`,
        likely_cause: `The run did not reach a terminal state within ${Math.round((opts.timeoutMs ?? 600_000) / 1000)}s.`,
        next_action: "Re-check progress with `zenrows batch status <id>`, or raise --timeout.",
        suggested_commands: [`zenrows batch status ${id}`],
      });
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15_000);
  }
}
