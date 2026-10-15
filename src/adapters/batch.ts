/**
 * Batch Jobs adapter.
 *
 * Status: `available`. The cloud subcommands call the Batch API with an API key
 * (see `core/batch-api.ts`); a 403 maps to BATCH_ACCESS_DENIED. This adapter owns
 * the local, no-network pieces: validating a JSONL job spec, estimating credit
 * cost, and mapping the validated spec to the Batch API request body.
 */
import { existsSync, readFileSync } from "node:fs";
import { ToolkitError } from "../core/errors.ts";

/** Per-task keys handled explicitly; everything else on a line is a scrape param. */
const TASK_RESERVED = new Set(["url", "external_id", "metadata", "zenrows_params"]);

export interface BatchJob {
  url: string;
  /** Optional stable id echoed back on each result row. */
  external_id?: string;
  /** Per-task string-to-string metadata carried through to results. */
  metadata?: Record<string, string>;
  /** Optional nested per-task scrape params (merged with the flat keys below). */
  zenrows_params?: Record<string, unknown>;
  /** Optional per-job overrides mirroring fetch options. */
  js_render?: boolean;
  premium_proxy?: boolean;
  proxy_country?: string;
  mode?: string;
  autoparse?: boolean;
  [k: string]: unknown;
}

export interface BatchValidation {
  totalLines: number;
  validJobs: number;
  errors: Array<{ line: number; reason: string }>;
  jobs: BatchJob[];
}

/** Parse + validate a JSONL job spec locally. */
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
    try {
      const obj = JSON.parse(trimmed) as BatchJob;
      if (!obj.url || typeof obj.url !== "string") {
        result.errors.push({ line: idx + 1, reason: "missing string `url`" });
        return;
      }
      try {
        new URL(obj.url);
      } catch {
        result.errors.push({ line: idx + 1, reason: `invalid url: ${obj.url}` });
        return;
      }
      const metaError = metadataError(obj.metadata);
      if (metaError) {
        result.errors.push({ line: idx + 1, reason: metaError });
        return;
      }
      result.validJobs++;
      result.jobs.push(obj);
    } catch {
      result.errors.push({ line: idx + 1, reason: "invalid JSON" });
    }
  });
  return result;
}

/**
 * The API accepts `metadata` only as an object whose values are strings; any
 * other shape fails the whole submit. Returns the reason, or null when valid.
 */
function metadataError(metadata: unknown): string | null {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return "`metadata` must be an object of string values";
  }
  for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
    if (typeof v !== "string") return `\`metadata.${k}\` must be a string`;
  }
  return null;
}

/**
 * Scrape params the API reads as booleans. It accepts JSON `true`/`false` or the
 * strings "true"/"false" in any case (it lowercases them), and rejects anything
 * else, `1` and "yes" included, with a 400.
 */
const BOOLEAN_PARAMS = new Set(["js_render", "premium_proxy", "original_status", "json_response", "autoparse"]);

/**
 * Canonical spelling of a boolean param: JSON `true` and "true" in any case
 * become "true", JSON `false` and "false" in any case become "false". Any other
 * value is returned unchanged (see `assertBooleanParams`, which rejects it).
 */
function canonicalBool(v: unknown): unknown {
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "false") return s;
  }
  return v;
}

/** Throw before submitting if a boolean param holds a value the API rejects. */
function assertBooleanParams(params: Record<string, string>, where: string): void {
  for (const k of BOOLEAN_PARAMS) {
    const v = params[k];
    if (v !== undefined && v !== "true" && v !== "false") {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: `${k} must be true or false (got ${JSON.stringify(v)}) in ${where}.`,
        likely_cause: `The Batch API accepts only true or false for ${k}; other values, 1 and "yes" included, fail the whole job.`,
        next_action: `Set ${k} to true or false on that line, then retry.`,
      });
    }
  }
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
 * The params a task actually runs with: the job-level params and the task's own,
 * each canonicalized exactly as they are submitted (`normalizeParams`), merged
 * the way the API merges them (the task wins on a shared key). A task key set
 * to null is not submitted, so the job's value applies.
 */
export function effectiveParams(job: BatchJob, jobParams: Record<string, unknown> = {}): Record<string, string> {
  return { ...normalizeParams(jobParams), ...normalizeParams(taskParamsOf(job)) };
}

/**
 * Local credit estimate, an upper bound, from the documented rate card: basic
 * 1, js_render 5, premium_proxy 10, both 25. `mode=auto` costs 1 to 25
 * depending on what each page needs, so it counts as 25. Each task is priced on
 * the params it is submitted with (`effectiveParams`), so job-level flags count.
 */
