/**
 * Batch Jobs adapter.
 *
 * Status: `available`. The cloud subcommands call the Batch API with an API key
 * (see `core/batch-api.ts`); a 403 maps to BATCH_ACCESS_DENIED. This adapter owns
 * the local, no-network pieces: validating a JSONL job spec against the API's
 * limits, estimating credit cost, and mapping the validated spec to the Batch
 * API request body.
 */
import { existsSync, readFileSync } from "node:fs";
import { ToolkitError } from "../core/errors.ts";

/** Per-task keys sent at task level; everything else on a line is a scrape param. */
const TASK_RESERVED = new Set(["url", "external_id", "metadata", "zenrows_params", "method", "body"]);

/** The API's limits on a task and on job-level fields. */
export const LIMITS = {
  urlLength: 2048,
  externalIdLength: 128,
  metadataEntries: 20,
  metadataKeyLength: 64,
  metadataValueLength: 1024,
  metadataTotalBytes: 4 * 1024,
  bodyBytes: 16 * 1024,
  nameLength: 100,
} as const;

/** `external_id` and metadata keys: letters, digits, `.`, `_` and `-`. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export interface BatchJob {
  url: string;
  /** Optional id echoed back on each result row (not required to be unique). */
  external_id?: string;
  /** Per-task string-to-string metadata carried through to results. */
  metadata?: Record<string, string>;
  /** Optional nested per-task scrape params (merged with the flat keys below). */
  zenrows_params?: Record<string, unknown>;
  /** `GET` (default) or `POST`. */
  method?: string;
  /** POST body: a JSON string is sent verbatim as a form body, any other JSON value as JSON. */
  body?: unknown;
  /** Optional per-task overrides mirroring fetch options. */
  js_render?: boolean | string;
  premium_proxy?: boolean | string;
  proxy_country?: string;
  mode?: string;
  autoparse?: boolean | string;
  [k: string]: unknown;
}

export interface BatchValidation {
  totalLines: number;
  validJobs: number;
  errors: Array<{ line: number; reason: string }>;
  jobs: BatchJob[];
}

/** Parse + validate a JSONL job spec locally, against the API's per-task limits. */
export function validateJsonl(file: string): BatchValidation {
  if (!existsSync(file)) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Job spec not found: ${file}`,
      likely_cause: "The path to the JSONL file is wrong or the file does not exist.",
      next_action: "Create a JSONL file with one JSON object per line, each containing a `url`.",
    });
  }
  const raw = readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/);
  const result: BatchValidation = { totalLines: 0, validJobs: 0, errors: [], jobs: [] };
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    result.totalLines++;
    let obj: BatchJob;
    try {
      obj = JSON.parse(trimmed) as BatchJob;
    } catch {
      result.errors.push({ line: idx + 1, reason: "invalid JSON" });
      return;
    }
    const reason = taskError(obj);
    if (reason) {
      result.errors.push({ line: idx + 1, reason });
      return;
    }
    result.validJobs++;
    result.jobs.push(obj);
  });
  return result;
}

/** Why one JSONL line would be rejected by the API, or null when it is valid. */
function taskError(obj: unknown): string | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return "a line must be a JSON object";
  const job = obj as BatchJob;
  if (!job.url || typeof job.url !== "string") return "missing string `url`";
  let u: URL;
  try {
    u = new URL(job.url);
  } catch {
    return `invalid url: ${job.url}`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return `url must be http or https: ${job.url}`;
  // The API counts these limits in UTF-8 bytes, not characters.
  if (Buffer.byteLength(job.url) > LIMITS.urlLength) return `url is longer than ${LIMITS.urlLength} bytes`;
  if (job.external_id !== undefined && job.external_id !== null) {
    const e = externalIdError(job.external_id);
    if (e) return e;
  }
  const meta = metadataError(job.metadata);
  if (meta) return meta;
  if (job.zenrows_params !== undefined && (typeof job.zenrows_params !== "object" || job.zenrows_params === null || Array.isArray(job.zenrows_params))) {
    return "`zenrows_params` must be an object";
  }
  return methodBodyError(job.method, job.body);
}

/** Why an `external_id` is invalid, or null. Numbers are sent as their string form. */
export function externalIdError(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return "`external_id` must be a string";
  const s = String(v);
  if (s.length === 0 || s.length > LIMITS.externalIdLength) return `\`external_id\` must be 1 to ${LIMITS.externalIdLength} characters`;
  if (!SAFE_ID.test(s)) return "`external_id` may only use letters, digits, `.`, `_` and `-`";
  return null;
}

