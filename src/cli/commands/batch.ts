/**
 * `zenrows batch`: Batch API (status: available).
 *
 * Local (no key, always works): `estimate` validates a JSONL spec and prices
 * it. Cloud (needs a key): `create`, `list`, `status`, `wait`, `results`,
 * `content`, `cancel`, `pause`, `resume`, `rerun`, `retry-failed`, `delete`.
 * A 403 maps to BATCH_ACCESS_DENIED. Schedules, webhooks, exports, CSV inputs,
 * open jobs, runs and task history are API/SDK-only.
 */
import { join } from "node:path";
import { log, ANSI, c } from "../../core/logger.ts";
import {
  estimateCredits,
  externalIdError,
  LIMITS,
  metadataError,
  toJobBody,
  validateJsonl,
  withAdaptiveStealth,
  type BatchJob,
  type JobFields,
} from "../../adapters/batch.ts";
import { loadConfig } from "../../core/config.ts";
import { requireApiKey } from "../../core/auth.ts";
import { ensureApiKey } from "../../core/ensure-key.ts";
import { assertUsable } from "../../core/capabilities.ts";
import { assertDomainAllowed, assertWithinLimits, loadPolicy } from "../../core/policy.ts";
import { newRunId, writeRun } from "../../core/artifacts.ts";
import {
  RERUN_STATUSES,
  assertIdempotencyKey,
  createJob,
  deleteJob,
  downloadResults,
  getJob,
  getRun,
  getTaskContent,
  isPaused,
  isTerminal,
  listJobs,
  listResults,
  newIdempotencyKey,
  pauseJob,
  rerunJob,
  resumeJob,
  stopJob,
  subscriptionInactive,
  waitForJob,
  type Job,
  type JobRun,
  type ResultStatus,
} from "../../core/batch-api.ts";
import { readAccount } from "../../core/agent-account.ts";
import { asNumber, asString, parse, type Command, type RunContext } from "../command.ts";
import { ToolkitError, isKeyCapReached, keyCapReached, quotaExhausted } from "../../core/errors.ts";
import { printError, writeOut } from "../output.ts";

/** What `rerun` selects with no --status: the unfinished tasks, never the successful ones. */
const DEFAULT_RERUN = "failed,pending";
/** The task statuses that recover every task a run did not finish successfully. */
const UNFINISHED = "failed,pending,processing";