export function estimateCredits(
  jobs: BatchJob[],
  jobParams: Record<string, unknown> = {},
): { credits: number; perJob: number[] } {
  const perJob = jobs.map((j) => {
    const p = effectiveParams(j, jobParams);
    if (p.mode === "auto") return 25;
    const js = p.js_render === "true";
    const proxy = p.premium_proxy === "true";
    if (js && proxy) return 25;
    if (proxy) return 10;
    if (js) return 5;
    return 1;
  });
  return { credits: perJob.reduce((a, b) => a + b, 0), perJob };
}

/**
 * The estimate earlier versions used, kept only for the policy credit cap so a
 * run that passed the cap before still passes: flat per-line flags only, with
 * JavaScript truthiness. Use `estimateCredits` for the real estimate.
 */
export function legacyEstimateCredits(jobs: BatchJob[]): { credits: number; perJob: number[] } {
  const perJob = jobs.map((j) => {
    const js = j.js_render || j.mode === "auto";
    const proxy = j.premium_proxy || j.mode === "auto";
    if (js && proxy) return 25;
    if (proxy) return 10;
    if (js) return 5;
    return 1;
  });
  return { credits: perJob.reduce((a, b) => a + b, 0), perJob };
}

/**
 * Adaptive Stealth Mode (mode=auto) by default, like `fetch` and `extract`: returns
 * the jobs with `mode: "auto"` on every line that doesn't force `js_render` /
 * `premium_proxy` or set `mode` itself, and none at all when the job-level params
 * force either flag. Applied per task rather than job-level because the API rejects
 * a task that combines a job-level mode=auto with its own js_render or
 * premium_proxy (REQS004).
 */
export function withAdaptiveStealth(jobs: BatchJob[], jobParams: Record<string, unknown> = {}): BatchJob[] {
  const forced = (p: Record<string, unknown>) => isTruthyFlag(p.js_render) || isTruthyFlag(p.premium_proxy);
  if (forced(jobParams) || jobParams.mode != null) return jobs;
  return jobs.map((job) => {
    const own = { ...(job.zenrows_params ?? {}), ...job };
    if (forced(own) || own.mode != null) return job;
    return { ...job, mode: "auto" };
  });
}

/** Body for `POST /jobs` (closed, all-URLs-up-front job). */
export interface JobBody {
  type: "regular";
  status: "closed";
  zenrows_params?: Record<string, string>;
  tasks: Array<{
    url: string;
    external_id?: string;
    metadata?: Record<string, string>;
    zenrows_params?: Record<string, string>;
  }>;
}

/**
 * Map a validated JSONL spec + job-level flags to the Batch API request body.
 * The flat per-line options (`js_render`, `premium_proxy`, `proxy_country`,
 * `autoparse`, `mode`, …) plus any nested `zenrows_params` become that task's
 * `zenrows_params`; `jobParams` (from CLI flags) becomes the job-level
 * `zenrows_params`. `url`/`external_id`/`metadata` map straight through.
 *
 * The API rejects `proxy_country` without `premium_proxy` (unless mode=auto),
 * so we surface PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM here — before submitting —
 * for the effective (job + task) params, mirroring the manual-mode guard in
 * `protected-fetch.ts::validateAutoManual`.
 */
export function toJobBody(jobs: BatchJob[], jobParams: Record<string, unknown> = {}): JobBody {
  // No separate job-level check: a job-level proxy_country is valid for each task
  // in Adaptive Stealth Mode, and the per-task check below sees job ⊕ task params.
  const tasks = jobs.map((job, idx) => {
    const { url, external_id, metadata } = job;
    const taskParams = taskParamsOf(job);
    // Validate on the effective (job + task) params as submitted, so a job-level
    // premium_proxy covers a per-task proxy_country, and a task key set to null
    // (not submitted) leaves the job's value in force, matching the API's merge.
    const effective = effectiveParams(job, jobParams);
    assertBooleanParams(effective, `line ${idx + 1} (${url})`);
    assertProxyCountryPremium(effective, `line ${idx + 1} (${url})`);

    const task: JobBody["tasks"][number] = { url };
    if (external_id !== undefined) task.external_id = String(external_id);
    if (metadata !== undefined) task.metadata = metadata;
    const zp = normalizeParams(taskParams);
    if (Object.keys(zp).length) task.zenrows_params = zp;
    return task;
  });

  const body: JobBody = { type: "regular", status: "closed", tasks };
  const jobZp = normalizeParams(jobParams);
  if (Object.keys(jobZp).length) body.zenrows_params = jobZp;
  return body;
}

/**
 * Coerce a flat options object into the string-valued map the Batch API expects
 * (its docs pass `zenrows_params` values as strings, e.g. `"true"`, `"us"`).
 * Boolean params are canonicalized to "true"/"false" (see `canonicalBool`);
 * other booleans/numbers are stringified; objects are JSON-encoded; nullish is dropped.
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
