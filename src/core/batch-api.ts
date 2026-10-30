/**
 * Client for the Zenrows Batch API.
 *
 * A SEPARATE host from Fetch and Extract (`api.zenrows.com/v1`): batch
 * jobs live at `https://async.api.zenrows.com/v1`. Auth is the `X-API-Key`
 * header (same key as Fetch and Extract), never the `apikey` query param. Bodies
 * are JSON; errors come back as `application/problem+json` (RFC 9457) with a
 * stable `code` we branch on and carry as `server_code`. The key is registered
 * as a secret so it is redacted from any logged output. `fetchImpl` is
 * injectable for tests, mirroring `usage.ts` / `agent-account.ts`.
 *
 * Retries: reads (GET, DELETE) retry 429/502/503/504 and connection errors;
 * stop, pause and resume retry 502/503/504 and connection errors, since
 * repeating them is harmless; a submit or rerun retries the same way only
 * under its `Idempotency-Key`, which `createJob` and `rerunJob` always send and
 * reuse across the retries of one call. The API keeps a key for 24 hours and
 * replays the original answer to a repeat with the same body, so a retry never
 * starts a second job or run. A keyed write that still has no answer after its
 * retries fails with `idempotency_key` set: repeating it with that key is safe.
 *
 * Not in the CLI (the API and the SDKs have them): CSV inputs, open jobs and
 * add-tasks, scheduled jobs, webhooks and HMAC keys, ZIP exports, the runs
 * list, and task history.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ToolkitError, isKeyCapReached, keyCapReached, quotaExhausted, type ErrorCode } from "./errors.ts";
import { storedClaimHint } from "./claim-link.ts";
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
  [k: string]: unknown;
}

export interface JobRun {
  status: string;
  stats: JobStats;
  run_id?: string;
  job_id?: string;
  /** Why a `failed` run stopped, e.g. `insufficient_credits` or `api_key_cap_reached`. */
  failure_reason?: string;
  /** Human-readable detail for `failure_reason`. */
  failure_detail?: string;
  /** `paused` while the run is paused; omitted while it is active. */
  pause_state?: string;
  /** `pending` while a large submit or a rerun is still receiving its tasks, then `done`. */
  ingest_status?: string;
  [k: string]: unknown;
}

export interface Job {
  job_id: string;
  /** Absent on a scheduled job that has not fired yet. */
  latest_run?: JobRun;
  /** `open | closed` (the job, not its run). */
  status?: string;
  /** Submit answers: how many tasks the API accepted. */
  accepted_tasks?: number;
  /** Rerun answers: the run this one reruns, and how its tasks were split. */
  rerun_of?: string;
  retried_tasks?: number;
  inherited_tasks?: number;
  [k: string]: unknown;
}

export interface JobsPage {
  jobs: Job[];
  next_cursor: string | null;
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

/** RFC 9457 problem body returned by the Batch API on non-2xx. */
interface ProblemJson {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  invalid_tasks?: Array<{ index: number; reason: string; value?: string }>;
}

/** Terminal run states: a run stops progressing once it reaches one of these. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "stopped", "failed", "deleted"]);

/** Result filters the API accepts on the results listing. */
export type ResultStatus = "successful" | "failed" | "processing" | "all";

/** Task statuses a rerun can select (`?status=` on `/rerun`). */
export const RERUN_STATUSES: readonly string[] = ["pending", "processing", "failed", "successful"];

/** True when the run reached a terminal state. */
export function isTerminal(run: JobRun | undefined): boolean {
  return !!run && TERMINAL_STATUSES.has(run.status);
}

/** True when a live run is paused: it picks up no new task until resumed. */
export function isPaused(run: JobRun | undefined): boolean {
  return run?.pause_state === "paused" && !isTerminal(run);
}

type RetryKind = "read" | "write";

interface CallOpts {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Per HTTP attempt. */
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * Epoch ms the whole call must end by, retries included: each attempt is cut
   * off at it and no retry starts that would sleep past it.
   */
  deadline?: number;
}

interface RequestOpts extends CallOpts {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Which failures to retry; unset means the request runs once. */
  retry?: RetryKind;
  /** Sent as `Idempotency-Key`. */
  idempotencyKey?: string;
  /** The job the request is about, carried on its errors as `job_id`. */
  jobId?: string;
}

interface RawResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

const MAX_RETRIES = 3;
/** The longest a Retry-After may make one retry wait, so a large value cannot hang a command. */
const MAX_RETRY_AFTER_SECONDS = 30;
const READ_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
// 429 on a write is an account limit (active jobs): a retry only waits for a slot that may never free.
const WRITE_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

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

/** The longest Idempotency-Key the Batch API accepts. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * Throw before any request if `key` cannot work as an Idempotency-Key: HTTP
 * strips a header's surrounding whitespace, so a blank or padded key would
 * reach the API as a different key, and control characters cannot be sent.
 */
export function assertIdempotencyKey(key: string): void {
  let reason: string | undefined;
  if (key.trim() === "") reason = "it is empty";
  else if (key !== key.trim()) reason = "it starts or ends with whitespace";
  else if (/[\u0000-\u001f\u007f]/.test(key)) reason = "it contains a control character";
  else if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) reason = `it is longer than ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`;
  if (!reason) return;
  throw new ToolkitError({
    code: "INVALID_USAGE",
    message: `Invalid --idempotency-key: ${reason}.`,
    likely_cause: `An Idempotency-Key is 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters, with no surrounding whitespace and no control characters.`,
    next_action: "Pass a key such as a UUID, or leave --idempotency-key out to have one generated.",
  });
}

