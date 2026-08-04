/**
 * Minimal step runner used by `recipe run` and `eval run`.
 *
 * A step spec is intentionally small for V1: cloud primitives (`fetch`,
 * `extract`) plus one local, network-free check (`batch-estimate`, which
 * validates a JSONL job spec + estimates credits). Anything depending on a
 * capability that is not available is blocked earlier by the capability/asset
 * guards. The full workflow execution engine is a later phase.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy, ToolkitConfig } from "../types/index.ts";
import { runFetch } from "../adapters/protected-fetch.ts";
import { runExtract } from "../adapters/extract.ts";
import { estimateCredits, validateJsonl } from "../adapters/batch.ts";

export interface RunStep {
  kind: "fetch" | "extract" | "batch-estimate";
  /** Target URL — required for `fetch`/`extract`. */
  url?: string;
  /** JSONL job-spec path (relative to the asset dir) — required for `batch-estimate`. */
  file?: string;
  options?: Record<string, unknown>;
  /** Optional success check on the result. */
  expect?: { minLength?: number; jsonHasKeys?: string[]; minValidJobs?: number; maxErrors?: number };
}

/** True when a step runs entirely locally (no API key / network needed). */
export function isLocalStep(step: RunStep): boolean {
  return step.kind === "batch-estimate";
}

export interface StepSpec {
  steps: RunStep[];
  description?: string;
}

export interface StepResult {
  step: RunStep;
  ok: boolean;
  status?: number;
  bytes?: number;
  costUsd?: number | null;
  costCredits?: number | null;
  requestId?: string | null;
  /** For local `batch-estimate` steps: the estimated credit cost of the spec. */
  estimatedCredits?: number;
  failureReason?: string;
}

export function loadStepSpec(assetDir: string): StepSpec | null {
  const file = join(assetDir, "spec.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as StepSpec;
}

export async function runStep(
  step: RunStep,
  config: ToolkitConfig,
  policy: Policy,
  apiKey: string,
  assetDir?: string,
): Promise<StepResult> {
  try {
    if (step.kind === "batch-estimate") return runBatchEstimate(step, assetDir);

    if (!step.url) {
      return { step, ok: false, failureReason: `${step.kind} step requires a "url"` };
    }
    const run = step.kind === "fetch" ? runFetch : runExtract;
    const { result } = await run({ url: step.url, ...(step.options ?? {}) }, config, policy, apiKey);
    const ok = checkExpect(result.body, step);
    return {
      step,
      ok,
      status: result.status,
      bytes: result.body.length,
      costUsd: result.costUsd,
      costCredits: result.costCredits,
      requestId: result.requestId,
      failureReason: ok ? undefined : "expectation not met",
    };
  } catch (err) {
    return { step, ok: false, failureReason: err instanceof Error ? err.message : String(err) };
  }
}

/** Local, network-free check: validate a JSONL job spec + estimate credits. */
function runBatchEstimate(step: RunStep, assetDir?: string): StepResult {
  if (!step.file) return { step, ok: false, failureReason: 'batch-estimate step requires a "file"' };
  const path = assetDir ? join(assetDir, step.file) : step.file;
  const v = validateJsonl(path); // throws INVALID_USAGE if the file is missing → caught by runStep
  const est = estimateCredits(v.jobs);
  const e = step.expect ?? {};
  let ok = true;
  let failureReason: string | undefined;
  if (e.maxErrors !== undefined && v.errors.length > e.maxErrors) {
    ok = false;
    failureReason = `${v.errors.length} invalid line(s) (> ${e.maxErrors})`;
  } else if (e.minValidJobs !== undefined && v.validJobs < e.minValidJobs) {
    ok = false;
    failureReason = `${v.validJobs} valid job(s) (< ${e.minValidJobs})`;
  }
  // bytes carries the valid-job count so the report shows something meaningful;
  // costUsd is left unset (the estimate is in credits, not USD).
  return { step, ok, bytes: v.validJobs, estimatedCredits: est.credits, failureReason };
}

function checkExpect(body: string, step: RunStep): boolean {
  const e = step.expect;
  if (!e) return true;
  if (e.minLength !== undefined && body.length < e.minLength) return false;
  if (e.jsonHasKeys && e.jsonHasKeys.length) {
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      return e.jsonHasKeys.every((k) => k in obj);
    } catch {
      return false;
    }
  }
  return true;
}