export const batch: Command = {
  name: "batch",
  summary: "Run JSONL batch jobs on Zenrows Batch.",
  usage:
    "zenrows batch <estimate <file.jsonl>|create <file.jsonl>|list|status <id>|wait <id>|results <id>|content <id> <task_id>|cancel <id>|pause <id>|resume <id>|rerun <id>|retry-failed <id>|delete <id>>",
  help: [
    "Local (no key):",
    "  estimate <file.jsonl> [flags]    validate the spec and price it (credits: min and upper bound);",
    "                                   takes the same --manual / --js-render / --premium-proxy /",
    "                                   --proxy-country flags as create, so both price the same request",
    "Cloud (needs a key):",
    "  create <file.jsonl> [flags]      validate, then submit the job",
    "    (default)                      Adaptive Stealth Mode (mode=auto) on every GET task that",
    "                                   doesn't force js_render / premium_proxy or set mode itself",
    "    --manual                       no Adaptive Stealth Mode; plain requests unless flags below",
    "    --js-render                    job-level: force JavaScript rendering (turns auto off)",
    "    --premium-proxy                job-level: force residential IPs (turns auto off)",
    "    --proxy-country <cc>           job-level: geo-target (auto mode, or with --premium-proxy)",
    "    --output <fmt>                 job-level response_type (markdown|plaintext|pdf|html)",
    "    --name <name>                  job name (up to 100 characters)",
    "    --external-id <id>             job-level external id (letters, digits, . _ -; up to 128)",
    "    --metadata <key=value>         job-level metadata entry (repeatable, up to 20)",
    "    --idempotency-key <key>        so a repeated create starts no second job (one is generated",
    "                                   otherwise; the API keeps it 24 hours)",
    "    --follow                       wait until the run ends (alias: --wait; Ctrl-C stops the",
    "                                   wait, not the job)",
    "    --timeout <duration>           with --follow: stop waiting after this long (10s, 5m, 1h;",
    "                                   a bare number is milliseconds; default 10m)",
    "    --no-signup                    do not auto-create a Free plan account if no key exists",
    "  list [--status open|closed] [--type regular|scheduled] [--limit n] [--cursor c]",
    "                                   your jobs, newest first (limit up to 100)",
    "  status <id>                      show the job's latest run: status, stats, pause state",
    "  wait <id> [--timeout <duration>] poll until the run ends, is paused, or the time runs out",
    "                                   (default 10m); a run still going then is printed, not stopped",
    "  results <id> [--status s]        list results (successful|failed|processing|all); partial",
    "                                   while the run is in progress",
    "    --run <run_id>                 read an earlier run instead of the latest",
    "    --out <file>                   write results as JSONL instead of printing",
    "    --download <dir>               fetch each result body into <dir> (+ _manifest.jsonl)",
    "  content <id> <task_id> [--run <run_id>] [--out <file>]",
    "                                   print or save one task's result body",
    "  cancel <id>                      stop the in-flight run (an ended run answers as it ended)",
    "  pause <id> / resume <id>         pause the in-flight run, or resume it",
    "  rerun <id>                       start a new run of the failed and pending tasks",
    "                                   (successful tasks carry over and are not billed again)",
    "    --status <list>                rerun only tasks with these statuses",
    "                                   (pending,processing,failed,successful)",
    "    --all                          rerun every task (a full rerun; not with --status)",
    "                                   rerun also takes --idempotency-key, --follow and --timeout",
    "  retry-failed <id>                rerun only the failed tasks (rerun --status failed); takes",
    "                                   --idempotency-key, --follow and --timeout like rerun",
    "    --include-pending              also the tasks a stop or a credit failure left unfinished",
    "                                   (rerun --status failed,pending,processing)",
    "  delete <id> --yes                delete the job, its runs and stored results; frees its slot",
    "  --json                           print structured output: create/status/wait/cancel/pause/",
    "                                   resume/rerun print {ok, job_id, run_id, status, stats, job};",
    "                                   a wait that runs out or meets a paused run adds note",
    "Schedules, webhooks, exports, CSV inputs and open jobs are available through the Batch API",
    "and the SDKs: https://docs.zenrows.com",
  ].join("\n"),
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const [sub, ...rest] = argv;
    try {
      switch (sub) {
        case "estimate":
          return estimateCmd(rest, ctx);
        case "create":
          return await createCmd(rest, ctx);
        case "list":
          return await listCmd(rest, ctx);
        case "status":
          return await statusCmd(rest, ctx);
        case "wait":
          return await waitCmd(rest, ctx);
        case "results":
          return await resultsCmd(rest, ctx);
        case "content":
          return await contentCmd(rest, ctx);
        case "cancel":
        case "stop":
          return await cancelCmd(rest, ctx);
        case "pause":
          return await pauseCmd(rest, ctx, "pause");
        case "resume":
          return await pauseCmd(rest, ctx, "resume");
        case "rerun":
          return await rerunCmd(rest, ctx, "rerun");
        case "retry-failed":
          return await rerunCmd(rest, ctx, "retry-failed");
        case "delete":
          return await deleteCmd(rest, ctx);
        default:
          throw new ToolkitError({
            code: "INVALID_USAGE",
            message: `Unknown batch subcommand: ${sub ?? "(none)"}`,
            likely_cause: "Subcommand not recognized.",
            next_action:
              "Use estimate | create <file.jsonl> | list | status <id> | wait <id> | results <id> | content <id> <task_id> | cancel <id> | pause <id> | resume <id> | rerun <id> | retry-failed <id> | delete <id>.",
            suggested_commands: ["zenrows batch --help"],
          });
      }
    } catch (err) {
      printError(err, ctx.json);
      return 1;
    }
  },
};

/** Flags that shape the request each task sends; shared by `estimate` and `create`. */
const PARAM_FLAGS = {
  "js-render": { type: "boolean" },
  "premium-proxy": { type: "boolean" },
  "proxy-country": { type: "string" },
  manual: { type: "boolean" },
  output: { type: "string" },
} as const;

/** Job-level `zenrows_params` from the CLI flags. */
function jobParamsOf(values: Record<string, unknown>): Record<string, unknown> {
  const jobParams: Record<string, unknown> = {};
  if (values["js-render"] === true) jobParams.js_render = true;
  if (values["premium-proxy"] === true) jobParams.premium_proxy = true;
  const proxyCountry = asString(values["proxy-country"]);
  if (proxyCountry) jobParams.proxy_country = proxyCountry;
  const responseType = normalizeOutput(asString(values.output));
  if (responseType) jobParams.response_type = responseType;
  return jobParams;
}

/** Jobs as they will be sent: Adaptive Stealth Mode applied unless manual or disabled in config. */
function effectiveJobs(jobs: BatchJob[], jobParams: Record<string, unknown>, manual: boolean): BatchJob[] {
  return manual || loadConfig().defaultMode !== "auto" ? jobs : withAdaptiveStealth(jobs, jobParams);
}