/** Errors a poll may ride out: the API was unreachable or answered 429/5xx. */
const transientErrors = new WeakSet<ToolkitError>();

/** True for an error worth polling past (a connection failure, a 429 or a 5xx). */
export function isTransient(err: unknown): boolean {
  return err instanceof ToolkitError && transientErrors.has(err);
}

function transient(err: ToolkitError): ToolkitError {
  transientErrors.add(err);
  return err;
}

/** One HTTP attempt with its own timeout; the body is read inside it. */
async function attempt(url: string, init: RequestInit, opts: RequestOpts): Promise<RawResponse> {
  const controller = new AbortController();
  const perAttempt = opts.timeoutMs ?? 60_000;
  const ms = opts.deadline !== undefined ? Math.max(1, Math.min(perAttempt, opts.deadline - Date.now())) : perAttempt;
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Perform a Batch API request and return the raw response. Sets `X-API-Key`,
 * adds a JSON content-type when a body is present, retries transient failures
 * as `opts.retry` allows, and on a non-2xx parses the problem+json body into a
 * normalized ToolkitError.
 */
async function batchFetch(method: string, path: string, opts: RequestOpts): Promise<RawResponse> {
  registerSecret(opts.apiKey);
  const url = new URL(batchBase() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: "application/json",
    "User-Agent": CLI_USER_AGENT,
    ...agentClientHeader(),
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined };
  const retryOn = opts.retry === "read" ? READ_RETRY_STATUSES : opts.retry === "write" ? WRITE_RETRY_STATUSES : undefined;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const key = opts.idempotencyKey;
  // Set once an attempt of a keyed write got no answer: the API may have done the work.
  let mayHaveLanded = false;

  // A retry that would sleep past the call's deadline is not started.
  const fits = (waitMs: number) => opts.deadline === undefined || Date.now() + waitMs < opts.deadline;

  for (let n = 0; ; n++) {
    const canRetry = retryOn !== undefined && n < MAX_RETRIES;
    let res: RawResponse;
    try {
      res = await attempt(url.toString(), init, opts);
    } catch (err) {
      const wait = backoffMs(n);
      if (canRetry && fits(wait)) {
        mayHaveLanded = true;
        await sleep(wait);
        continue;
      }
      if (key) mayHaveLanded = true;
      const failure = transient(
        new ToolkitError({
          code: "BACKEND_UNAVAILABLE",
          message: "Could not reach the Zenrows Batch API.",
          likely_cause: err instanceof Error ? err.message : String(err),
          next_action:
            "Check connectivity and retry. Override the host with ZENROWS_BATCH_API_BASE if you are testing against staging.",
          suggested_commands: ["zenrows status"],
          ...(opts.jobId ? { job_id: opts.jobId } : {}),
        }),
      );
      throw key ? outcomeUnknown(failure, key) : failure;
    }
    if (canRetry && retryOn.has(res.status)) {
      const wait = retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(n);
      if (fits(wait)) {
        if (res.status >= 500) mayHaveLanded = true;
        await sleep(wait);
        continue;
      }
    }
    if (res.status < 200 || res.status >= 300) {
      let failure = problemToError(res.status, res.body.toString("utf8"), method, path, opts.jobId);
      if (res.status === 429 || res.status >= 500) failure = transient(failure);
      if (key && res.status >= 500) throw outcomeUnknown(failure, key);
      // An earlier attempt may have been accepted, and the API checks credit
      // (402) and other gates before it looks at the key: whatever this attempt
      // answers, the safe next step is still to repeat with the same key.
      if (key && mayHaveLanded) throw outcomeUnknown(failure, key, { keepAdvice: true });
      throw failure;
    }
    return res;
  }
}

/** `batchFetch` + JSON parse. Returns `null` for an empty body. */
export async function batchRequest<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
  return batchJson<T>(method, path, opts);
}

