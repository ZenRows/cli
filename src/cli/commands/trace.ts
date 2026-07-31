/**
 * `zenrows trace` — inspect, explain, replay, export run artifacts.
 *
 * `explain` is agent-facing: it states what happened, the likely failure
 * reason, the evidence, the recommended next action, and an exact command.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log, ANSI, c } from "../../core/logger.ts";
import { ToolkitError } from "../../core/errors.ts";
import { findWorkspace } from "../../core/workspace.ts";
import { type Command, type RunContext } from "../command.ts";

interface RunRecord {
  runId: string;
  command: string;
  capability: string;
  url?: string;
  status: "ok" | "error";
  request?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string; likely_cause?: string; next_action?: string; suggested_commands?: string[] };
  costUsd?: number | null;
  costCredits?: number | null;
}

export const trace: Command = {
  name: "trace",
  summary: "Inspect/explain/replay/export a run by id.",
  usage: "zenrows trace <inspect|explain|replay|export> <run-id>",
  run(argv: string[], ctx: RunContext): number {
    const [sub, runId] = argv;
    if (!sub || !runId) {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: "Usage: zenrows trace <inspect|explain|replay|export> <run-id>",
        likely_cause: "Missing subcommand or run id.",
        next_action: "List runs under .zenrows/runs/ and pass an id.",
      });
    }
    const rec = loadRun(runId);

    if (sub === "inspect") {
      log.out(JSON.stringify(rec, null, 2));
      return 0;
    }
    if (sub === "export") {
      log.out(JSON.stringify(rec, null, 2));
      log.dim(`(piped JSON for run ${runId})`);
      return 0;
    }
    if (sub === "replay") {
      const cmd = rebuildCommand(rec);
      if (ctx.json) {
        log.out(JSON.stringify({ runId, replay: cmd }, null, 2));
      } else {
        log.info("Replay this run with:");
        log.out(cmd);
      }
      return 0;
    }
    if (sub === "explain") {
      return explain(rec, ctx);
    }
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Unknown trace subcommand: ${sub}`,
      likely_cause: "Subcommand not recognized.",
      next_action: "Use inspect | explain | replay | export.",
    });
  },
};

function loadRun(runId: string): RunRecord {
  const ws = findWorkspace();
  if (!ws) throw noWorkspace();
  const file = join(ws.dir, "runs", runId, "run.json");
  if (!existsSync(file)) {
    throw new ToolkitError({
      code: "ASSET_NOT_FOUND",
      message: `No run found: ${runId}`,
      likely_cause: "The run id does not exist under .zenrows/runs/.",
      next_action: "List runs: ls .zenrows/runs",
    });
  }
  return JSON.parse(readFileSync(file, "utf8")) as RunRecord;
}

function explain(rec: RunRecord, ctx: RunContext): number {
  const ok = rec.status === "ok";
  const what = ok
    ? `${rec.command} on ${rec.url ?? "n/a"} succeeded (HTTP ${rec.result?.httpStatus ?? "?"}, ${rec.result?.bytes ?? "?"} bytes).`
    : `${rec.command} on ${rec.url ?? "n/a"} failed.`;
  const reason = ok ? "none" : rec.error?.likely_cause ?? rec.error?.message ?? "unknown";
  const nextAction = ok
    ? "Reuse these parameters for similar targets; consider capturing them as a skill."
    : rec.error?.next_action ?? "Retry with --manual --js-render --premium-proxy.";
  const suggested = ok
    ? [rec.url ? `zenrows skill generate --from-run ${rec.runId}` : "zenrows status"]
    : rec.error?.suggested_commands?.length
      ? rec.error.suggested_commands
      : [rebuildCommand(rec) + " --manual --js-render --premium-proxy"];

  if (ctx.json) {
    log.out(JSON.stringify({ runId: rec.runId, what_happened: what, likely_failure_reason: reason, evidence: rec, recommended_next_action: nextAction, suggested_commands: suggested }, null, 2));
    return 0;
  }
  log.info(c(ANSI.bold, `Trace explain · ${rec.runId}`));
  log.info(`what happened:   ${what}`);
  log.info(`failure reason:  ${reason}`);
  log.info(`evidence:        status=${rec.status} cost=$${(rec.costUsd ?? 0).toFixed(4)}${rec.costCredits != null ? ` · ${rec.costCredits} credit${rec.costCredits === 1 ? "" : "s"}` : ""} cap=${rec.capability}`);
  log.info(`next action:     ${nextAction}`);
  log.info("suggested:");
  suggested.forEach((s) => process.stderr.write("  " + c(ANSI.cyan, "$ " + s) + "\n"));
  return ok ? 0 : 1;
}

function rebuildCommand(rec: RunRecord): string {
  const req = rec.request ?? {};
  const parts = [rec.command];
  if (rec.url) parts.push(rec.url);
  if (req.mode === undefined && req.manual) parts.push("--manual");
  if (req.js_render) parts.push("--js-render");
  if (req.premium_proxy) parts.push("--premium-proxy");
  if (req.proxy_country) parts.push(`--proxy-country ${req.proxy_country}`);
  if (req.wait) parts.push(`--wait ${req.wait}`);
  if (req.wait_for) parts.push(`--wait-for '${req.wait_for}'`);
  return parts.join(" ");
}

function noWorkspace(): ToolkitError {
  return new ToolkitError({
    code: "INVALID_USAGE",
    message: "No workspace found.",
    likely_cause: ".zenrows/ does not exist here.",
    next_action: "Run `zenrows init` first.",
    suggested_commands: ["zenrows init"],
  });
}