function estimateCmd(rest: string[], ctx: RunContext): number {
  const { values, positionals } = parse(rest, { ...PARAM_FLAGS, json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const file = positionals[0];
  if (!file) throw needFile();
  const v = validateJsonl(file);
  const jobParams = jobParamsOf(values);
  const jobs = effectiveJobs(v.jobs, jobParams, values.manual === true);
  // Price exactly what create would submit, and catch what it would refuse.
  if (!v.errors.length) toJobBody(jobs, jobParams);
  const est = estimateCredits(jobs, jobParams);
  if (json) {
    log.out(
      JSON.stringify(
        {
          ok: v.errors.length === 0,
          ...v,
          estimatedCredits: est.credits,
          estimated_credits: est.credits,
          estimated_credits_min: est.min,
        },
        null,
        2,
      ),
    );
  } else {
    log.info(c(ANSI.bold, `Job spec: ${file}`));
    log.info(`valid jobs: ${v.validJobs}/${v.totalLines}`);
    log.info(`estimated credits: ${est.min} to ${est.credits} (1 basic / 5 js / 10 proxy / 25 both; auto costs 1 to 25)`);
    if (v.errors.length) {
      log.warn(`${v.errors.length} invalid line(s):`);
      v.errors.slice(0, 10).forEach((e) => log.dim(`  line ${e.line}: ${e.reason}`));
    } else {
      log.success("Spec is valid.");
    }
  }
  return v.errors.length ? 1 : 0;
}

/** `--name`, `--external-id` and `--metadata key=value`, checked against the API's limits. */
function jobFieldsOf(values: Record<string, unknown>): JobFields {
  const fields: JobFields = {};
  const name = asString(values.name);
  if (name !== undefined) {
    if (!name.trim() || name.length > LIMITS.nameLength) {
      throw usageError(`Invalid --name: it must be 1 to ${LIMITS.nameLength} characters.`, "Pass a shorter name.");
    }
    fields.name = name;
  }
  const externalId = asString(values["external-id"]);
  if (externalId !== undefined) {
    const e = externalIdError(externalId);
    if (e) throw usageError(`Invalid --external-id: ${e}.`, "Pass e.g. --external-id nightly-2026-10-16.");
    fields.external_id = externalId;
  }
  const pairs = Array.isArray(values.metadata) ? (values.metadata as unknown[]) : [];
  if (pairs.length) {
    const metadata: Record<string, string> = {};
    for (const p of pairs) {
      const s = String(p);
      const eq = s.indexOf("=");
      if (eq <= 0) throw usageError(`Invalid --metadata '${s}': use key=value.`, "Pass e.g. --metadata source=catalog.");
      metadata[s.slice(0, eq)] = s.slice(eq + 1);
    }
    const e = metadataError(metadata);
    if (e) throw usageError(`Invalid --metadata: ${e}.`, "Fix the entry, then retry.");
    fields.metadata = metadata;
  }
  return fields;
}

async function createCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    ...PARAM_FLAGS,
    name: { type: "string" },
    "external-id": { type: "string" },
    metadata: { type: "string", multiple: true },
    "idempotency-key": { type: "string" },
    follow: { type: "boolean" },
    wait: { type: "boolean" }, // back-compat alias for --follow
    timeout: { type: "string" },
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
  });
  // `--follow` is the clear name (poll until the run finishes); `--wait` is kept
  // as an alias because fetch/extract use `--wait <ms>` for a different meaning.
  const follow = values.follow === true || values.wait === true;
  const json = ctx.json || values.json === true;
  const file = positionals[0];
  if (!file) throw needFile();
  const waitMs = timeoutFlag(values.timeout);
  const fields = jobFieldsOf(values);
  const givenKey = asString(values["idempotency-key"]);
  if (givenKey !== undefined) assertIdempotencyKey(givenKey);

  // Capability gate first: a disabled backend never gets a spec read.
  assertUsable("batch");

  const v = validateJsonl(file);
  if (v.errors.length) {
    log.warn(`${v.errors.length} invalid line(s), fix them before submitting:`);
    v.errors.slice(0, 10).forEach((e) => log.dim(`  line ${e.line}: ${e.reason}`));
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Job spec has ${v.errors.length} invalid line(s).`,
      likely_cause: `One or more JSONL lines are not valid JSON or break the API's task limits (first: line ${v.errors[0]!.line}: ${v.errors[0]!.reason}).`,
      next_action: "Fix the flagged lines (see `zenrows batch estimate`), then retry.",
      suggested_commands: [`zenrows batch estimate ${file}`],
    });
  }

  // Pre-flight governance, all local, before any network call:
  //  1. every task URL must pass the allow/deny domain policy,
  //  2. the run must fit the page/credit caps, priced on the params as submitted.
  const jobParams = jobParamsOf(values);
  const jobs = effectiveJobs(v.jobs, jobParams, values.manual === true);
  const policy = loadPolicy();
  for (const job of jobs) assertDomainAllowed(job.url, policy);
  const est = estimateCredits(jobs, jobParams);
  assertWithinLimits({ pages: v.validJobs, credits: est.credits }, policy, "batch");

  // toJobBody validates params (proxy_country/premium_proxy, booleans, POST) BEFORE any HTTP call.
  const body = toJobBody(jobs, jobParams, fields);
  const apiKey = await ensureApiKey(values["no-signup"] ? { ...policy, auto_signup: false } : policy, {
    onProvision: (a) => {
      log.info("No API key found: created a Zenrows Free plan account for you.");
      log.dim(`Claim it anytime (keeps your usage): ${a.claimUrl}`);
    },
  });

  const idempotencyKey = givenKey ?? newIdempotencyKey();
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const request = { file, tasks: body.tasks.length, estimatedCredits: est.credits, jobParams, ...fields };
  log.step(`Submitting batch job (${body.tasks.length} tasks, ${est.min} to ${est.credits} credits)…`);
  try {
    let job: Job;
    try {
      job = await createJob(body, { apiKey, idempotencyKey });
    } catch (err) {
      throw withRepeatCommand(err, "create", rest);
    }
    const finished = follow ? await followJob(job.job_id, apiKey, waitMs, job) : job;
    const runError = runFailure(finished);
    const runDir = writeRun({
      runId,
      command: "zenrows batch create",
      capability: "batch",
      startedAt,
      finishedAt: new Date().toISOString(),
      status: runError ? "error" : "ok",
      request,
      result: {
        jobId: job.job_id,
        job_id: job.job_id,
        run_id: finished.latest_run?.run_id,
        status: finished.latest_run?.status ?? "unknown",
        ...failureFields(finished),
      },
      ...(runError ? { error: runError.toJSON() } : {}),
    });
    const code = follow
      ? printJob(finished, json, waitHeadline(finished), { note: waitNote(finished) })
      : printJob(finished, json, `Submitted job ${job.job_id}`);
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
      request,
      error: err instanceof ToolkitError ? err.toJSON() : { message: String(err) },
    });
    throw err;
  }
}