/**
 * Why `metadata` is invalid, or null: the API takes at most 20 string-to-string
 * entries, keys of 1 to 64 safe characters, values up to 1024 bytes, 4 KiB
 * in total. Any other shape fails the whole submit.
 */
export function metadataError(metadata: unknown): string | null {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) return "`metadata` must be an object of string values";
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length > LIMITS.metadataEntries) return `\`metadata\` has more than ${LIMITS.metadataEntries} entries`;
  let total = 0;
  for (const [k, v] of entries) {
    if (k.length === 0 || k.length > LIMITS.metadataKeyLength || !SAFE_ID.test(k)) {
      return `\`metadata\` key "${k}" must be 1 to ${LIMITS.metadataKeyLength} letters, digits, \`.\`, \`_\` or \`-\``;
    }
    if (typeof v !== "string") return `\`metadata.${k}\` must be a string`;
    if (Buffer.byteLength(v) > LIMITS.metadataValueLength) return `\`metadata.${k}\` is longer than ${LIMITS.metadataValueLength} bytes`;
    total += Buffer.byteLength(k) + Buffer.byteLength(v);
  }
  if (total > LIMITS.metadataTotalBytes) return "`metadata` is larger than 4 KiB";
  return null;
}

/** Why `method` / `body` are invalid, or null. Only GET and POST exist; a body needs POST. */
function methodBodyError(method: unknown, body: unknown): string | null {
  if (method !== undefined && method !== null) {
    if (typeof method !== "string" || !/^(get|post)$/i.test(method)) return "`method` must be GET or POST";
  }
  if (body === undefined || body === null) return null;
  if (!isPost(method)) return "`body` needs `\"method\": \"POST\"`";
  const bytes = typeof body === "string" ? Buffer.byteLength(body) : Buffer.byteLength(JSON.stringify(body));
  if (bytes > LIMITS.bodyBytes) return `\`body\` is larger than ${LIMITS.bodyBytes / 1024} KiB`;
  return null;
}

function isPost(method: unknown): boolean {
  return typeof method === "string" && method.toUpperCase() === "POST";
}

/**
 * Scrape params the API reads as booleans. It accepts JSON `true`/`false` or the
 * strings "true"/"false" in any case, and rejects anything else with a 400.
 */
const BOOLEAN_PARAMS = new Set(["js_render", "premium_proxy", "original_status", "json_response", "autoparse"]);

/** JSON `true` and "true" in any case become "true"; likewise "false". Any other value is unchanged. */
function canonicalBool(v: unknown): unknown {
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "false") return s;
  }
  return v;
}

/** A task's own params: its nested `zenrows_params`, then its flat keys (later wins). */
function taskParamsOf(job: BatchJob): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(job)) {
    if (!TASK_RESERVED.has(k)) flat[k] = v;
  }
  return { ...(job.zenrows_params ?? {}), ...flat };
}

/**
 * The params a task actually runs with: the job-level params and the task's
 * own, each canonicalized exactly as submitted, merged the way the API merges
 * them (the task wins on a shared key). A task key set to null is not
 * submitted, so the job's value applies.
 */
export function effectiveParams(job: BatchJob, jobParams: Record<string, unknown> = {}): Record<string, string> {
  return { ...normalizeParams(jobParams), ...normalizeParams(taskParamsOf(job)) };
}

