/**
 * Client for the Zenrows Batch API.
 *
 * A SEPARATE host from Fetch and Extract (`api.zenrows.com/v1`): batch
 * jobs live at `https://async.api.zenrows.com/v1`. Auth is the `X-API-Key`
 * header (same key as Fetch and Extract), never the `apikey` query param. Bodies
 * are JSON; errors come back as `application/problem+json` (RFC 7807) with a
 * stable `code` we branch on. The key is registered as a secret so it is
 * redacted from any logged output. `fetchImpl` is injectable for tests, mirroring
 * `usage.ts` / `agent-account.ts`.
 *
 * GETs retry transient failures (429/502/503/504, honoring `Retry-After`) with
 * backoff; a POST retries only when it carries an `Idempotency-Key`, which
 * `createJob` and `rerunJob` send. The key is reused across the automatic
 * retries of one call, so a retry within the key's 24 hours never starts a
 * second job or run. Its answer is not guaranteed to be the original: the API
 * may replay it, answer 409 (no recorded answer yet, or for a rerun a run the
 * first attempt already started), or refuse before checking the key (e.g. 402
 * out of credits). After a lost attempt, any of these is reported as "an
 * earlier attempt may have gone through", never as a reason to resubmit.
 *
 * Deferred (documented, not wired here): CSV upload (`/job_inputs` + presigned
 * PUT), open/queue jobs (`/tasks`, `last_batch`), scheduled jobs
 * (`schedule` / `PUT /schedule` / `schedule/state`), webhooks + HMAC, and ZIP
 * archive export.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ToolkitError, isKeyCapReached, keyCapReached, quotaExhausted, type ErrorCode } from "./errors.ts";
import { readAccount } from "./agent-account.ts";
import { registerSecret } from "./logger.ts";
import { CLI_USER_AGENT } from "./config.ts";
import { agentClientHeader } from "./agent-client.ts";
import { BILLING_URL } from "./open-url.ts";

/** Confirmed Batch API base (no trailing slash). */
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
  /** Why a `failed` run stopped, e.g. `api_key_cap_reached`. */
  failure_reason?: string;
  /** Human-readable detail for `failure_reason`. */
  failure_detail?: string;
  /** `paused` while the run is paused: no new task is picked up; tasks already started may still finish. */
  pause_state?: string;
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
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "stopped", "failed", "deleted"]);

/** Result filters the API accepts on `GET /jobs/{id}/results`. */
export type ResultStatus = "successful" | "failed" | "processing" | "all";

interface RequestOpts {
  apiKey: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Shape check for a 2xx answer; a failed check is treated like an unreadable answer. */
  validate?: (v: unknown) => boolean;
}

/** True for an answer that names a job, as `POST /jobs` and `POST /jobs/{id}/rerun` do. */
function hasJobId(v: unknown): boolean {
  return typeof v === "object" && v !== null && typeof (v as { job_id?: unknown }).job_id === "string" && (v as { job_id: string }).job_id !== "";
}

const MAX_RETRIES = 3;
/** Never wait longer than this on a `Retry-After`, in seconds. */
const MAX_RETRY_AFTER_SECONDS = 30;
const READ_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
// 429 on a POST is an account limit (e.g. active jobs): retrying only waits for a slot that may never free.
const WRITE_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * The statuses to retry, or undefined when the request must run once: a GET is
 * safe to repeat, a POST only with an Idempotency-Key.
 */
function retryStatuses(method: string, headers: Record<string, string>): ReadonlySet<number> | undefined {
  if (method === "GET") return READ_RETRY_STATUSES;
  return headers["Idempotency-Key"] ? WRITE_RETRY_STATUSES : undefined;
}

/** 250 ms x 2^attempt, capped at 10 s, +/-20% jitter. */
function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 10_000) * (0.8 + Math.random() * 0.4);
}