async function batchJson<T>(method: string, path: string, opts: RequestOpts): Promise<T> {
  const { status, body } = await batchFetch(method, path, opts);
  const text = body.toString("utf8");
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    const failure = new ToolkitError({
      code: "BATCH_FAILED",
      message: `The Batch API answered ${method} ${path} (HTTP ${status}) with a body that is not JSON.`,
      likely_cause: text.slice(0, 240),
      next_action: "Retry, or check the job with `zenrows batch list`.",
      ...(opts.jobId ? { job_id: opts.jobId } : {}),
    });
    throw opts.idempotencyKey ? outcomeUnknown(failure, opts.idempotencyKey) : failure;
  }
}

/**
 * A keyed write (submit or rerun) whose outcome is unknown: the API may have
 * done the work although no usable answer arrived. Carry the key and say what
 * is safe; the command layer adds the exact command to repeat.
 */
function outcomeUnknown(err: ToolkitError, key: string, opts: { keepAdvice?: boolean } = {}): ToolkitError {
  const lead = opts.keepAdvice
    ? `${err.next_action.replace(/[.\s]*$/, ".")} An earlier attempt of this request got no answer and may have been accepted. Once that is resolved, repeat it with the same Idempotency-Key (${key}) `
    : `The request may have been accepted even though no usable answer arrived. Repeat it with the same Idempotency-Key (${key}) `;
  const out = new ToolkitError({
    ...err.toJSON(),
    idempotency_key: key,
    next_action:
      lead +
      "within 24 hours: the API then answers with the original job or run instead of creating a second one. " +
      "Do not repeat it with a new key, which can create a duplicate. Check `zenrows batch list` first.",
  });
  return isTransient(err) ? transient(out) : out;
}

/** `s` without a trailing period, so sentences can be joined. */
function trimDot(s: string): string {
  return s.replace(/[.\s]+$/, "");
}

/** The error for an account whose subscription is not active (401 subscription_inactive, 402 expired). */
export function subscriptionInactive(cause: string): ToolkitError {
  // Same AUTH_INVALID code as any 401 so callers that branch on it keep
  // working; only the guidance changes, since re-entering the key won't help.
  return new ToolkitError({
    code: "AUTH_INVALID",
    message: "Zenrows refused the Batch API request because the subscription is not active.",
    likely_cause: `${trimDot(cause)}. The API key is valid, but the subscription is expired, past due, unpaid, incomplete or paused.`,
    next_action: `Fix the subscription in Billing (${BILLING_URL}), or in Azure Marketplace if you subscribed there, then retry.`,
  });
}