/**
 * Local credit estimate from the rate card: basic 1, js_render 5,
 * premium_proxy 10, both 25. An Adaptive Stealth Mode task (`mode=auto`)
 * costs 1 to 25 depending on what each page needs, so it counts 1 in `min`
 * and 25 in `credits` (the upper bound). Each task is priced on the params
 * it is submitted with, job-level flags included.
 */
export function estimateCredits(
  jobs: BatchJob[],
  jobParams: Record<string, unknown> = {},
): { credits: number; min: number; perJob: number[] } {
  let min = 0;
  const perJob = jobs.map((j) => {
    const p = effectiveParams(j, jobParams);
    if (p.mode === "auto") {
      min += 1;
      return 25;
    }
    const js = p.js_render === "true";
    const proxy = p.premium_proxy === "true";
    const cost = js && proxy ? 25 : proxy ? 10 : js ? 5 : 1;
    min += cost;
    return cost;
  });
  return { credits: perJob.reduce((a, b) => a + b, 0), min, perJob };
}

/**
 * Adaptive Stealth Mode (mode=auto) by default, like `fetch` and `extract`: returns
 * the jobs with `mode: "auto"` on every line that doesn't force `js_render` /
 * `premium_proxy` or set `mode` itself, and none at all when the job-level params
 * force either flag. Applied per task rather than job-level because the API rejects
 * a task that combines a job-level mode=auto with its own js_render or
 * premium_proxy (REQS004). A POST task is left alone: Adaptive Stealth Mode may
 * turn on JavaScript rendering, which a POST cannot use.
 */
export function withAdaptiveStealth(jobs: BatchJob[], jobParams: Record<string, unknown> = {}): BatchJob[] {
  const forced = (p: Record<string, unknown>) => isTruthyFlag(p.js_render) || isTruthyFlag(p.premium_proxy);
  if (forced(jobParams) || jobParams.mode != null) return jobs;
  return jobs.map((job) => {
    if (isPost(job.method)) return job;
    const own = taskParamsOf(job);
    if (forced(own) || own.mode != null) return job;
    return { ...job, mode: "auto" };
  });
}

/** Job-level fields of a submit other than its params. */
export interface JobFields {
  name?: string;
  external_id?: string;
  metadata?: Record<string, string>;
}

/** Body for `POST /jobs` (closed, all-URLs-up-front job). */
export interface JobBody extends JobFields {
  type: "regular";
  status: "closed";
  zenrows_params?: Record<string, string>;
  tasks: Array<{
    url: string;
    external_id?: string;
    metadata?: Record<string, string>;
    method?: string;
    body?: unknown;
    zenrows_params?: Record<string, string>;
  }>;
}

/**
 * Map a validated JSONL spec + job-level flags to the Batch API request body.
 * The flat per-line options (`js_render`, `premium_proxy`, `proxy_country`,
 * `autoparse`, `mode`, …) plus any nested `zenrows_params` become that task's
 * `zenrows_params`; `jobParams` (from CLI flags) becomes the job-level
 * `zenrows_params`. `url`, `external_id`, `metadata`, `method` and `body` are
 * task fields and map straight through.
 *
 * Checked here, before submitting, on the effective (job + task) params:
 * boolean params hold true or false; `proxy_country` needs `premium_proxy`
 * unless mode=auto (PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM, mirroring
 * `protected-fetch.ts::validateAutoManual`); a POST task does not turn on
 * `js_render`, `js_instructions` or `json_response`, which the API rejects.
 */