/** `Retry-After` in whole seconds, as milliseconds, at most `MAX_RETRY_AFTER_SECONDS`. */
function retryAfterMs(value: string | null): number | undefined {
  return value && /^\d+$/.test(value.trim()) ? Math.min(Number(value), MAX_RETRY_AFTER_SECONDS) * 1000 : undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A fresh Idempotency-Key for one logical submit or rerun. */
export function newIdempotencyKey(): string {
  return randomUUID();
}

/** The longest Idempotency-Key the Batch API documents. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * Throw before any request if `key` cannot work as an Idempotency-Key. HTTP
 * strips a header value's leading and trailing whitespace, so a blank key
 * reaches the API empty (no deduplication at all) and a padded key reaches it
 * as a different key than the one shown to the user. Control characters can't
 * be sent in a header.
 */
export function assertIdempotencyKey(key: string): void {
  let reason: string | undefined;
  if (key.trim() === "") reason = "it is empty or only whitespace";
  else if (key !== key.trim()) reason = "it starts or ends with whitespace";
  else if (/[\u0000-\u001f\u007f]/.test(key)) reason = "it contains a control character";
  else if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) reason = `it is longer than ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`;
  if (!reason) return;
  throw new ToolkitError({
    code: "INVALID_USAGE",
    message: `Invalid --idempotency-key: ${reason}.`,
    likely_cause:
      "An Idempotency-Key must be 1 to 128 characters, with no leading or trailing whitespace and no control characters; otherwise the API would not see the key you meant.",
    next_action: "Pass a non-empty key such as a UUID, or leave --idempotency-key out to have one generated.",
  });
}

/**
 * Perform a Batch API request. Sets `X-API-Key`, adds a JSON content-type when a
 * body is present, retries transient failures as `retryStatuses` allows, parses
 * the JSON response, and on a non-2xx parses the problem+json body into a
 * normalized ToolkitError. Returns `null` for empty (204 / no-body) responses.
 */
export async function batchRequest<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
  registerSecret(opts.apiKey);
  const url = new URL(batchBase() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;

  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: "application/json",
    "User-Agent": CLI_USER_AGENT,
    ...agentClientHeader(),
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const retryOn = retryStatuses(method, headers);
  // A write sent with an Idempotency-Key. Only these are retried, so only these
  // can end with an attempt whose result is unknown.
  const key = headers["Idempotency-Key"];

  // Set once an attempt got no usable answer (no response, or a 5xx): the
  // server may have done the work, so every later failure of this call is an
  // unknown outcome too, whatever its status (a 402 or 409 included).
  let earlierMayHaveLanded = false;
  for (let n = 0; ; n++) {
    const canRetry = retryOn !== undefined && n < MAX_RETRIES;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
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
      clearTimeout(timeout);
      if (canRetry) {
        earlierMayHaveLanded = true;
        await sleep(backoffMs(n));
        continue;
      }
      const failure = new ToolkitError({
        code: "BACKEND_UNAVAILABLE",
        message: "Could not reach the Zenrows Batch API.",
        likely_cause: err instanceof Error ? err.message : String(err),
        next_action:
          "Check connectivity and retry. Override the host with ZENROWS_BATCH_API_BASE if you are testing against staging.",
        suggested_commands: ["zenrows status"],
      });
      // Unknown: the request may have reached the server before the connection failed.
      throw key ? outcomeUnknown(failure, key) : failure;
    }
    clearTimeout(timeout);

    if (canRetry && retryOn.has(res.status)) {
      if (res.status >= 500) earlierMayHaveLanded = true;
      await sleep(retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(n));
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      const failure = problemToError(res.status, text, method, path, earlierMayHaveLanded);
      if (key && res.status >= 500) throw outcomeUnknown(failure, key);
      // A definite refusal of this attempt, but an earlier one may have been accepted.
      if (key && earlierMayHaveLanded) throw outcomeUnknown(failure, key, { keepAdvice: true, earlier: res.status !== 409 });
      throw failure;
    }

    // A 2xx: the server accepted this attempt. If its answer can't be read, a
    // write's result (the job or run it created) is unknown, not failed.
    let parsed: unknown = null;
    let readable = true;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        readable = false;
      }
    }
    if (readable && opts.validate && !opts.validate(parsed)) readable = false;
    if (!readable) {
      const failure = new ToolkitError({
        code: "BATCH_FAILED",
        message: `The Batch API accepted ${method} ${path} (HTTP ${res.status}) but its answer could not be read.`,
        likely_cause: text ? `Unexpected response: ${text.slice(0, 240)}` : "The response body was empty.",
        next_action: "Retry, or inspect the job in the Zenrows dashboard.",
      });
      throw key ? outcomeUnknown(failure, key, { accepted: true }) : failure;
    }
    return parsed as T;
  }
}

/**
 * A write (POST with an Idempotency-Key) whose outcome is unknown: the server
 * may have done the work even though no usable answer arrived. Attach the key
 * and say what is safe; the command layer adds the exact command to repeat.
 *
 * - `accepted`: this attempt was answered 2xx but the answer was unreadable.
 * - `keepAdvice`: this attempt was refused with its own advice (402, 409, ...),
 *   kept in front; `earlier` adds that an earlier attempt may have gone through.
 */