/**
 * A write whose outcome is unknown carries its Idempotency-Key: suggest the
 * exact command that repeats it under that key, which cannot create a duplicate.
 */
function withRepeatCommand(err: unknown, sub: string, rest: string[]): unknown {
  if (!(err instanceof ToolkitError) || !err.idempotency_key) return err;
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--idempotency-key") {
      i++;
      continue;
    }
    if (a.startsWith("--idempotency-key=")) continue;
    args.push(/^[A-Za-z0-9._\-/:=,@%+]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
  }
  const repeat = `zenrows batch ${sub} ${args.join(" ")} --idempotency-key ${err.idempotency_key}`.replace(/\s+/g, " ");
  return new ToolkitError({ ...err.toJSON(), suggested_commands: [repeat, "zenrows batch list"] });
}

async function listCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values } = parse(rest, {
    status: { type: "string" },
    type: { type: "string" },
    limit: { type: "string" },
    cursor: { type: "string" },
    json: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  const status = oneOf("status", asString(values.status), ["open", "closed"]);
  const type = oneOf("type", asString(values.type), ["regular", "scheduled"]);
  const limit = pageLimit(values.limit, 100);
  const cursor = asString(values.cursor);
  assertUsable("batch");
  const apiKey = requireApiKey();
  const page = await listJobs({ apiKey, limit, cursor, status, type });
  if (json) {
    log.out(JSON.stringify({ ok: true, count: page.jobs.length, jobs: page.jobs, next_cursor: page.next_cursor }, null, 2));
    return 0;
  }
  if (!page.jobs.length) log.info("No jobs.");
  for (const j of page.jobs) {
    const run = j.latest_run;
    const runState = run ? `${run.status}${isPaused(run) ? " (paused)" : ""}` : "no run yet";
    const progress = run?.stats ? `${run.stats.completed}/${run.stats.total}` : "";
    const created = typeof j.created_at === "string" ? j.created_at : "";
    const name = typeof j.name === "string" ? j.name : "";
    log.out(`${j.job_id}  ${String(j.type ?? "")}  ${String(j.status ?? "")}  ${runState}  ${progress}  ${created}  ${name}`.trimEnd());
  }
  if (page.next_cursor) log.dim(`  more: zenrows batch list --cursor ${page.next_cursor}`);
  return 0;
}

async function statusCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { json: { type: "boolean" } });
  const id = requireId(positionals[0], "status");
  assertUsable("batch");
  const apiKey = requireApiKey();
  const job = await getJob(id, { apiKey });
  return printJob(job, ctx.json || values.json === true, `Job ${id}`, { note: isPaused(job.latest_run) ? pausedNote(id) : undefined });
}

async function waitCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { timeout: { type: "string" }, json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "wait");
  const waitMs = timeoutFlag(values.timeout);
  assertUsable("batch");
  const apiKey = requireApiKey();
  const job = await followJob(id, apiKey, waitMs);
  return printJob(job, json, waitHeadline(job), { note: waitNote(job) });
}

/**
 * Wait for a job's run to end. Ctrl-C ends the wait, not the job: say so, give
 * the command that resumes the wait, and exit 130 as shells do on SIGINT. A
 * submit's own answer is printed instead of a read when the wait ends before
 * the first poll, so its `accepted_tasks` survive.
 */