/** Map a problem+json body + HTTP status to a normalized ToolkitError carrying `server_code` and `job_id`. */
function problemToError(status: number, text: string, method: string, path: string, jobId?: string): ToolkitError {
  let problem: ProblemJson = {};
  try {
    problem = JSON.parse(text) as ProblemJson;
  } catch {
    // non-JSON error body: fall through with an empty problem
  }
  const serverCode = problem.code || undefined;
  const detail = trimDot(problem.detail || problem.title || text.slice(0, 240) || `HTTP ${status}`);
  const cause = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""} for ${method} ${path}: ${detail}.`;
  const err = classifyProblem(status, problem, detail, cause, serverCode, method, path, jobId ?? "<id>");
  return new ToolkitError({
    ...err.toJSON(),
    ...(serverCode ? { server_code: serverCode } : {}),
    ...(jobId ? { job_id: jobId } : {}),
  });
}

function classifyProblem(
  status: number,
  problem: ProblemJson,
  detail: string,
  cause: string,
  serverCode: string | undefined,
  method: string,
  path: string,
  id: string,
): ToolkitError {
  const err = (code: ErrorCode, message: string, next_action: string, suggested_commands?: string[], likely = cause) =>
    new ToolkitError({ code, message, likely_cause: likely, next_action, suggested_commands });

  if (status === 403) {
    return err(
      "BATCH_ACCESS_DENIED",
      "The Batch API rejected this request (access denied).",
      "Check that your Zenrows API key is active, and contact Zenrows support if the 403 persists. Meanwhile validate/estimate specs locally and fan out with `zenrows fetch` per URL.",
      ["zenrows batch estimate jobs.jsonl"],
      `${cause} Batch is not enabled for this account or API key.`,
    );
  }
  if (status === 401 && serverCode === "subscription_inactive") return subscriptionInactive(cause);
  if (status === 401) {
    return err("AUTH_INVALID", "Zenrows rejected the API key for the Batch API.", "Re-check your key and log in again.", [
      "zenrows login --api-key <your-key>",
    ]);
  }
  if (status === 404) {
    const task = /\/tasks\//.test(path);
    return err(
      "BATCH_NOT_FOUND",
      task ? "Batch job, run or task not found." : "Batch job or run not found.",
      task
        ? `Check the ids. List the job's task ids with \`zenrows batch results ${id}\`.`
        : "Check the job id, or list your jobs with `zenrows batch list`.",
      [task ? `zenrows batch results ${id}` : "zenrows batch list"],
      `${cause} The id may be wrong, the job deleted, or not owned by this account.`,
    );
  }
  if (status === 429) {
    if (/scheduled job/i.test(detail)) {
      return err(
        "BATCH_QUOTA_EXCEEDED",
        "The account has reached its limit of scheduled jobs.",
        "Nothing was created. A scheduled job holds its slot until it is deleted, whatever its runs do: delete one you no longer need, then retry.",
        ["zenrows batch list --type scheduled", "zenrows batch delete <id> --yes"],
        `${cause} The account holds 5 scheduled jobs at most by default.`,
      );
    }
    if (/task cap/i.test(detail)) {
      return err(
        "BATCH_QUOTA_EXCEEDED",
        "The open job has reached its task cap.",
        "Nothing was added. An open job holds 100,000 tasks at most: close it and start a new job for the rest.",
      );
    }
    return err(
      "BATCH_QUOTA_EXCEEDED",
      "The account has reached its limit of active jobs.",
      "Nothing was created. Active jobs are shared with Crawl. A closed job frees its slot when its run ends: wait for one (`zenrows batch wait <id>`) or stop it (`zenrows batch cancel <id>`). An open or scheduled job frees it only when deleted (`zenrows batch delete <id> --yes`). Then retry.",
      ["zenrows batch list", "zenrows crawl list"],
      `${cause} The account holds 3 active jobs at most by default, Batch and Crawl together.`,
    );
  }
  if (status === 402 && isKeyCapReached(serverCode)) {
    return keyCapReached(`${method} ${path}`, { status: 402, detail: problem.detail || problem.title || undefined });
  }
  if (status === 402 && /subscription has expired/i.test(detail)) return subscriptionInactive(cause);
  if (status === 402) {
    // Out of credits ("Subscription has no credit available"): the same
    // exhausted state as the scraper/usage 402, with a claim link (unclaimed
    // Free plan) or dashboard/upgrade pointer.
    const acct = readAccount();
    return quotaExhausted(`${method} ${path}`, storedClaimHint(acct), {
      status: 402,
      detail: problem.detail || problem.title || undefined,
    });
  }
  if (status === 409) return conflictError(serverCode, detail, cause, id);
  if (status === 410) {
    return err(
      "BATCH_RESULT_EXPIRED",
      "This result has expired.",
      `Results are kept 14 days by default; after that a task reads as expired and its body is gone. Scrape it again with a full rerun: \`zenrows batch rerun ${id} --all\`.`,
      [`zenrows batch rerun ${id} --all`],
    );
  }
  if (status === 422 && /\/content$/.test(path)) {
    return err(
      "BATCH_TASK_FAILED",
      "This task failed, so it has no content.",
      `Read why in its result row (\`zenrows batch results ${id} --status failed\`), then rerun the failures with \`zenrows batch retry-failed ${id}\`.`,
      [`zenrows batch results ${id} --status failed`],
    );
  }

  // 400 invalid_argument, 501, 5xx, etc.
  const invalid = problem.invalid_tasks?.length
    ? ` invalid_tasks: ${problem.invalid_tasks
        .slice(0, 10)
        .map((t) => `#${t.index}: ${t.reason}${t.value ? ` (${t.value})` : ""}`)
        .join("; ")}`
    : "";
  return err(
    "BATCH_FAILED",
    `Batch request failed (HTTP ${status}).`,
    status === 501
      ? "This operation is not available for this job."
      : status >= 500
        ? "This is transient: retry with a short backoff."
        : "Fix the reported problem and retry. For validation errors, correct the flagged tasks (#n is the task's 0-based position in the submit).",
    undefined,
    `${cause}${invalid}`,
  );
}

/** One code and next action per 409 the Batch API answers. */
function conflictError(serverCode: string | undefined, detail: string, cause: string, id: string): ToolkitError {
  const e = (code: ErrorCode, message: string, next_action: string, suggested_commands: string[] = [`zenrows batch status ${id}`]) =>
    new ToolkitError({ code, message, likely_cause: cause, next_action, suggested_commands });
  switch (serverCode) {
    case "run_not_terminal":
      if (/ingestion did not complete/i.test(detail)) {
        return e(
          "BATCH_RUN_IN_PROGRESS",
          "The job's last run never finished receiving its tasks.",
          `It cannot be rerun. Delete the job (\`zenrows batch delete ${id} --yes\`) and submit the URLs again as a new job.`,
        );
      }
      return e(
        "BATCH_RUN_IN_PROGRESS",
        "The job's current run is still in progress.",
        `Wait for it with \`zenrows batch wait ${id}\`, or stop it with \`zenrows batch cancel ${id}\`, then retry. A large submit or a rerun also reads as in progress while it is still receiving its tasks.`,
        [`zenrows batch wait ${id}`],
      );
    case "run_not_stoppable":
      return e(
        "BATCH_RUN_ENDED",
        "The job's run already ended.",
        `Only a pending or running run can be stopped, paused or resumed. Start a new run with \`zenrows batch rerun ${id}\`.`,
      );
    case "no_matching_tasks":
      return e(
        "BATCH_NO_MATCHING_TASKS",
        "No task of the last run has the statuses you asked to rerun.",
        `Tasks a stop or a credit failure left unfinished are pending or processing: rerun them with \`zenrows batch rerun ${id} --status failed,pending,processing\`, or rerun every task with \`zenrows batch rerun ${id} --all\`.`,
        [`zenrows batch rerun ${id} --status failed,pending,processing`],
      );
    case "partial_rerun_window_expired":
      return e(
        "BATCH_RERUN_WINDOW_EXPIRED",
        "Rerunning only some tasks is no longer allowed for this run.",
        `A partial rerun (the default, or --status) works for 10 days after the run started. Rerun every task with \`zenrows batch rerun ${id} --all\` instead.`,
        [`zenrows batch rerun ${id} --all`],
      );
    case "idempotency_key_conflict":
      return e(
        "BATCH_REQUEST_IN_FLIGHT",
        "This Idempotency-Key is already in use.",
        "Either the first request with this key is still being processed, or the key was used for a different request body. Wait a moment and repeat the same command with the same key; use a new key only for a deliberately different request.",
        ["zenrows batch list"],
      );
    case "task_not_ready":
      return e(
        "BATCH_TASK_NOT_READY",
        "This task has not finished yet.",
        `Wait for the run with \`zenrows batch wait ${id}\`, then read the task again.`,
        [`zenrows batch wait ${id}`],
      );
    case "conflict":
      if (/no longer valid/i.test(detail)) {
        return e(
          "BATCH_CONFLICT",
          "The API key that created this job no longer works.",
          "The job cannot run again. Submit its URLs as a new job.",
          [],
        );
      }
      return e("BATCH_CONFLICT", "The job changed while the request ran.", "Retry the same command.");
    default:
      return e(
        "BATCH_CONFLICT",
        "The job's state does not allow this request.",
        `Check the job with \`zenrows batch status ${id}\`; the cause above says what blocked it.`,
      );
  }
}

