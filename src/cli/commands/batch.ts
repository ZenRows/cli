/**
 * `zenrows batch` — Batch API (status: beta).
 *
 * Local (no key, always works): `estimate`/`create --dry-run`-style spec
 * validation + credit estimate. Cloud (needs a key + Batch beta access):
 * `create`, `status`, `results`, `cancel`, `wait`, `retry-failed`. Without beta
 * access the API returns 403 → BATCH_ACCESS_DENIED.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { log, ANSI, c } from "../../core/logger.ts";
import { estimateCredits, toJobBody, validateJsonl, withAdaptiveStealth, type BatchJob } from "../../adapters/batch.ts";
import { loadConfig } from "../../core/config.ts";
import { requireApiKey } from "../../core/auth.ts";
import { ensureApiKey } from "../../core/ensure-key.ts";
import { assertUsable } from "../../core/capabilities.ts";
import { assertDomainAllowed, assertWithinLimits, loadPolicy } from "../../core/policy.ts";
import { newRunId, writeRun } from "../../core/artifacts.ts";
import { createJob, downloadResults, getJob, listResults, rerunJob, stopJob, waitForJob, type Job } from "../../core/batch-api.ts";
import { asNumber, asString, parse, type Command, type RunContext } from "../command.ts";
import { ToolkitError, isKeyCapReached, keyCapReached } from "../../core/errors.ts";
import { printError, writeOut } from "../output.ts";

export const batch: Command = {
  name: "batch",
  summary: "Run JSONL batch jobs on Zenrows Batch (beta).",
  usage: "zenrows batch <estimate|create <file.jsonl>|status <id>|results <id>|cancel <id>|wait <id>|retry-failed <id>>",
  help: [
    "Local (no key):",
    "  estimate <file.jsonl> [--manual] validate the spec + estimate credits (upper bound)",
    "Cloud (needs a key + Batch beta access):",
    "  create <file.jsonl> [flags]      validate, then submit the job",
    "    (default)                      Adaptive Stealth Mode (mode=auto) on every task that",
    "                                   doesn't force js_render / premium_proxy itself",
    "    --manual                       no Adaptive Stealth Mode; plain requests unless flags below",
    "    --js-render                    job-level: force JavaScript rendering (turns auto off)",
    "    --premium-proxy                job-level: force residential IPs (turns auto off)",
    "    --proxy-country <cc>           job-level: geo-target (auto mode, or with --premium-proxy)",
    "    --output <fmt>                 job-level response_type (markdown|plaintext|pdf|html)",
    "    --follow                       poll until the run finishes (alias: --wait)",
    "    --no-signup                    do not auto-create a Free plan account if no key exists",
    "  status <id>                      show run status + stats",
    "  results <id> [--status s]        list results (successful|failed|all); paginated",
    "    --out <file>                   write results as JSONL instead of printing",
    "    --download <dir>               fetch each result body into <dir> (+ _manifest.jsonl)",
    "  cancel <id>                      stop an in-flight run",
    "  wait <id> [--timeout <ms>]       poll until the run finishes",
    "  retry-failed <id>                rerun only the failed tasks (new run)",
    "  --json                           print structured output",
  ].join("\n"),
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const [sub, ...rest] = argv;
    try {
      switch (sub) {
        case "estimate":
          return estimateCmd(rest, ctx);
        case "create":
          return await createCmd(rest, ctx);
        case "status":
          return await statusCmd(rest, ctx);
        case "results":
          return await resultsCmd(rest, ctx);
        case "cancel":
          return await cancelCmd(rest, ctx);
        case "wait":
          return await waitCmd(rest, ctx);
        case "retry-failed":
          return await retryCmd(rest, ctx);
        default:
          throw new ToolkitError({
            code: "INVALID_USAGE",
            message: `Unknown batch subcommand: ${sub ?? "(none)"}`,
            likely_cause: "Subcommand not recognized.",
            next_action: "Use estimate | create <file.jsonl> | status <id> | results <id> | cancel <id> | wait <id> | retry-failed <id>.",
          });
      }
    } catch (err) {
      printError(err, ctx.json);
      return 1;
    }
  },
};

/** Jobs as they will be sent: Adaptive Stealth Mode applied unless manual or disabled in config. */
function effectiveJobs(jobs: BatchJob[], jobParams: Record<string, unknown>, manual: boolean): BatchJob[] {
  return manual || loadConfig().defaultMode !== "auto" ? jobs : withAdaptiveStealth(jobs, jobParams);
}