async function followJob(id: string, apiKey: string, waitMs: number | undefined, created?: Job): Promise<Job> {
  const onSigint = () => {
    log.warn(`Stopped waiting. Job ${id} is still running; it was not stopped.`);
    log.dim(`  resume: zenrows batch wait ${id}`);
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  try {
    const job = await waitForJob(id, { apiKey, waitMs });
    // Keep the submit/rerun answer's own fields (accepted_tasks, rerun_of, ...).
    return created ? { ...pickAnswerFields(created), ...job } : job;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/** The fields only a submit or rerun answer carries. */
function pickAnswerFields(job: Job): Partial<Job> {
  const out: Partial<Job> = {};
  for (const k of ["accepted_tasks", "rerun_of", "retried_tasks", "inherited_tasks"] as const) {
    if (job[k] !== undefined) (out as Record<string, unknown>)[k] = job[k];
  }
  return out;
}

function waitHeadline(job: Job): string {
  if (isTerminal(job.latest_run)) return `Job ${job.job_id} finished`;
  if (isPaused(job.latest_run)) return `Stopped waiting: job ${job.job_id} is paused`;
  return `Stopped waiting: job ${job.job_id} is still running`;
}

/** Set when a wait ended without a terminal run: it ran out, or the run is paused. */
function waitNote(job: Job): string | undefined {
  if (isTerminal(job.latest_run)) return undefined;
  if (isPaused(job.latest_run)) return pausedNote(job.job_id);
  return `The wait ran out and the run is still in progress. Run zenrows batch wait ${job.job_id}.`;
}

function pausedNote(id: string): string {
  return `The run is paused: it picks up no new task until it is resumed. Run zenrows batch resume ${id}.`;
}

async function resultsCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    status: { type: "string" },
    run: { type: "string" },
    out: { type: "string" },
    download: { type: "string" },
    json: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "results");
  const status = normalizeResultStatus(asString(values.status));
  const runId = asString(values.run);
  assertUsable("batch");
  const apiKey = requireApiKey();

  const rows = await listResults(id, { apiKey, status, runId });
  const state = await runState(id, runId, apiKey);
  const note = state.partial ? partialNote(state.status, id) : undefined;
  const meta = { jobId: id, job_id: id, ...(runId ? { run_id: runId } : {}), ...(state.status ? { status: state.status } : {}) };

  const downloadDir = asString(values.download);
  if (downloadDir) {
    const out = await downloadResults(rows, downloadDir);
    const expired = out.skipped.filter((s) => s.reason.startsWith("result expired")).length;
    if (json) {
      log.out(
        JSON.stringify(
          {
            ok: out.failed.length === 0,
            ...meta,
            dir: out.dir,
            downloaded: out.downloaded.length,
            failed: out.failed.length,
            skipped: out.skipped.length,
            expired,
            partial: state.partial,
            ...(note ? { note } : {}),
            results: out,
          },
          null,
          2,
        ),
      );
    } else {
      log.success(`Downloaded ${out.downloaded.length}/${rows.length} result(s) → ${out.dir}`);
      log.dim(`  index: ${join(out.dir, "_manifest.jsonl")}`);
      if (out.skipped.length) {
        log.dim(`  skipped ${out.skipped.length} with no body (failed, expired or unfinished tasks${expired ? `; ${expired} expired` : ""})`);
      }
      if (expired) log.dim(`  expired results are gone after 14 days by default; rerun the job in full: zenrows batch rerun ${id} --all`);
      if (out.failed.length) {
        log.warn(`  ${out.failed.length} download(s) failed:`);
        out.failed.slice(0, 10).forEach((f) => log.dim(`    ${f.external_id ?? f.task_id}: ${f.reason}`));
      }
      if (note) log.warn(`  ${note}`);
    }
    return out.failed.length ? 1 : 0;
  }

  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
  const outFile = asString(values.out);
  if (outFile) {
    writeOut(outFile, jsonl + (jsonl ? "\n" : ""));
    if (json) {
      log.out(JSON.stringify({ ok: true, ...meta, count: rows.length, file: outFile, partial: state.partial, ...(note ? { note } : {}) }, null, 2));
    } else {
      log.success(`Wrote ${rows.length} result(s) → ${outFile}`);
    }
  } else if (json) {
    log.out(JSON.stringify({ ok: true, ...meta, count: rows.length, results: rows, partial: state.partial, ...(note ? { note } : {}) }, null, 2));
  } else {
    log.info(`${rows.length} result(s) for job ${id}${state.status ? ` (status: ${state.status})` : ""}:`);
    log.out(jsonl);
  }
  if (note && !json) log.warn(`  ${note}`);
  return 0;
}

/**
 * Whether the run whose results were read can still change: in progress, or
 * still receiving its tasks. An error here never fails the listing.
 */
async function runState(id: string, runId: string | undefined, apiKey: string): Promise<{ status?: string; partial: boolean }> {
  try {
    const run: JobRun | undefined = runId ? await getRun(id, runId, { apiKey }) : (await getJob(id, { apiKey })).latest_run;
    if (!run) return { partial: false };
    return { status: run.status, partial: !isTerminal(run) || run.ingest_status === "pending" };
  } catch {
    return { partial: false };
  }
}

function partialNote(status: string | undefined, id: string): string {
  return status && isTerminal({ status } as JobRun)
    ? `The run is still receiving its tasks: these results are partial. Read them again once zenrows batch status ${id} shows ingest_status done.`
    : `The run is still in progress: these results are partial. Wait with zenrows batch wait ${id}, then read them again.`;
}

async function contentCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { run: { type: "string" }, out: { type: "string" }, json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "content");
  const taskId = positionals[1];
  if (!taskId) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Missing task id.",
      likely_cause: "No <task_id> positional was provided.",
      next_action: `Usage: zenrows batch content ${id} <task_id>. Each result row carries its task_id.`,
      suggested_commands: [`zenrows batch results ${id}`],
    });
  }
  const runId = asString(values.run);
  assertUsable("batch");
  const apiKey = requireApiKey();
  const { contentType, body } = await getTaskContent(id, taskId, { apiKey, runId });
  const ids = { job_id: id, task_id: taskId, ...(runId ? { run_id: runId } : {}) };
  const outFile = asString(values.out);
  if (outFile) {
    writeOut(outFile, body);
    if (json) {
      log.out(JSON.stringify({ ok: true, ...ids, content_type: contentType, bytes: body.length, file: outFile }, null, 2));
    } else {
      log.success(`Wrote ${body.length} bytes (${contentType || "unknown type"}) → ${outFile}`);
    }
  } else if (json) {
    log.out(JSON.stringify({ ok: true, ...ids, content_type: contentType, bytes: body.length, content: body.toString("utf8") }, null, 2));
  } else {
    process.stdout.write(body);
    if (body.length && body[body.length - 1] !== 0x0a && isText(contentType)) process.stdout.write("\n");
  }
  return 0;
}