const jobPath = (id: string, rest = "") => `/jobs/${encodeURIComponent(id)}${rest}`;

/**
 * Create a job. Both 201 (tasks stored) and 202 (a large submit, still
 * receiving its tasks: `latest_run.ingest_status` is `pending`) are success.
 */
export function createJob(body: unknown, opts: CallOpts & { idempotencyKey?: string }): Promise<Job> {
  const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
  assertIdempotencyKey(idempotencyKey);
  return batchJson<Job>("POST", "/jobs", { ...opts, body, idempotencyKey, retry: "write" });
}

/** Read a job (`latest_run.status` + `latest_run.stats`). */
export function getJob(id: string, opts: CallOpts): Promise<Job> {
  return batchJson<Job>("GET", jobPath(id), { ...opts, retry: "read", jobId: id });
}

/** Read one run of a job. */
export function getRun(id: string, runId: string, opts: CallOpts): Promise<JobRun> {
  return batchJson<JobRun>("GET", jobPath(id, `/runs/${encodeURIComponent(runId)}`), { ...opts, retry: "read", jobId: id });
}

/** One page of the account's jobs, newest first. */
export async function listJobs(
  opts: CallOpts & { limit?: number; cursor?: string; status?: string; type?: string },
): Promise<JobsPage> {
  const page = await batchJson<Partial<JobsPage> | null>("GET", "/jobs", {
    ...opts,
    retry: "read",
    query: { limit: opts.limit, cursor: opts.cursor, status: opts.status, type: opts.type },
  });
  return { jobs: page?.jobs ?? [], next_cursor: page?.next_cursor || null };
}