function outcomeUnknown(
  err: ToolkitError,
  key: string,
  opts: { keepAdvice?: boolean; earlier?: boolean; accepted?: boolean } = {},
): ToolkitError {
  const e = err.toJSON();
  let lead: string;
  if (opts.accepted) {
    lead = "The API accepted the request, so the job or run probably exists, but its answer could not be read.";
  } else if (opts.keepAdvice) {
    lead = opts.earlier
      ? `${e.next_action} An earlier attempt of this request got no usable answer and may have been accepted.`
      : e.next_action;
  } else {
    lead = "The request may have been accepted even though no usable answer arrived.";
  }
  return new ToolkitError({
    ...e,
    idempotency_key: key,
    next_action:
      `${lead} Do not resubmit with a new key: that can create a second job or run. ` +
      `Repeating the identical request with the same Idempotency-Key (${key}) within 24 hours of the first attempt cannot create a duplicate; after that the key is forgotten and counts as new. ` +
      "The answer to a repeat is not guaranteed to be the original: the API may replay it, answer 409 (no recorded answer yet, or a rerun whose run is already in progress), " +
      "or refuse before it looks at the key (for example 402 when the account is out of credits). " +
      "Unless the repeat comes back with the job, check your jobs (`zenrows batch status <id>` or the dashboard) before doing anything else.",
  });
}

/**
 * How to free the slot a 429 names. Each kind frees differently: a scheduled job
 * counts until it is deleted, whatever its runs do; an open job counts while it
 * is open; a closed job counts while its run is in progress.
 */
function quotaAdvice(detail: string): string {
  if (/scheduled job/i.test(detail)) {
    return "Scheduled jobs count toward their limit until they are deleted, whatever their runs are doing. Delete a scheduled job you no longer need, then retry.";
  }
  return "Active jobs count until they are done: a closed job while its run is in progress (wait for it, or stop it with `zenrows batch cancel <id>`), and an open job until it is deleted, or closed and its run has ended. Free one, then retry.";
}

/** Add `server_code` and `reason` to a shared error; its `code` and advice stay as they are. */
function withDetail(err: ToolkitError, serverCode: string, reason: string): ToolkitError {
  return new ToolkitError({ ...err.toJSON(), ...(serverCode ? { server_code: serverCode } : {}), reason });
}

/**
 * Specific guidance for the 409s a create, rerun or stop can answer with.
 * `retried` is true when an earlier attempt of the same call (same
 * Idempotency-Key) failed in transit, so it may have been accepted.
 */
function conflictAdvice(serverCode: string, detail: string, path: string, retried: boolean): string | undefined {
  const isRerun = /\/rerun$/.test(path);
  switch (serverCode) {
    case "no_matching_tasks":
      return "No task in the previous run has the statuses you asked to retry. If tasks did not finish (a stopped or credit-failed run), retry them with `zenrows batch retry-failed <id> --include-pending`, or check the run with `zenrows batch status <id>`.";
    case "run_not_terminal":
      if (retried && isRerun) {
        return "An earlier attempt of this rerun failed in transit and may have started the new run, which is why the job now has a run in progress. Check it with `zenrows batch status <id>` before rerunning again.";
      }
      if (/ingestion did not complete/i.test(detail)) {
        return "The previous run never finished receiving its tasks, so it cannot be rerun. Delete the job and submit the URLs again as a new job.";
      }
      return "The current run is still in progress. Wait for it to finish with `zenrows batch wait <id>`, or stop it with `zenrows batch cancel <id>`, then retry.";
    case "partial_rerun_window_expired":
      return "Retrying only some tasks is allowed for 10 days after a run starts. Rerun everything with a full rerun, or submit the URLs again as a new job.";
    case "run_not_stoppable":
      return "The run already finished, so there is nothing to stop. Check it with `zenrows batch status <id>`.";
    case "idempotency_key_conflict":
      if (retried) {
        return "An earlier attempt of this request failed in transit, and the API holds that attempt under the same Idempotency-Key without a recorded answer: it may still be processing, or it may have failed partway.";
      }
      return "This Idempotency-Key was already used, either for a different request, or for this one without a recorded answer (still processing, or failed partway). Retrying with the same key within 24 hours of the first request cannot create a duplicate, but it may keep answering 409: check your jobs (`zenrows batch status <id>` or the dashboard) first. Use a new key only for a deliberately new job, after checking that the earlier one is not the job you want.";
    default:
      return undefined;
  }
}