function estimateCmd(rest: string[], ctx: RunContext): number {
  const { values, positionals } = parse(rest, { manual: { type: "boolean" } });
  const file = positionals[0];
  if (!file) throw needFile();
  const v = validateJsonl(file);
  const est = estimateCredits(effectiveJobs(v.jobs, {}, values.manual === true));
  if (ctx.json) {
    log.out(JSON.stringify({ ok: v.errors.length === 0, ...v, estimatedCredits: est.credits }, null, 2));
  } else {
    log.info(c(ANSI.bold, `Job spec: ${file}`));
    log.info(`valid jobs: ${v.validJobs}/${v.totalLines}`);
    log.info(`estimated credits, upper bound (1x basic / 5x js / 10x proxy / 25x both or auto): ${est.credits}`);
    if (v.errors.length) {
      log.warn(`${v.errors.length} invalid line(s):`);
      v.errors.slice(0, 10).forEach((e) => log.dim(`  line ${e.line}: ${e.reason}`));
    } else {
      log.success("Spec is valid.");
    }
  }
  return v.errors.length ? 1 : 0;
}

async function createCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    "js-render": { type: "boolean" },
    "premium-proxy": { type: "boolean" },
    "proxy-country": { type: "string" },
    manual: { type: "boolean" },
    output: { type: "string" },
    follow: { type: "boolean" },
    wait: { type: "boolean" }, // back-compat alias for --follow
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
  });
  // `--follow` is the clear name (poll until the run finishes); `--wait` is kept
  // as an alias because fetch/extract use `--wait <ms>` for a different meaning.
  const follow = values.follow === true || values.wait === true;
  const json = ctx.json || values.json === true;
  const file = positionals[0];
  if (!file) throw needFile();

  // Capability gate first — a beta-disabled backend never gets a spec read.
  assertUsable("batch");

  const v = validateJsonl(file);
  if (v.errors.length) {
    log.warn(`${v.errors.length} invalid line(s) — fix them before submitting:`);
    v.errors.slice(0, 10).forEach((e) => log.dim(`  line ${e.line}: ${e.reason}`));
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Job spec has ${v.errors.length} invalid line(s).`,
      likely_cause: "One or more JSONL lines are not valid JSON or lack a valid `url`.",
      next_action: "Fix the flagged lines (see `zenrows batch estimate`), then retry.",
      suggested_commands: [`zenrows batch estimate ${file}`],
    });
  }

  // Pre-flight governance — all local, before any network call:
  //  1. every task URL must pass the allow/deny domain policy,
  //  2. the run must fit the batch-only page/credit caps (a batch is the one
  //     primitive that fans out into many requests, so the caps bind here).
  const jobParams: Record<string, unknown> = {};
  if (values["js-render"] === true) jobParams.js_render = true;
  if (values["premium-proxy"] === true) jobParams.premium_proxy = true;
  const proxyCountry = asString(values["proxy-country"]);
  if (proxyCountry) jobParams.proxy_country = proxyCountry;
  const responseType = normalizeOutput(asString(values.output));
  if (responseType) jobParams.response_type = responseType;
  const jobs = effectiveJobs(v.jobs, jobParams, values.manual === true);

  const policy = loadPolicy();
  for (const job of jobs) assertDomainAllowed(job.url, policy);
  const est = estimateCredits(jobs);
  assertWithinLimits({ pages: v.validJobs, credits: est.credits }, policy, "batch");

  // toJobBody validates proxy_country/premium_proxy BEFORE any HTTP call.
  const body = toJobBody(jobs, jobParams);
  const apiKey = await ensureApiKey(
    values["no-signup"] ? { ...policy, auto_signup: false } : policy,
    {
      onProvision: (a) => {
        log.info("No API key found — created a Zenrows Free plan account for you.");
        log.dim(`Claim it anytime (keeps your usage): ${a.claimUrl}`);
      },
    },
  );

  const runId = newRunId();
  const startedAt = new Date().toISOString();
  log.step(`Submitting batch job (${body.tasks.length} tasks, ~${est.credits} credits)…`);
  try {
    const job = await createJob(body, { apiKey });
    const finished = follow ? await waitForJob(job.job_id, { apiKey }) : job;
    const runError = runFailure(finished);
    const runDir = writeRun({
      runId,
      command: "zenrows batch create",
      capability: "batch",
      startedAt,
      finishedAt: new Date().toISOString(),
      status: runError ? "error" : "ok",
      request: { file, tasks: body.tasks.length, estimatedCredits: est.credits, jobParams },
      result: { jobId: job.job_id, status: finished.latest_run?.status ?? "unknown", ...failureFields(finished) },
      ...(runError ? { error: runError.toJSON() } : {}),
    });
    const code = printJob(finished, json, `Submitted job ${job.job_id}`);
    if (runDir && !json) log.dim(`  artifact: ${runDir}`);
    return code;
  } catch (err) {
    writeRun({
      runId,
      command: "zenrows batch create",
      capability: "batch",
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "error",
      request: { file, tasks: body.tasks.length, estimatedCredits: est.credits, jobParams },
      error: err instanceof ToolkitError ? err.toJSON() : { message: String(err) },
    });
    throw err;
  }
}

async function statusCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { positionals } = parse(rest, {});
  const id = requireId(positionals[0]);
  assertUsable("batch");
  const apiKey = requireApiKey();
  const job = await getJob(id, { apiKey });
  return printJob(job, ctx.json, `Job ${id}`);
}

async function resultsCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    status: { type: "string" },
    out: { type: "string" },
    download: { type: "string" },
    json: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0]);
  const status = normalizeResultStatus(asString(values.status));
  assertUsable("batch");
  const apiKey = requireApiKey();

  const rows = await listResults(id, { apiKey, status });

  const downloadDir = asString(values.download);
  if (downloadDir) {
    const out = await downloadResults(rows, downloadDir);
    if (json) {
      log.out(
        JSON.stringify(
          {
            ok: out.failed.length === 0,
            jobId: id,
            dir: out.dir,
            downloaded: out.downloaded.length,
            failed: out.failed.length,
            skipped: out.skipped.length,
            results: out,
          },
          null,
          2,
        ),
      );
    } else {
      log.success(`Downloaded ${out.downloaded.length}/${rows.length} result(s) → ${out.dir}`);
      log.dim(`  index: ${join(out.dir, "_manifest.jsonl")}`);
      if (out.skipped.length) log.dim(`  skipped ${out.skipped.length} (no body — e.g. failed tasks)`);
      if (out.failed.length) {
        log.warn(`  ${out.failed.length} download(s) failed:`);
        out.failed.slice(0, 10).forEach((f) => log.dim(`    ${f.external_id ?? f.task_id}: ${f.reason}`));
      }
    }
    return out.failed.length ? 1 : 0;
  }

  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
  const outFile = asString(values.out);
  if (outFile) {
    if (statSync(outFile, { throwIfNoEntry: false })?.isDirectory()) {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: `--out expects a file, but '${outFile}' is a directory.`,
        likely_cause: "--out writes the results listing to a single JSONL file; you passed a directory.",
        next_action:
          "Use a file path (e.g. --out results.jsonl), or download each result body into a directory with --download <dir>.",
        suggested_commands: [`zenrows batch results ${id} --download ${outFile}`],
      });
    }
    writeOut(outFile, jsonl + (jsonl ? "\n" : ""));
    log.success(`Wrote ${rows.length} result(s) → ${outFile}`);
  } else if (json) {
    log.out(JSON.stringify({ ok: true, jobId: id, count: rows.length, results: rows }, null, 2));
  } else {
    log.info(`${rows.length} result(s) for job ${id}:`);
    log.out(jsonl);
  }
  return 0;
}

async function cancelCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { positionals } = parse(rest, {});
  const id = requireId(positionals[0]);
  assertUsable("batch");
  const apiKey = requireApiKey();
  const job = await stopJob(id, { apiKey });
  return printJob(job, ctx.json, `Stopped job ${id}`);
}

async function waitCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { timeout: { type: "string" }, json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0]);
  assertUsable("batch");
  const apiKey = requireApiKey();
  const job = await waitForJob(id, { apiKey, timeoutMs: asNumber(values.timeout) });
  return printJob(job, json, `Job ${id} finished`);
}

async function retryCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { positionals } = parse(rest, {});
  const id = requireId(positionals[0]);
  assertUsable("batch");
  const apiKey = requireApiKey();
  // "Reruns and retrying failures": POST /jobs/{id}/rerun?status=failed replays
  // only the failures; already-successful tasks carry over.
  const job = await rerunJob(id, { apiKey, status: "failed" });
  return printJob(job, ctx.json, `Reran failed tasks for job ${id}`);
}

/** The run's failure_reason / failure_detail, when the API reports them. */
function failureFields(job: Job): { failure_reason?: string; failure_detail?: string } {
  const run = job.latest_run ?? ({} as Job["latest_run"]);
  const out: { failure_reason?: string; failure_detail?: string } = {};
  if (typeof run.failure_reason === "string" && run.failure_reason) out.failure_reason = run.failure_reason;
  if (typeof run.failure_detail === "string" && run.failure_detail) out.failure_detail = run.failure_detail;
  return out;
}

/**
 * The error for a run that ended `failed`, or null for any other state. A run the
 * key's credit cap stopped (`api_key_cap_reached`) gets the cap guidance: the
 * account still has credits and its other keys keep working.
 */
export function runFailure(job: Job): ToolkitError | null {
  if (job.latest_run?.status !== "failed") return null;
  const { failure_reason, failure_detail } = failureFields(job);
  const where = `batch job ${job.job_id}`;
  if (isKeyCapReached(failure_reason)) {
    return keyCapReached(where, { status: null, detail: failure_detail });
  }
  const why = [failure_reason, failure_detail].filter(Boolean).join(": ");
  return new ToolkitError({
    code: "BATCH_FAILED",
    message: `Batch job ${job.job_id} failed.`,
    likely_cause: why || "The run ended in status failed without a reason.",
    next_action: "Inspect the per-task results, fix the cause, then rerun the failed tasks.",
    suggested_commands: [`zenrows batch results ${job.job_id} --status failed`, `zenrows batch retry-failed ${job.job_id}`],
  });
}

/**
 * Print a job's status + stats, structured under --json, and return the exit
 * code: 1 when the run ended `failed`, else 0. `stopped` and `deleted` are
 * deliberate outcomes (someone cancelled or removed the run), so they exit 0
 * but print as a warning, not a success.
 */
function printJob(job: Job, json: boolean, headline: string): number {
  const run = job.latest_run ?? ({} as Job["latest_run"]);
  const stats = run.stats;
  const failure = failureFields(job);
  const err = runFailure(job);
  if (json) {
    log.out(
      JSON.stringify(
        { ok: !err, jobId: job.job_id, status: run.status, stats, ...failure, ...(err ? { error: err.toJSON() } : {}) },
        null,
        2,
      ),
    );
    return err ? 1 : 0;
  }
  const line = `${headline} · status: ${run.status ?? "unknown"}`;
  if (err) log.error(line);
  else if (run.status === "stopped" || run.status === "deleted") log.warn(line);
  else log.success(line);
  if (stats) {
    log.info(`  ${stats.completed}/${stats.total} completed · ${stats.successful} successful · ${stats.failed} failed`);
  }
  if (failure.failure_reason) log.info(`  failure_reason: ${failure.failure_reason}`);
  if (failure.failure_detail) log.info(`  failure_detail: ${failure.failure_detail}`);
  if (err) printError(err, false);
  return err ? 1 : 0;
}

function normalizeResultStatus(v?: string): "successful" | "failed" | "all" | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (s === "successful" || s === "failed" || s === "all") return s;
  throw new ToolkitError({
    code: "INVALID_USAGE",
    message: `Invalid --status: ${v}`,
    likely_cause: "Only successful | failed | all are supported.",
    next_action: "Use --status successful | failed | all (default: all).",
  });
}

function normalizeOutput(v?: string): string | undefined {
  if (!v) return undefined;
  const map: Record<string, string> = {
    md: "markdown",
    markdown: "markdown",
    text: "plaintext",
    plaintext: "plaintext",
    txt: "plaintext",
    pdf: "pdf",
    html: "", // raw HTML is the default; no response_type
  };
  const key = v.toLowerCase();
  if (!(key in map)) {
    // Fail loudly rather than silently dropping an unrecognized format (house rule).
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Unknown --output format: ${v}.`,
      likely_cause: "Only markdown | plaintext | pdf | html are supported for batch --output.",
      next_action: "Use --output md|markdown | text|plaintext | pdf | html (html = raw HTML, the default).",
      suggested_commands: ["zenrows batch create jobs.jsonl --output markdown"],
    });
  }
  const mapped = map[key];
  return mapped ? mapped : undefined; // html → undefined (no response_type)
}

function requireId(id: string | undefined): string {
  if (id) return id;
  throw new ToolkitError({
    code: "INVALID_USAGE",
    message: "Missing job id.",
    likely_cause: "No <id> positional was provided.",
    next_action: "Usage: zenrows batch status <id>",
    suggested_commands: ["zenrows batch status <id>"],
  });
}

function needFile(): ToolkitError {
  return new ToolkitError({
    code: "INVALID_USAGE",
    message: "Provide a JSONL job spec.",
    likely_cause: "No file path was given.",
    next_action: "Usage: zenrows batch estimate jobs.jsonl",
    suggested_commands: ["zenrows batch estimate jobs.jsonl"],
  });
}