/** Stop the job's in-flight run. The API answers with the refreshed run, not the job. */
export function stopJob(id: string, opts: CallOpts): Promise<JobRun> {
  return batchJson<JobRun>("POST", jobPath(id, "/stop"), { ...opts, retry: "write", jobId: id });
}

/** Pause the job's in-flight run: no new task is picked up until it is resumed. Answers with the run. */
export function pauseJob(id: string, opts: CallOpts): Promise<JobRun> {
  return batchJson<JobRun>("POST", jobPath(id, "/pause"), { ...opts, retry: "write", jobId: id });
}

/** Resume a paused run. Needs credit on the job's API key. Answers with the run. */
export function resumeJob(id: string, opts: CallOpts): Promise<JobRun> {
  return batchJson<JobRun>("POST", jobPath(id, "/resume"), { ...opts, retry: "write", jobId: id });
}

/**
 * Delete a job, its runs and its stored results (202, asynchronous). Stops an
 * in-flight run and frees the job's slot. Repeating it is harmless.
 */
export async function deleteJob(id: string, opts: CallOpts): Promise<void> {
  await batchFetch("DELETE", jobPath(id), { ...opts, retry: "read", jobId: id });
}

/**
 * Start a new run of a job. With no `status`, every task runs again (a full
 * rerun). `status` is a comma-separated list of task statuses to rerun
 * (`pending,processing,failed,successful`); the rest carry over from the
 * previous run. After a stop or a credit failure, unstarted tasks stay
 * `pending` and tasks cut off mid-flight can stay `processing`, so
 * `failed,pending,processing` recovers everything that did not succeed.
 */