function isText(contentType: string): boolean {
  return /^(text\/|application\/(json|xml))/i.test(contentType);
}

async function cancelCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "cancel");
  assertUsable("batch");
  const apiKey = requireApiKey();
  let run: JobRun;
  try {
    run = await stopJob(id, { apiKey });
  } catch (err) {
    // An ended run cannot be stopped: answer with the job as it ended, like crawl's stop.
    if (err instanceof ToolkitError && err.server_code === "run_not_stoppable") {
      const job = await getJob(id, { apiKey });
      return printJob(job, json, `Nothing to stop: job ${id} had already ended`);
    }
    throw err;
  }
  return printJob(asJob(id, run), json, `Stopped job ${id}`);
}

async function pauseCmd(rest: string[], ctx: RunContext, op: "pause" | "resume"): Promise<number> {
  const { values, positionals } = parse(rest, { json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], op);
  assertUsable("batch");
  const apiKey = requireApiKey();
  const run = op === "pause" ? await pauseJob(id, { apiKey }) : await resumeJob(id, { apiKey });
  const job = asJob(id, run);
  return op === "pause"
    ? printJob(job, json, `Paused job ${id}`, { note: isPaused(run) ? pausedNote(id) : undefined })
    : printJob(job, json, `Resumed job ${id}`);
}

/** stop, pause and resume answer with the run, not the job. */
function asJob(id: string, run: JobRun): Job {
  return { job_id: run.job_id ?? id, latest_run: run };
}

async function rerunCmd(rest: string[], ctx: RunContext, sub: "rerun" | "retry-failed"): Promise<number> {
  const { values, positionals } = parse(rest, {
    ...(sub === "rerun" ? { status: { type: "string" }, all: { type: "boolean" } } : { "include-pending": { type: "boolean" } }),
    "idempotency-key": { type: "string" },
    follow: { type: "boolean" },
    timeout: { type: "string" },
    json: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], sub);
  if (values.all === true && values.status !== undefined) {
    throw usageError(
      "--all and --status cannot be combined.",
      "Pass --all to rerun every task, or --status <list> to pick statuses, not both.",
      "--all reruns every task; --status reruns only some.",
    );
  }
  const status =
    sub === "rerun"
      ? values.all === true
        ? undefined
        : (rerunStatus(asString(values.status)) ?? DEFAULT_RERUN)
      : values["include-pending"] === true
        ? UNFINISHED
        : "failed";
  const waitMs = timeoutFlag(values.timeout);
  const givenKey = asString(values["idempotency-key"]);
  if (givenKey !== undefined) assertIdempotencyKey(givenKey);
  assertUsable("batch");
  const apiKey = requireApiKey();
  let job: Job;
  try {
    job = await rerunJob(id, { apiKey, status, idempotencyKey: givenKey ?? newIdempotencyKey() });
  } catch (err) {
    throw withRepeatCommand(err, sub, rest);
  }
  const what = status ? `tasks with status ${status}` : "every task";
  if (values.follow === true) {
    const finished = await followJob(job.job_id ?? id, apiKey, waitMs, job);
    return printJob(finished, json, waitHeadline(finished), { note: waitNote(finished) });
  }
  return printJob(job, json, `Started a new run of job ${id} (${what})`);
}