export function toJobBody(jobs: BatchJob[], jobParams: Record<string, unknown> = {}, fields: JobFields = {}): JobBody {
  const tasks = jobs.map((job, idx) => {
    const { url, external_id, metadata } = job;
    const where = `line ${idx + 1} (${url})`;
    const effective = effectiveParams(job, jobParams);
    assertBooleanParams(effective, where);
    assertProxyCountryPremium(effective, where);

    const task: JobBody["tasks"][number] = { url };
    if (external_id !== undefined && external_id !== null) task.external_id = String(external_id);
    if (metadata !== undefined && metadata !== null) task.metadata = metadata;
    if (isPost(job.method)) {
      assertPostParams(effective, where);
      task.method = "POST";
      if (job.body !== undefined && job.body !== null) task.body = job.body;
    }
    const zp = normalizeParams(taskParamsOf(job));
    if (Object.keys(zp).length) task.zenrows_params = zp;
    return task;
  });

  const body: JobBody = { type: "regular", status: "closed", tasks };
  if (fields.name) body.name = fields.name;
  if (fields.external_id) body.external_id = fields.external_id;
  if (fields.metadata && Object.keys(fields.metadata).length) body.metadata = fields.metadata;
  const jobZp = normalizeParams(jobParams);
  if (Object.keys(jobZp).length) body.zenrows_params = jobZp;
  return body;
}

/**
 * Coerce a flat options object into the string-valued map the Batch API expects
 * (`zenrows_params` values are strings, e.g. `"true"`, `"us"`). Boolean params
 * are canonicalized to "true"/"false"; other booleans/numbers are stringified;
 * objects are JSON-encoded; nullish is dropped.
 */
function normalizeParams(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(obj)) {
    if (raw === undefined || raw === null) continue;
    const v = BOOLEAN_PARAMS.has(k) ? canonicalBool(raw) : raw;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "boolean" || typeof v === "number") out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}

/** True when the params opt into Adaptive Stealth Mode (mode=auto). */
function isAutoMode(v: unknown): boolean {
  return v === "auto" || v === true;
}
function isTruthyFlag(v: unknown): boolean {
  return canonicalBool(v) === "true";
}

/** Throw before submitting if a boolean param holds a value the API rejects. */
function assertBooleanParams(params: Record<string, string>, where: string): void {
  for (const k of BOOLEAN_PARAMS) {
    const v = params[k];
    if (v !== undefined && v !== "true" && v !== "false") {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: `${k} must be true or false (got ${JSON.stringify(v)}) in ${where}.`,
        likely_cause: `The Batch API accepts only true or false for ${k}; any other value fails the whole job.`,
        next_action: `Set ${k} to true or false on that line, then retry.`,
      });
    }
  }
}

/** Throw if a POST task would turn on a param the API refuses with POST (method_param_conflict). */
function assertPostParams(params: Record<string, string>, where: string): void {
  const conflict = params.js_render === "true" ? "js_render" : params.json_response === "true" ? "json_response" : params.js_instructions ? "js_instructions" : undefined;
  if (!conflict) return;
  throw new ToolkitError({
    code: "INVALID_USAGE",
    message: `A POST task cannot use ${conflict}: ${where}.`,
    likely_cause: "POST tasks run without a browser, so the Batch API rejects js_render, js_instructions and json_response on them (method_param_conflict).",
    next_action: "Drop that param from the line (or the job-level --js-render flag), or send the task as GET.",
  });
}

/** Throw if proxy_country is set without premium_proxy and outside auto mode. */
function assertProxyCountryPremium(params: Record<string, unknown>, where: string): void {
  if (!params.proxy_country) return;
  if (isAutoMode(params.mode) || isTruthyFlag(params.premium_proxy)) return;
  throw new ToolkitError({
    code: "PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM",
    message: `proxy_country needs premium proxies (or mode=auto) — ${where}.`,
    likely_cause:
      "Batch only geolocates the proxy when premium_proxy=true, or in Adaptive Stealth Mode (mode=auto).",
    next_action:
      "Add premium_proxy (10x cost) alongside proxy_country, or set mode=auto — geo-targeting works there without the flag.",
    suggested_commands: ["zenrows batch create jobs.jsonl --premium-proxy --proxy-country us"],
  });
}