export function rerunJob(id: string, opts: CallOpts & { status?: string; idempotencyKey?: string }): Promise<Job> {
  const idempotencyKey = opts.idempotencyKey ?? newIdempotencyKey();
  assertIdempotencyKey(idempotencyKey);
  return batchJson<Job>("POST", jobPath(id, "/rerun"), {
    ...opts,
    query: opts.status ? { status: opts.status } : undefined,
    idempotencyKey,
    retry: "write",
    jobId: id,
  });
}

/**
 * List all result rows of the latest run (or `runId`), following `next_cursor`
 * until it is null.
 */
export async function listResults(
  id: string,
  opts: CallOpts & { status?: ResultStatus; runId?: string },
): Promise<ResultRow[]> {
  const path = opts.runId ? jobPath(id, `/runs/${encodeURIComponent(opts.runId)}/results`) : jobPath(id, "/results");
  const all: ResultRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await batchJson<ResultsPage | null>("GET", path, {
      ...opts,
      retry: "read",
      jobId: id,
      query: { status: opts.status, cursor },
    });
    if (page?.results) all.push(...page.results);
    cursor = page?.next_cursor ?? undefined;
  } while (cursor);
  return all;
}

/** One task's result body (latest run, or `runId`), as returned by the content endpoint. */
export async function getTaskContent(
  id: string,
  taskId: string,
  opts: CallOpts & { runId?: string },
): Promise<{ contentType: string; body: Buffer }> {
  const task = `/tasks/${encodeURIComponent(taskId)}/content`;
  const path = opts.runId ? jobPath(id, `/runs/${encodeURIComponent(opts.runId)}${task}`) : jobPath(id, task);
  const res = await batchFetch("GET", path, { ...opts, retry: "read", jobId: id });
  return { contentType: res.headers.get("content-type") ?? "", body: res.body };
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

/** Why a row has no body to download. */
function skipReason(row: ResultRow): string {
  if (row.status === "failed") return "task failed: no result body";
  if (row.status === "expired") return "result expired (kept 14 days by default): a full rerun (--all) scrapes it again";
  if (row.status === "pending" || row.status === "processing") return "task not finished yet";
  return "no result_url";
}

/**
 * Stream each result body into its own file under `dir` (created if needed),
 * plus a self-describing `_manifest.jsonl` index (result_url dropped: it is a
 * short-lived presigned link). Fetches run `concurrency` at a time and a single
 * failure never aborts the rest: per-task outcomes come back in the result.
 *
 * Only tasks with a `result_url` have a body to fetch; failed, expired and
 * unfinished tasks are reported as `skipped`. The presigned links are valid for
 * 2 hours, so download soon after `listResults`. Deliberately opt-in (not the
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
        outcome.skipped.push({ ...ref, reason: skipReason(row) });
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
    delete rest.result_url; // expires: the local `file` is the durable pointer
    return { ...rest, file: fileByTask.get(r.task_id) ?? null };
  });
  writeFileSync(
    join(dir, "_manifest.jsonl"),
    manifest.map((m) => JSON.stringify(m)).join("\n") + (manifest.length ? "\n" : ""),
  );
  return outcome;
}

/**
 * Poll `GET /jobs/{id}` until the latest run is terminal, the run is paused (a
 * paused run never progresses, so the wait returns at once), or `waitMs`
 * (default 10 minutes) runs out, backing off 2s, x1.5, capped at 15s. Returns
 * the last job read in every case; the caller tells them apart with
 * `isTerminal` / `isPaused`. A transient error (connection, 429, 5xx) is
 * ridden out until the deadline. `sleepImpl` is injectable for tests.
 */
export async function waitForJob(id: string, opts: CallOpts & { waitMs?: number }): Promise<Job> {
  const sleep = opts.sleepImpl ?? defaultSleep;
  const deadline = Date.now() + (opts.waitMs ?? 600_000);
  let delay = 2000;
  const read = { ...opts, deadline };
  let last: Job | undefined;
  let lastErr: unknown;
  for (;;) {
    try {
      last = await getJob(id, read);
      if (isTerminal(last.latest_run) || isPaused(last.latest_run)) return last;
    } catch (err) {
      if (!isTransient(err)) throw err;
      lastErr = err;
    }
    if (Date.now() + delay >= deadline) {
      // Out of time: report the last state read, or the error if none was.
      if (!last) throw lastErr;
      return last;
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15_000);
  }
}
