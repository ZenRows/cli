/**
 * CLI entrypoint + router.
 *
 * Dispatches `zenrows <command> …` to a command module. Global flags: --json
 * (machine output), --yes (skip confirmations), --help / -h, --version / -v.
 * Normalized errors are printed with their code + next action and mapped to a
 * non-zero exit code.
 */
import { CLI_VERSION } from "../core/config.ts";
import { ToolkitError } from "../core/errors.ts";
import { log, ANSI, c } from "../core/logger.ts";
import { makeAssetCommand } from "./asset-command.ts";
import { printError } from "./output.ts";
import type { Command, RunContext } from "./command.ts";

import { init } from "./commands/init.ts";
import { signup } from "./commands/signup.ts";
import { account } from "./commands/account.ts";
import { login } from "./commands/login.ts";
import { logout } from "./commands/logout.ts";
import { status } from "./commands/status.ts";
import { usage } from "./commands/usage.ts";
import { update } from "./commands/update.ts";
import { uninstall } from "./commands/uninstall.ts";
import { config } from "./commands/config.ts";
import { policy } from "./commands/policy.ts";
import { fetch_ } from "./commands/fetch.ts";
import { extract } from "./commands/extract.ts";
import { batch } from "./commands/batch.ts";
import { browser } from "./commands/browser.ts";
import { mcp } from "./commands/mcp.ts";
import { plugin } from "./commands/plugin.ts";
import { trace } from "./commands/trace.ts";

export const VERSION = CLI_VERSION;

const skill = makeAssetCommand("skill", "Agent-readable instructions (decision-making playbooks).");
const template = makeAssetCommand("template", "Project scaffolds.");
const workflow = makeAssetCommand("workflow", "Multi-step agent/developer processes.");
const recipe = makeAssetCommand("recipe", "Small executable examples.");
const evalCmd = makeAssetCommand("eval", "Reproducible benchmark/test suites.");

/** Ordered groups for help output. */
const GROUPS: Array<{ title: string; commands: Command[] }> = [
  { title: "Setup", commands: [init, signup, account, login, logout, status, usage, update, uninstall, config, policy] },
  { title: "Primitives", commands: [fetch_, extract, batch, browser] },
  { title: "Distribution", commands: [mcp, plugin, skill, template, workflow, recipe, evalCmd, trace] },
];

const COMMANDS: Record<string, Command> = {};
for (const g of GROUPS) for (const cmd of g.commands) COMMANDS[cmd.name] = cmd;
// Aliases
COMMANDS["evals"] = evalCmd;

export async function main(rawArgv: string[]): Promise<number> {
  const argv = [...rawArgv];
  const json = takeFlag(argv, "--json");
  const yes = takeFlag(argv, "--yes") || takeFlag(argv, "-y");
  const wantHelp = takeFlag(argv, "--help") || takeFlag(argv, "-h");
  const wantVersion = takeFlag(argv, "--version") || takeFlag(argv, "-v");

  if (wantVersion) {
    log.out(VERSION);
    return 0;
  }

  const name = argv.shift();
  if (!name || (wantHelp && !COMMANDS[name])) {
    printTopHelp();
    return name ? 0 : wantHelp ? 0 : 1;
  }

  const cmd = COMMANDS[name];
  if (!cmd) {
    printError(
      new ToolkitError({
        code: "INVALID_USAGE",
        message: `Unknown command: ${name}`,
        likely_cause: "The command is not part of the CLI.",
        next_action: "Run `zenrows --help` to see all commands.",
      }),
      json,
    );
    return 1;
  }

  if (wantHelp) {
    printCommandHelp(cmd);
    return 0;
  }

  const ctx: RunContext = { json, yes };
  try {
    return await cmd.run(argv, ctx);
  } catch (err) {
    printError(err, json);
    return err instanceof ToolkitError && err.code === "CAPABILITY_UNAVAILABLE" ? 2 : 1;
  }
}

function takeFlag(argv: string[], flag: string): boolean {
  const i = argv.indexOf(flag);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}

function printTopHelp(): void {
  log.info(c(ANSI.bold, "zenrows") + " — ZenRows CLI");
  log.info("The open-source CLI, MCP, skills, templates, workflows, recipes, and evals layer");
  log.info("for giving AI agents reliable access to protected web data through ZenRows.");
  log.info("");
  log.info(c(ANSI.bold, "Usage:") + " zenrows <command> [args] [--json] [--yes]");
  for (const g of GROUPS) {
    log.info("");
    log.info(c(ANSI.bold, g.title));
    for (const cmd of g.commands) log.info(`  ${cmd.name.padEnd(12)} ${cmd.summary}`);
  }
  log.info("");
  log.info("Run `zenrows <command> --help` for command details.");
}

function printCommandHelp(cmd: Command): void {
  log.info(c(ANSI.bold, cmd.name) + " — " + cmd.summary);
  log.info("");
  log.info(c(ANSI.bold, "Usage: ") + cmd.usage);
  if (cmd.help) {
    log.info("");
    log.info(cmd.help);
  }
}