/** Map an RFC 7807 problem body + HTTP status to a normalized ToolkitError. */
function problemToError(status: number, body: string, method: string, path: string, retried = false): ToolkitError {
  let problem: ProblemJson = {};
  try {
    problem = JSON.parse(body) as ProblemJson;
  } catch {
    // non-JSON error body — fall through with an empty problem
  }
  const serverCode = problem.code ?? "";
  const detail = (problem.detail || problem.title || body.slice(0, 240) || `HTTP ${status}`).replace(/\.\s*$/, "");
  const cause = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""} for ${method} ${path}: ${detail}`;

  const sc = serverCode ? { server_code: serverCode } : {};
  if (status === 403) {
    return new ToolkitError({
      ...sc,
      code: "BATCH_ACCESS_DENIED",
      message: "The Batch API rejected this request (access denied).",
      likely_cause: `${cause}. Batch is not enabled for this account or API key.`,
      next_action:
        "Check that your Zenrows API key is active, and contact Zenrows support if the 403 persists. Meanwhile validate/estimate specs locally and fan out with `zenrows fetch` per URL.",
      suggested_commands: ["zenrows batch estimate jobs.jsonl"],
    });
  }
  if (status === 401 && serverCode === "subscription_inactive") {
    // The key is fine; the subscription needs a billing action. Same
    // AUTH_INVALID code as any 401 so callers that branch on it keep
    // working; only the guidance changes, since re-entering the key won't help.
    return new ToolkitError({
      code: "AUTH_INVALID",
      message: "Zenrows refused the Batch API request because the subscription is not active.",
      likely_cause: `${cause.replace(/\.?$/, ".")} The API key is valid, but the subscription is past due, unpaid, incomplete or paused.`,
      next_action: `Fix the subscription in Billing (${BILLING_URL}), or in Azure Marketplace if you subscribed there, then retry.`,
    });
  }
  if (status === 401) {
    return new ToolkitError({
      ...sc,
      code: "AUTH_INVALID",
      message: "Zenrows rejected the API key for the Batch API.",
      likely_cause: cause,
      next_action: "Re-check your key and log in again.",
      suggested_commands: ["zenrows login --api-key <your-key>"],
    });
  }
  if (status === 404) {
    return new ToolkitError({
      ...sc,
      code: "BATCH_NOT_FOUND",
      message: "Batch job, run, or task not found.",
      likely_cause: `${cause}. The id may be wrong or the job is not owned by this account.`,
      next_action: "Check the job id, or list your recent jobs in the Zenrows dashboard.",
    });
  }
  if (status === 429) {
    const scheduled = /scheduled job/i.test(detail);
    return new ToolkitError({
      ...sc,
      code: "BATCH_QUOTA_EXCEEDED",
      reason: scheduled ? "too_many_scheduled_jobs" : "too_many_active_jobs",
      message: "Batch quota exceeded.",
      likely_cause: `${cause}. An account limit was reached: 3 active jobs and 5 scheduled jobs by default.`,
      next_action: quotaAdvice(detail),
      suggested_commands: ["zenrows batch status <id>"],
    });
  }
  if (status === 402 && isKeyCapReached(serverCode)) {
    return withDetail(
      keyCapReached(`${method} ${path}`, { status: 402, detail: problem.detail || problem.title || undefined }),
      serverCode,
      "api_key_cap_reached",
    );
  }
  if (status === 402) {
    // Out of credits ("Subscription has no credit available") — the same
    // exhausted state as the scraper/usage 402. Surface the credits error with
    // a claim link (unclaimed Free plan) or dashboard/upgrade pointer, not a
    // generic "fix the problem and retry".
    const acct = readAccount();
    return withDetail(
      quotaExhausted(`${method} ${path}`, acct?.unclaimed ? acct.claimUrl : undefined, {
        status: 402,
        detail: problem.detail || problem.title || undefined,
      }),
      serverCode,
      "insufficient_credits",
    );
  }

  // 400 invalid_argument, 409 conflict, 5xx, etc.
  const invalid = problem.invalid_tasks?.length
    ? ` invalid_tasks: ${problem.invalid_tasks
        .slice(0, 10)
        .map((t) => `#${t.index}: ${t.reason}`)
        .join("; ")}`
    : "";
  return new ToolkitError({
    ...sc,
    code: "BATCH_FAILED",
    message: `Batch request failed (HTTP ${status}).`,
    likely_cause: `${cause}.${invalid}`,
    next_action:
      conflictAdvice(serverCode, detail, path, retried) ??
      (status >= 500
        ? "This is transient: retry with a short backoff."
        : "Fix the reported problem and retry. For validation errors, correct the flagged tasks."),
  });
}

interface CallOpts {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Create a job. Accepts both 201 (tasks stored before answering) and 202
 * (accepted for asynchronous ingestion, used for large submits) as success.
 * Sends an `Idempotency-Key`, a fresh one unless given, that the automatic
 * retries of this call reuse; repeating the command later only dedupes when
 * the caller passes the same key again.
 */
export async function createJob(body: unknown, opts: CallOpts & { idempotencyKey?: string }): Promise<Job> {
  if (opts.idempotencyKey !== undefined) assertIdempotencyKey(opts.idempotencyKey);
  return batchRequest<Job>("POST", "/jobs", {
    apiKey: opts.apiKey,
    body,
    validate: hasJobId,
    headers: { "Idempotency-Key": opts.idempotencyKey ?? newIdempotencyKey() },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    sleepImpl: opts.sleepImpl,
  });
}

/** Read a job (`latest_run.status` + `latest_run.stats`). */
export function getJob(id: string, opts: CallOpts): Promise<Job> {
  return batchRequest<Job>("GET", `/jobs/${encodeURIComponent(id)}`, {
    apiKey: opts.apiKey,
    validate: hasJobId,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    sleepImpl: opts.sleepImpl,
  });
}

/** Abort an in-flight run. The API answers with the refreshed run, not the job. */
export function stopJob(id: string, opts: CallOpts): Promise<JobRun> {
  return batchRequest<JobRun>("POST", `/jobs/${encodeURIComponent(id)}/stop`, { apiKey: opts.apiKey, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

/**
 * Replay a job as a new run. `status="failed"` re-runs only the failures;
 * `failed,pending,processing` also includes every task that did not finish
 * (after a stopped or credit-failed run, unstarted tasks stay `pending` and
 * tasks cut off mid-flight can stay `processing`). Already-successful tasks
 * carry over, so you only re-scrape what failed. Sends an `Idempotency-Key`
 * like `createJob`.
 */
export async function rerunJob(id: string, opts: CallOpts & { status?: string; idempotencyKey?: string }): Promise<Job> {
  if (opts.idempotencyKey !== undefined) assertIdempotencyKey(opts.idempotencyKey);
  return batchRequest<Job>("POST", `/jobs/${encodeURIComponent(id)}/rerun`, {
    apiKey: opts.apiKey,
    validate: hasJobId,
    query: opts.status ? { status: opts.status } : undefined,
    headers: { "Idempotency-Key": opts.idempotencyKey ?? newIdempotencyKey() },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    sleepImpl: opts.sleepImpl,
  });
}

/** List all result rows for a run, paginating over the `cursor` until `next_cursor` is null. */
export async function listResults(
  id: string,
  opts: CallOpts & { status?: ResultStatus },
): Promise<ResultRow[]> {
  const all: ResultRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await batchRequest<ResultsPage>("GET", `/jobs/${encodeURIComponent(id)}/results`, {
      apiKey: opts.apiKey,
      query: { status: opts.status, cursor },
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
      sleepImpl: opts.sleepImpl,
    });
    if (page?.results) all.push(...page.results);
    cursor = page?.next_cursor ?? undefined;
  } while (cursor);
  return all;
}

/** Map a result `type` to a file extension for downloaded bodies. */
const EXT_BY_TYPE: Record<string, string> = {
  json: "json",
  html: "html",
  markdown: "md",
  plaintext: "txt",
  pdf: "pdf",
};

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || "task";
}

function fileBase(row: ResultRow): string {
  const id = row.external_id && String(row.external_id).trim() ? String(row.external_id) : row.task_id;
  return safeName(id);
}

function fileExt(row: ResultRow): string {
  const t = typeof row.type === "string" ? row.type.toLowerCase() : "";
  return EXT_BY_TYPE[t] ?? "bin";
}

function uniqueName(used: Set<string>, base: string, ext: string): string {
  let name = `${base}.${ext}`;
  for (let i = 1; used.has(name); i++) name = `${base}-${i}.${ext}`;
  used.add(name);
  return name;
}

export interface DownloadOutcome {
  dir: string;
  downloaded: Array<{ task_id: string; external_id?: string; file: string }>;
  failed: Array<{ task_id: string; external_id?: string; reason: string }>;
  skipped: Array<{ task_id: string; external_id?: string; reason: string }>;
}

/**
 * Stream each result body into its own file under `dir` (created if needed),
 * plus a self-describing `_manifest.jsonl` index (result_url dropped — it is a
 * short-lived presigned link). Fetches run `concurrency` at a time and a single
 * failure never aborts the rest: per-task outcomes come back in the result.
 *
 * Only tasks with a `result_url` have a body to fetch; failed tasks carry an
 * `error` instead and are reported as `skipped`. Because the presigned links
 * expire, download soon after `listResults`. Deliberately opt-in (not the
 * `results` default): a large job's bodies can be many GB, and the URL manifest
 * is the right primitive to pull selectively.
 */
export async function downloadResults(
  rows: ResultRow[],
  dir: string,
  opts: { fetchImpl?: typeof fetch; concurrency?: number; timeoutMs?: number } = {},
): Promise<DownloadOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  mkdirSync(dir, { recursive: true });

  // Reserve filenames up front (sync) so concurrent workers can't collide.
  const used = new Set<string>();
  const planned = rows.map((row) => ({
    row,
    file: row.result_url ? uniqueName(used, fileBase(row), fileExt(row)) : null,
  }));

  const outcome: DownloadOutcome = { dir, downloaded: [], failed: [], skipped: [] };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < planned.length) {
      const { row, file } = planned[next++]!;
      const ref = { task_id: row.task_id, external_id: row.external_id };
      if (!file) {
        outcome.skipped.push({
          ...ref,
          reason: row.status === "failed" ? "task failed — no result body" : "no result_url",
        });
        continue;
      }
      try {
        const res = await doFetch(row.result_url!, { signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
        if (!res.ok) {
          outcome.failed.push({ ...ref, reason: `HTTP ${res.status} fetching result body` });
          continue;
        }
        writeFileSync(join(dir, file), Buffer.from(await res.arrayBuffer()));
        outcome.downloaded.push({ ...ref, file });
      } catch (err) {
        outcome.failed.push({ ...ref, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, planned.length || 1) }, worker));

  const fileByTask = new Map(outcome.downloaded.map((d) => [d.task_id, d.file]));
  const manifest = rows.map((r) => {
    const rest = { ...r };
    delete rest.result_url; // expires — the local `file` is the durable pointer
    return { ...rest, file: fileByTask.get(r.task_id) ?? null };
  });
  writeFileSync(
    join(dir, "_manifest.jsonl"),
    manifest.map((m) => JSON.stringify(m)).join("\n") + (manifest.length ? "\n" : ""),
  );
  return outcome;
}

/** True when the run is paused: no new task is picked up, though tasks already started may still finish. */
export function isPaused(run: JobRun | undefined): boolean {
  // A stopped run can keep `pause_state: paused`; only a live run is paused.
  return run?.pause_state === "paused" && (run.status === "running" || run.status === "pending");
}

/**
 * Poll `GET /jobs/{id}` until `latest_run.status` is terminal, backing off
 * 2s, x1.5, capped at 15s. Throws BATCH_FAILED on timeout (`reason:
 * wait_timeout`), and right away when the run is paused (`reason: run_paused`),
 * since a paused run picks up no new task and the wait would only time out.
 * `sleepImpl` is injectable for tests.
 */
export async function waitForJob(
  id: string,
  opts: CallOpts & { sleepImpl?: (ms: number) => Promise<void> },
): Promise<Job> {
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  let delay = 2000;
  for (;;) {
    const job = await getJob(id, { apiKey: opts.apiKey, fetchImpl: opts.fetchImpl, sleepImpl: opts.sleepImpl });
    if (job.latest_run && TERMINAL_STATUSES.has(job.latest_run.status)) return job;
    if (isPaused(job.latest_run)) {
      // A paused run picks up no new task, so waiting on would only end in the
      // timeout error below. Fail the same way (same code, exit 1), now.
      throw new ToolkitError({
        code: "BATCH_FAILED",
        reason: "run_paused",
        message: `Batch job ${id} is paused, so it will not finish while it stays paused.`,
        likely_cause: `The run is ${job.latest_run!.status} with pause_state paused: no new task is picked up, though tasks already started may still finish.`,
        next_action: "Resume the run (dashboard or API), then wait again with `zenrows batch wait <id>`.",
        suggested_commands: [`zenrows batch status ${id}`],
      });
    }
    if (Date.now() > deadline) {
      throw new ToolkitError({
        code: "BATCH_FAILED",
        reason: "wait_timeout",
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