/** `--status` for a rerun: a comma-separated list of task statuses; undefined when unset. */
function rerunStatus(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const parts = [...new Set(v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const bad = parts.find((p) => !RERUN_STATUSES.includes(p));
  if (!parts.length || bad !== undefined) {
    throw usageError(
      `Invalid --status '${v}'.`,
      `Pass a comma-separated list of ${RERUN_STATUSES.join(", ")} (e.g. --status ${UNFINISHED}), leave it out to rerun failed and pending tasks, or pass --all to rerun every task.`,
      `A rerun selects tasks of the previous run by status: ${RERUN_STATUSES.join(", ")}.`,
    );
  }
  return parts.join(",");
}

async function deleteCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "delete");
  if (!ctx.yes) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Deleting job ${id} needs --yes.`,
      likely_cause: "Delete stops the job's run and removes the job, its runs and its stored results for good.",
      next_action: "Re-run with --yes to confirm.",
      suggested_commands: [`zenrows batch delete ${id} --yes`],
    });
  }
  assertUsable("batch");
  const apiKey = requireApiKey();
  await deleteJob(id, { apiKey });
  if (json) log.out(JSON.stringify({ ok: true, job_id: id, deleted: true }, null, 2));
  else log.success(`Deleted job ${id}. Its stored results are removed in the background.`);
  return 0;
}

/** The run's failure_reason / failure_detail, when the API reports them. */
function failureFields(job: Job): { failure_reason?: string; failure_detail?: string } {
  const run = job.latest_run;
  const out: { failure_reason?: string; failure_detail?: string } = {};
  if (typeof run?.failure_reason === "string" && run.failure_reason) out.failure_reason = run.failure_reason;
  if (typeof run?.failure_detail === "string" && run.failure_detail) out.failure_detail = run.failure_detail;
  return out;
}

/**
 * The error for a run that ended `failed`, or null for any other state. A run
 * the account's credits, its subscription or the key's credit cap stopped gets
 * the code and advice the matching HTTP refusal gets (POLICY_MAX_CREDITS_EXCEEDED,
 * AUTH_INVALID, KEY_CREDIT_CAP_REACHED); any other reason is BATCH_FAILED. All
 * carry `server_code` (the failure_reason) and `job_id`, and say how to run the
 * tasks the failure left unfinished.
 */
export function runFailure(job: Job): ToolkitError | null {
  if (job.latest_run?.status !== "failed") return null;
  const { failure_reason, failure_detail } = failureFields(job);
  const id = job.job_id;
  const where = `batch job ${id}`;
  const rerun = `zenrows batch rerun ${id} --status ${UNFINISHED}`;
  const ids = { ...(failure_reason ? { server_code: failure_reason } : {}), job_id: id };
  const detail = failure_detail ? `${failure_detail.replace(/[.\s]+$/, "")}. ` : "";
  if (isKeyCapReached(failure_reason)) {
    const cap = keyCapReached(where, { status: null, detail: failure_detail }).toJSON();
    return new ToolkitError({
      ...cap,
      ...ids,
      next_action: thenRerun(cap.next_action, rerun),
      suggested_commands: [...(cap.suggested_commands ?? []), rerun],
    });
  }
  if (failure_reason === "insufficient_credits") {
    const acct = readAccount();
    const quota = quotaExhausted(where, acct?.unclaimed ? acct.claimUrl : undefined, { detail: failure_detail }).toJSON();
    return new ToolkitError({
      ...quota,
      ...ids,
      likely_cause: `${detail}Stopped ${where}: the account ran out of credits.`,
      next_action: thenRerun(quota.next_action, rerun),
      suggested_commands: [...(quota.suggested_commands ?? []), rerun],
    });
  }
  if (failure_reason === "subscription_inactive") {
    const sub = subscriptionInactive(`${detail}Stopped ${where}`).toJSON();
    return new ToolkitError({
      ...sub,
      ...ids,
      next_action: thenRerun(sub.next_action, rerun),
      suggested_commands: [rerun],
    });
  }
  const why = [failure_reason, failure_detail].filter(Boolean).join(": ");
  return new ToolkitError({
    code: "BATCH_FAILED",
    message: `Batch job ${id} stopped before it finished.`,
    likely_cause: why || "The run ended in status failed without a reason.",
    next_action: `Check the run with \`zenrows batch status ${id}\`. Once the cause is fixed, run the unfinished tasks: \`${rerun}\`.`,
    suggested_commands: [`zenrows batch status ${id}`, rerun],
    ...ids,
  });
}

/** `next` followed by the command that runs the tasks a failure left unfinished. */
function thenRerun(next: string, rerun: string): string {
  return `${next}${/[.!?]$/.test(next) ? "" : "."} Then run the unfinished tasks: \`${rerun}\`.`;
}

/**
 * Print a job's latest run, structured under --json, and return the exit code:
 * 1 when the run ended `failed`, else 0. `stopped` and `deleted` are deliberate
 * outcomes (someone cancelled or removed the run), so they exit 0 but print as
 * a warning. `extra.note` says why a wait ended without a terminal run.
 */
