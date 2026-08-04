/**
 * Generic command factory for registry-backed asset types:
 * skill / template / workflow / recipe / eval.
 *
 * Shared subcommands: list, install, explain, remove, update.
 * Type-specific: template create; skill validate/generate; recipe/eval run;
 * eval report. Commands that execute (run/report) consult the capability
 * matrix and refuse honestly when a required primitive is unavailable.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AssetType, RegistryAsset } from "../types/index.ts";
import { ToolkitError } from "../core/errors.ts";
import { log, ANSI, c } from "../core/logger.ts";
import { loadConfig } from "../core/config.ts";
import { loadPolicy } from "../core/policy.ts";
import { requireApiKey, resolveApiKey } from "../core/auth.ts";
import { pkgPath } from "../core/paths.ts";
import { findWorkspace, workspacePaths } from "../core/workspace.ts";
import {
  assertAssetRunnable,
  assetRunnable,
  installAsset,
  listInstalled,
  loadRegistry,
  removeInstalledAsset,
  requireAsset,
} from "../core/registry.ts";
import { isLocalStep, loadStepSpec, runStep, type RunStep, type StepResult } from "./runner.ts";
import type { Command, RunContext } from "./command.ts";

const STATUS_BADGE: Record<string, string> = {
  available: "✓ available",
  experimental: "~ experimental",
  beta: "◐ beta",
  planned: "… planned",
  deprecated: "✗ deprecated",
};

export function makeAssetCommand(type: AssetType, summary: string): Command {
  return {
    name: type,
    summary,
    usage: `zenrows ${type} <list|install|explain|remove|update${extraUsage(type)}> [name] [flags]`,
    help: helpFor(type),
    run(argv: string[], ctx: RunContext): Promise<number> | number {
      const [sub, ...rest] = argv;
      switch (sub) {
        case undefined:
        case "list":
          return listCmd(type, rest, ctx);
        case "install":
          return installCmd(type, rest, ctx);
        case "explain":
          return explainCmd(type, rest, ctx);
        case "remove":
          return removeCmd(type, rest, ctx);
        case "update":
          return updateCmd(type, rest, ctx);
        case "validate":
          if (type === "skill") return validateSkill(rest, ctx);
          break;
        case "generate":
          if (type === "skill") return generateSkill(rest, ctx);
          break;
        case "create":
          if (type === "template") return createTemplate(rest, ctx);
          break;
        case "run":
          if (type === "recipe" || type === "eval" || type === "workflow") return runCmd(type, rest, ctx);
          break;
        case "report":
          if (type === "eval") return reportCmd(rest, ctx);
          break;
      }
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: `Unknown ${type} subcommand: ${sub}`,
        likely_cause: "The subcommand is not supported for this asset type.",
        next_action: `Run \`zenrows ${type}\` with no args to list, or see \`zenrows ${type} --help\`.`,
      });
    },
  };
}

function extraUsage(type: AssetType): string {
  if (type === "skill") return "|validate|generate";
  if (type === "template") return "|create";
  if (type === "recipe") return "|run|explain";
  if (type === "workflow") return "|run|explain";
  if (type === "eval") return "|run|report";
  return "";
}

function helpFor(type: AssetType): string {
  const lines = [`Manage ${type}s from the installable asset registry.`, ""];
  lines.push("Subcommands:");
  lines.push(`  list                 list all ${type}s in the registry (status-aware)`);
  lines.push(`  install <name>       copy a ${type} into .zenrows/`);
  if (type === "skill") lines.push("  install --all        install every available skill");
  lines.push(`  explain <name>       print metadata + docs for a ${type}`);
  lines.push(`  update [name]        reinstall (refresh) installed ${type}s`);
  lines.push(`  remove <name>        remove an installed ${type}`);
  if (type === "template") lines.push("  create <name> --output <dir>   instantiate a template into <dir>");
  if (type === "skill") {
    lines.push("  validate <name>      validate an installed skill");
    lines.push("  generate --from-run <run-id>   scaffold a skill from a run");
  }
  if (type === "recipe" || type === "workflow") lines.push(`  run <name>           run if all required capabilities are available`);
  if (type === "eval") {
    lines.push("  run <name>           run the eval (writes a report tree)");
    lines.push("  report <name-or-run-id>   print a previous eval report");
  }
  return lines.join("\n");
}

function listCmd(type: AssetType, _argv: string[], ctx: RunContext): number {
  const assets = loadRegistry(type);
  const installed = new Set(listInstalled(type));
  if (ctx.json) {
    log.out(
      JSON.stringify(
        { ok: true, type, assets: assets.map((a) => ({ ...a, installed: installed.has(a.name), runnable: assetRunnable(a) })) },
        null,
        2,
      ),
    );
    return 0;
  }
  if (assets.length === 0) {
    log.info(`No ${type}s declared in the registry yet.`);
    return 0;
  }
  log.info(c(ANSI.bold, `${type}s:`));
  for (const a of assets) {
    const badge = STATUS_BADGE[a.status] ?? a.status;
    const mark = installed.has(a.name) ? c(ANSI.green, " [installed]") : "";
    log.info(`  ${a.name.padEnd(28)} ${badge.padEnd(16)}${mark}`);
    log.dim(`      ${a.description}`);
  }
  return 0;
}

function installCmd(type: AssetType, argv: string[], ctx: RunContext): number {
  const all = argv.includes("--all");
  const targets = all
    ? loadRegistry(type).filter(assetRunnable) // everything whose backend deps are usable (incl. beta) — matches `plugin install`
    : argv.filter((a) => !a.startsWith("-")).map((name) => requireAsset(type, name));
  if (targets.length === 0) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Nothing to install.`,
      likely_cause: "No asset name was given and --all was not passed.",
      next_action: `Run \`zenrows ${type} list\` then \`zenrows ${type} install <name>\`.`,
    });
  }
  const done: string[] = [];
  for (const asset of targets) {
    const res = installAsset(asset);
    done.push(asset.name);
    log.success(`Installed ${type} "${asset.name}" → ${res.path}`);
    if (!assetRunnable(asset)) {
      log.warn(`  "${asset.name}" depends on capabilities not available yet: ${asset.requires_backend_capabilities.join(", ")}`);
    }
  }
  if (ctx.json) log.out(JSON.stringify({ ok: true, installed: done }, null, 2));
  return 0;
}

function explainCmd(type: AssetType, argv: string[], ctx: RunContext): number {
  const name = argv.find((a) => !a.startsWith("-"));
  if (!name) throw usageErr(type, "explain <name>");
  const asset = requireAsset(type, name);
  if (ctx.json) {
    log.out(JSON.stringify({ ok: true, ...asset, runnable: assetRunnable(asset) }, null, 2));
    return 0;
  }
  log.info(c(ANSI.bold, `${asset.name}  (${asset.type}, ${asset.status})`));
  log.info(asset.description);
  log.info("");
  log.info(`requires capabilities: ${asset.requires_backend_capabilities.join(", ") || "(none)"}`);
  log.info(`runnable now:          ${assetRunnable(asset) ? "yes" : "no"}`);
  const doc = readDoc(asset);
  if (doc) {
    log.info("");
    log.info(doc);
  }
  return 0;
}

function removeCmd(type: AssetType, argv: string[], ctx: RunContext): number {
  const name = argv.find((a) => !a.startsWith("-"));
  if (!name) throw usageErr(type, "remove <name>");
  if (!ctx.yes) {
    log.warn(`Removing ${type} "${name}" from the workspace. Re-run with --yes to confirm.`);
    return 1;
  }
  const ok = removeInstalledAsset(type, name);
  if (ok) log.success(`Removed ${type} "${name}".`);
  else log.warn(`${type} "${name}" was not installed.`);
  return 0;
}

function updateCmd(type: AssetType, argv: string[], _ctx: RunContext): number {
  const names = argv.filter((a) => !a.startsWith("-"));
  const installed = names.length ? names : listInstalled(type);
  if (installed.length === 0) {
    log.info(`No installed ${type}s to update.`);
    return 0;
  }
  for (const name of installed) {
    const asset = requireAsset(type, name);
    installAsset(asset);
    log.success(`Updated ${type} "${name}".`);
  }
  return 0;
}

function createTemplate(argv: string[], _ctx: RunContext): number {
  const name = argv.find((a) => !a.startsWith("-"));
  const outIdx = argv.indexOf("--output");
  const output = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (!name || !output) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Usage: zenrows template create <name> --output <dir>",
      likely_cause: "Missing template name or --output directory.",
      next_action: "Provide both a registry template name and a target directory.",
    });
  }
  const asset = requireAsset("template", name);
  const src = pkgPath(asset.path);
  if (!existsSync(src)) throw new ToolkitError({
    code: "ASSET_NOT_FOUND",
    message: `Template source missing: ${asset.path}`,
    likely_cause: "Packaging error.",
    next_action: "Reinstall the toolkit.",
  });
  mkdirSync(output, { recursive: true });
  copyDir(src, output);
  log.success(`Template "${name}" instantiated into ${output}`);
  return 0;
}

function validateSkill(argv: string[], ctx: RunContext): number {
  const name = argv.find((a) => !a.startsWith("-"));
  if (!name) throw usageErr("skill", "validate <name>");
  const asset = requireAsset("skill", name);
  const src = pkgPath(asset.path, "SKILL.md");
  const errors: string[] = [];
  if (!existsSync(src)) errors.push("missing SKILL.md");
  else {
    const body = readFileSync(src, "utf8");
    if (!/^#\s+/m.test(body)) errors.push("SKILL.md has no top-level heading");
    if (body.length < 80) errors.push("SKILL.md is suspiciously short");
    if (/apikey=|ZENROWS_API_KEY=[A-Za-z0-9]/.test(body)) errors.push("SKILL.md may contain a secret");
  }
  if (ctx.json) {
    log.out(JSON.stringify({ ok: errors.length === 0, name, valid: errors.length === 0, errors }, null, 2));
  } else if (errors.length === 0) {
    log.success(`Skill "${name}" is valid.`);
  } else {
    log.error(`Skill "${name}" has issues:`);
    errors.forEach((e) => log.dim(`  - ${e}`));
  }
  return errors.length === 0 ? 0 : 1;
}

function generateSkill(argv: string[], _ctx: RunContext): number {
  const idx = argv.indexOf("--from-run");
  const runId = idx >= 0 ? argv[idx + 1] : undefined;
  if (!runId) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Usage: zenrows skill generate --from-run <run-id>",
      likely_cause: "No run id was provided.",
      next_action: "Find a run id under .zenrows/runs/ and pass it with --from-run.",
      suggested_commands: ["zenrows trace inspect <run-id>"],
    });
  }
  const ws = findWorkspace() ?? workspacePaths();
  const runFile = join(ws.dir, "runs", runId, "run.json");
  if (!existsSync(runFile)) {
    throw new ToolkitError({
      code: "ASSET_NOT_FOUND",
      message: `No run found: ${runId}`,
      likely_cause: "The run id does not exist under .zenrows/runs/.",
      next_action: "List runs with `ls .zenrows/runs` and retry.",
    });
  }
  const run = JSON.parse(readFileSync(runFile, "utf8")) as Record<string, unknown>;
  const dest = join(ws.dir, "skills", `generated-${runId}`);
  mkdirSync(dest, { recursive: true });
  const md = [
    `# Skill: generated from run ${runId}`,
    "",
    `Captured from \`${run.command ?? "unknown"}\` against \`${run.url ?? "n/a"}\`.`,
    "",
    "## When to use",
    "Reuse the parameters below for similar targets.",
    "",
    "## Parameters",
    "```json",
    JSON.stringify(run.request ?? {}, null, 2),
    "```",
    "",
    "_Generated by `zenrows skill generate`. Review before sharing — never commit secrets._",
  ].join("\n");
  writeFileSync(join(dest, "SKILL.md"), md + "\n");
  log.success(`Scaffolded skill from run ${runId} → ${dest}`);
  return 0;
}

async function runCmd(type: AssetType, argv: string[], ctx: RunContext): Promise<number> {
  const name = argv.find((a) => !a.startsWith("-"));
  if (!name) throw usageErr(type, "run <name>");
  const asset = requireAsset(type, name);
  assertAssetRunnable(asset, type === "eval" ? "EVAL_REQUIRES_CAPABILITY" : "ASSET_REQUIRES_CAPABILITY");

  const spec = loadStepSpec(pkgPath(asset.path));
  if (!spec) {
    // No executable spec: workflows/recipes without one are explain-only in V1.
    log.warn(`"${name}" has no executable spec.json yet — showing its docs instead.`);
    return explainCmd(type, [name], ctx);
  }

  const config = loadConfig();
  const policy = loadPolicy();
  // Local-only specs (e.g. batch-estimate) need no key; only require one when a
  // step actually calls the cloud.
  const needsKey = spec.steps.some((s) => !isLocalStep(s));
  const apiKey = needsKey ? requireApiKey() : (resolveApiKey().key ?? "");
  const assetDir = pkgPath(asset.path);

  log.step(`Running ${type} "${name}" (${spec.steps.length} step(s))…`);
  const results: StepResult[] = [];
  for (const step of spec.steps) {
    const r = await runStep(step, config, policy, apiKey, assetDir);
    results.push(r);
    const target = stepTarget(step);
    if (r.ok) log.success(`  ${step.kind} ${target} → ${stepOutcome(r)}`);
    else log.error(`  ${step.kind} ${target} → FAILED: ${r.failureReason}`);
  }
  const passed = results.filter((r) => r.ok).length;

  if (type === "eval") {
    const dir = writeEvalReport(asset, spec, results);
    log.success(`Eval "${name}": ${passed}/${results.length} passed. Report → ${dir}`);
  } else {
    log.success(`${type} "${name}": ${passed}/${results.length} steps ok.`);
  }
  if (ctx.json) {
    log.out(JSON.stringify({ ok: passed === results.length, name, passed, total: results.length, results: results.map(safeResult) }, null, 2));
  }
  return passed === results.length ? 0 : 1;
}

function reportCmd(argv: string[], ctx: RunContext): number {
  const id = argv.find((a) => !a.startsWith("-"));
  if (!id) throw usageErr("eval", "report <name-or-run-id>");
  const ws = findWorkspace() ?? workspacePaths();
  const evalsDir = join(ws.dir, "evals");
  if (!existsSync(evalsDir)) {
    throw new ToolkitError({
      code: "ASSET_NOT_FOUND",
      message: "No eval runs found.",
      likely_cause: ".zenrows/evals/ is empty.",
      next_action: "Run an eval first: zenrows eval run protected-fetch-smoke",
      suggested_commands: ["zenrows eval run protected-fetch-smoke"],
    });
  }
  // Resolve by run-id dir, else newest dir whose name starts with the eval name.
  const dirs = readdirSync(evalsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const match = dirs.includes(id) ? id : dirs.filter((d) => d.startsWith(id)).sort().at(-1);
  if (!match) {
    throw new ToolkitError({
      code: "ASSET_NOT_FOUND",
      message: `No eval report matches "${id}".`,
      likely_cause: "The id is not an eval-run id and no run matches that eval name.",
      next_action: `Available: ${dirs.join(", ") || "(none)"}`,
    });
  }
  const reportPath = join(evalsDir, match, "report.md");
  if (ctx.json) {
    const results = JSON.parse(readFileSync(join(evalsDir, match, "results.json"), "utf8"));
    log.out(JSON.stringify(results, null, 2));
  } else {
    log.out(readFileSync(reportPath, "utf8"));
  }
  return 0;
}

// ---- helpers ----

function writeEvalReport(asset: RegistryAsset, spec: { description?: string }, results: StepResult[]): string {
  const ws = findWorkspace() ?? workspacePaths();
  const runId = `${asset.name}-${randomUUID().slice(0, 8)}`;
  const dir = join(ws.dir, "evals", runId);
  mkdirSync(join(dir, "traces"), { recursive: true });
  const passed = results.filter((r) => r.ok).length;
  const totalCost = results.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const totalCredits = results.reduce((a, r) => a + (r.costCredits ?? 0), 0);

  writeFileSync(join(dir, "input.json"), JSON.stringify({ eval: asset.name, spec }, null, 2) + "\n");
  writeFileSync(join(dir, "results.json"), JSON.stringify({ runId, passed, total: results.length, results: results.map(safeResult) }, null, 2) + "\n");
  writeFileSync(
    join(dir, "cost.json"),
    JSON.stringify(
      {
        totalCostUsd: totalCost,
        totalCredits,
        perStep: results.map((r) => ({ costUsd: r.costUsd ?? 0, costCredits: r.costCredits ?? 0 })),
      },
      null,
      2,
    ) + "\n",
  );
  const failures = results.filter((r) => !r.ok).map((r) => JSON.stringify(safeResult(r))).join("\n");
  writeFileSync(join(dir, "failures.jsonl"), failures ? failures + "\n" : "");
  const report = [
    `# Eval report: ${asset.name}`,
    "",
    `- run id: \`${runId}\``,
    `- success rate: ${passed}/${results.length}`,
    `- approx cost (USD): ${totalCost.toFixed(4)}`,
    `- approx credits: ${totalCredits}`,
    "",
    "## Targets & results",
    ...results.map(
      (r) => `- ${r.ok ? "PASS" : "FAIL"} — ${r.step.kind} ${stepTarget(r.step)}` + (r.failureReason ? ` (${r.failureReason})` : ` (${stepOutcome(r)})`),
    ),
    "",
    "_Reproducible: targets and config above. No competitor keys are bundled; comparison evals require you to supply your own credentials._",
  ].join("\n");
  writeFileSync(join(dir, "report.md"), report + "\n");
  return dir;
}

/** Display target for a step: the URL (fetch/extract) or the spec file (batch-estimate). */
function stepTarget(step: RunStep): string {
  return step.url ?? step.file ?? "";
}

/** One-line outcome summary, shaped per step kind. */
function stepOutcome(r: StepResult): string {
  if (r.estimatedCredits !== undefined) return `${r.bytes} valid job(s), ~${r.estimatedCredits} credits`;
  return `${r.status} (${r.bytes} bytes)`;
}

function safeResult(r: StepResult) {
  return {
    kind: r.step.kind,
    target: stepTarget(r.step),
    ok: r.ok,
    status: r.status,
    bytes: r.bytes,
    costUsd: r.costUsd,
    costCredits: r.costCredits,
    estimatedCredits: r.estimatedCredits,
    requestId: r.requestId,
    failureReason: r.failureReason,
  };
}

function readDoc(asset: RegistryAsset): string | null {
  for (const f of ["SKILL.md", "README.md", "WORKFLOW.md", "RECIPE.md"]) {
    const p = pkgPath(asset.path, f);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return null;
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

function usageErr(type: AssetType, form: string): ToolkitError {
  return new ToolkitError({
    code: "INVALID_USAGE",
    message: `Usage: zenrows ${type} ${form}`,
    likely_cause: "A required argument is missing.",
    next_action: `See \`zenrows ${type} --help\`.`,
  });
}
