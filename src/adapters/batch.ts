/**
 * Batch Jobs adapter.
 *
 * Status: `beta` — the ZenRows Batch Scraper API is in beta.
 * With beta access the cloud subcommands run for real (see `core/batch-api.ts`).
 * Without access the API returns 403 → BATCH_ACCESS_DENIED. This adapter owns
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
  /** Opaque per-task metadata carried through to results. */
  metadata?: unknown;
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
      result.validJobs++;
      result.jobs.push(obj);
    } catch {
      result.errors.push({ line: idx + 1, reason: "invalid JSON" });
    }
  });
  return result;
}

/**
 * Rough local credit estimate using documented multipliers
 * (basic 1x, js 5x, proxies 10x, both 25x). Counts in abstract "credits".
 */
export function estimateCredits(jobs: BatchJob[]): { credits: number; perJob: number[] } {
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

/** Body for `POST /jobs` (closed, all-URLs-up-front job). */
export interface JobBody {
  type: "regular";
  status: "closed";
  zenrows_params?: Record<string, string>;
  tasks: Array<{
    url: string;
    external_id?: string;
    metadata?: unknown;
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
  assertProxyCountryPremium(jobParams, "job-level params");

  const tasks = jobs.map((job, idx) => {
    const { url, external_id, metadata, zenrows_params } = job;
    const flat: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(job)) {
      if (!TASK_RESERVED.has(k)) flat[k] = v;
    }
    const taskParams: Record<string, unknown> = { ...(zenrows_params ?? {}), ...flat };
    // Validate on the effective (job ⊕ task) params so a job-level premium_proxy
    // covers a per-task proxy_country, matching how the API merges them.
    assertProxyCountryPremium({ ...jobParams, ...taskParams }, `line ${idx + 1} (${url})`);

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
 * Booleans/numbers are stringified; objects are JSON-encoded; nullish is dropped.
 */
function normalizeParams(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
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
  return v === true || v === "true";
}

/** Throw if proxy_country is set without premium_proxy and outside auto mode. */
function assertProxyCountryPremium(params: Record<string, unknown>, where: string): void {
  if (!params.proxy_country) return;
  if (isAutoMode(params.mode) || isTruthyFlag(params.premium_proxy)) return;
  throw new ToolkitError({
    code: "PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM",
    message: `proxy_country needs premium proxies (or mode=auto) — ${where}.`,
    likely_cause:
      "The Batch Scraper API only geolocates the proxy when premium_proxy=true, or in Adaptive Stealth Mode (mode=auto).",
    next_action:
      "Add premium_proxy (10x cost) alongside proxy_country, or set mode=auto — geo-targeting works there without the flag.",
    suggested_commands: ["zenrows batch create jobs.jsonl --premium-proxy --proxy-country us"],
  });
}