function printJob(job: Job, json: boolean, headline: string, extra: { note?: string } = {}): number {
  const run = job.latest_run;
  const stats = run?.stats;
  const failure = failureFields(job);
  const err = runFailure(job);
  const paused = isPaused(run);
  const answer = pickAnswerFields(job);
  const ingest = run?.ingest_status;
  if (json) {
    log.out(
      JSON.stringify(
        {
          ok: !err,
          job_id: job.job_id,
          jobId: job.job_id,
          ...(run?.run_id ? { run_id: run.run_id } : {}),
          status: run?.status ?? null,
          ...(paused ? { paused: true } : {}),
          stats,
          ...failure,
          ...(ingest ? { ingest_status: ingest } : {}),
          ...answer,
          job,
          ...(extra.note ? { note: extra.note } : {}),
          ...(err ? { error: err.toJSON() } : {}),
        },
        null,
        2,
      ),
    );
    return err ? 1 : 0;
  }
  const line = `${headline} · status: ${run?.status ?? "no run yet"}${paused ? " (paused)" : ""}`;
  if (err) log.error(line);
  else if (run?.status === "stopped" || run?.status === "deleted" || paused || extra.note) log.warn(line);
  else log.success(line);
  if (run?.run_id) log.info(`  run: ${run.run_id}`);
  if (stats) {
    log.info(`  ${stats.completed}/${stats.total} completed · ${stats.successful} successful · ${stats.failed} failed`);
  }
  if (answer.accepted_tasks !== undefined) log.info(`  accepted_tasks: ${answer.accepted_tasks}`);
  if (answer.rerun_of) {
    log.info(`  rerun of ${answer.rerun_of}: ${answer.retried_tasks ?? 0} task(s) retried, ${answer.inherited_tasks ?? 0} carried over`);
  }
  if (ingest === "pending") log.dim("  ingest_status: pending (the API is still receiving the tasks; results stay partial until done)");
  if (failure.failure_reason) log.info(`  failure_reason: ${failure.failure_reason}`);
  if (failure.failure_detail) log.info(`  failure_detail: ${failure.failure_detail}`);
  if (!err && run?.status === "stopped" && stats && stats.completed < stats.total) {
    log.dim(`  ${stats.total - stats.completed} task(s) did not finish: zenrows batch rerun ${job.job_id} --status ${UNFINISHED}`);
  }
  if (extra.note) {
    log.dim(`  ${extra.note}`);
    log.dim(`  next: zenrows batch ${paused ? "resume" : "wait"} ${job.job_id}`);
  }
  if (err) printError(err, false);
  return err ? 1 : 0;
}

function normalizeResultStatus(v?: string): ResultStatus | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (s === "successful" || s === "failed" || s === "processing" || s === "all") return s;
  throw new ToolkitError({
    code: "INVALID_USAGE",
    message: `Invalid --status: ${v}`,
    likely_cause: "Only successful | failed | processing | all are supported.",
    next_action:
      "Use --status successful | failed | processing | all (default: all). processing lists the tasks not finished yet; expired rows come back with successful.",
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

/**
 * `--timeout` as a duration, returned in milliseconds; undefined when unset.
 * Takes `500ms`, `30s`, `5m` or `1h`; a bare number keeps its earlier meaning,
 * milliseconds.
 */
export function timeoutFlag(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const m = typeof v === "string" ? /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(v) : null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m?.[2] ?? "ms").toLowerCase() as "ms" | "s" | "m" | "h"];
  const ms = m ? Number(m[1]) * unit : NaN;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw usageError(
      `Invalid --timeout value '${String(v)}'.`,
      "Pass a duration such as --timeout 30s, 5m or 1h (a bare number is milliseconds).",
      "--timeout takes a positive duration.",
    );
  }
  return Math.round(ms);
}

/** `--limit` for a paged read: a whole number from 1 to `max`. */
function pageLimit(v: unknown, max: number): number | undefined {
  if (v === undefined) return undefined;
  const n = asNumber(v);
  if (n === undefined || !Number.isInteger(n) || n < 1 || n > max) {
    throw usageError(`Invalid --limit value '${String(v)}'.`, `Pass e.g. --limit ${Math.min(max, 50)}.`, `--limit takes a whole number from 1 to ${max}.`);
  }
  return n;
}

function oneOf(flag: string, v: string | undefined, allowed: string[]): string | undefined {
  if (v === undefined) return undefined;
  if (allowed.includes(v)) return v;
  throw usageError(`Invalid --${flag} '${v}'.`, `Pass --${flag} ${allowed.join(" or ")}, or leave it out.`);
}

function usageError(message: string, next_action: string, likely_cause = "A flag value is outside what the Batch API accepts."): ToolkitError {
  return new ToolkitError({ code: "INVALID_USAGE", message, likely_cause, next_action });
}

function requireId(id: string | undefined, sub: string): string {
  if (id) return id;
  throw new ToolkitError({
    code: "INVALID_USAGE",
    message: "Missing job id.",
    likely_cause: "No <id> positional was provided.",
    next_action: `Usage: zenrows batch ${sub} <id>. List your jobs with \`zenrows batch list\`.`,
    suggested_commands: ["zenrows batch list"],
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
