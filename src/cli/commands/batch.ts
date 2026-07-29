/**
 * `zenrows batch` — Batch Scraper API (status: beta).
 *
 * Local (no key, always works): `estimate`/`create --dry-run`-style spec
 * validation + credit estimate. Cloud (needs a key + Batch beta access):
 * `create`, `status`, `results`, `cancel`, `wait`, `retry-failed`. Without beta
 * access the API returns 403 → BATCH_ACCESS_DENIED.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { log, ANSI, c } from "../../core/logger.ts";
import { estimateCredits, toJobBody, validateJsonl } from "../../adapters/batch.ts";
import { requireApiKey } from "../../core/auth.ts";
import { createJob, downloadResults, getJob, listResults, rerunJob, stopJob, waitForJob, type Job } from "../../core/batch-api.ts";
import { asNumber, asString, parse, type Command, type RunContext } from "../command.ts";
import { ToolkitError } from "../../core/errors.ts";
import { printError, writeOut } from "../output.ts";

export const batch: Command = {
  name: "batch",
  summary: "Run JSONL batch jobs on the Zenrows Batch Scraper API (beta).",
  usage: "zenrows batch <estimate|create <file.jsonl>|status <id>|results <id>|cancel <id>|wait <id>|retry-failed <id>>",
  help: [
    "Local (no key):",
    "  estimate <file.jsonl>            validate the spec + estimate credits",
    "Cloud (needs a key + Batch beta access):",
    "  create <file.jsonl> [flags]      validate, then submit the job",
    "    --js-render                    job-level: render JavaScript",
    "    --premium-proxy                job-level: use residential IPs",
    "    --proxy-country <cc>           job-level: geo-target (needs --premium-proxy)",
    "    --output <fmt>                 job-level response_type (markdown|plaintext|pdf)",
    "    --wait                         poll until the run finishes",
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

function estimateCmd(rest: string[], ctx: RunContext): number {
  const { positionals } = parse(rest, {});
  const file = positionals[0];
  if (!file) throw needFile();
  const v = validateJsonl(file);
  const est = estimateCredits(v.jobs);
  if (ctx.json) {
    log.out(JSON.stringify({ ...v, estimatedCredits: est.credits }, null, 2));
  } else {
    log.info(c(ANSI.bold, `Job spec: ${file}`));
    log.info(`valid jobs: ${v.validJobs}/${v.totalLines}`);
    log.info(`estimated credits (1x basic / 5x js / 10x proxy / 25x both): ${est.credits}`);
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
    output: { type: "string" },
    wait: { type: "boolean" },
    json: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  const file = positionals[0];
  if (!file) throw needFile();

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

  const jobParams: Record<string, unknown> = {};
  if (values["js-render"] === true) jobParams.js_render = true;
  if (values["premium-proxy"] === true) jobParams.premium_proxy = true;
  const proxyCountry = asString(values["proxy-country"]);
  if (proxyCountry) jobParams.proxy_country = proxyCountry;
  const responseType = normalizeOutput(asString(values.output));
  if (responseType) jobParams.response_type = responseType;

  // toJobBody validates proxy_country/premium_proxy BEFORE any HTTP call.
  const body = toJobBody(v.jobs, jobParams);
  const apiKey = requireApiKey();

  log.step(`Submitting batch job (${body.tasks.length} tasks)…`);
  const job = await createJob(body, { apiKey });
  const finished = values.wait === true ? await waitForJob(job.job_id, { apiKey }) : job;
  printJob(finished, json, `Submitted job ${job.job_id}`);
  return 0;
}

async function statusCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { positionals } = parse(rest, {});
  const id = requireId(positionals[0]);
  const apiKey = requireApiKey();
  const job = await getJob(id, { apiKey });
  printJob(job, ctx.json, `Job ${id}`);
  return 0;
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
  const apiKey = requireApiKey();
  const job = await stopJob(id, { apiKey });
  printJob(job, ctx.json, `Stopped job ${id}`);
  return 0;
}

async function waitCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { timeout: { type: "string" }, json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0]);
  const apiKey = requireApiKey();
  const job = await waitForJob(id, { apiKey, timeoutMs: asNumber(values.timeout) });
  printJob(job, json, `Job ${id} finished`);
  return 0;
}

async function retryCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { positionals } = parse(rest, {});
  const id = requireId(positionals[0]);
  const apiKey = requireApiKey();
  // "Reruns and retrying failures": POST /jobs/{id}/rerun?status=failed replays
  // only the failures; already-successful tasks carry over.
  const job = await rerunJob(id, { apiKey, status: "failed" });
  printJob(job, ctx.json, `Reran failed tasks for job ${id}`);
  return 0;
}

/** Print a job's status + stats, structured under --json. */
function printJob(job: Job, json: boolean, headline: string): void {
  const run = job.latest_run ?? ({} as Job["latest_run"]);
  const stats = run.stats;
  if (json) {
    log.out(JSON.stringify({ ok: true, jobId: job.job_id, status: run.status, stats }, null, 2));
    return;
  }
  log.success(`${headline} · status: ${run.status ?? "unknown"}`);
  if (stats) {
    log.info(`  ${stats.completed}/${stats.total} completed · ${stats.successful} successful · ${stats.failed} failed`);
  }
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
  const mapped = map[v.toLowerCase()];
  return mapped ? mapped : undefined;
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
