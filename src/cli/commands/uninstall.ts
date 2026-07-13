/**
 * `zenrows uninstall` — remove the local `.zenrows/` workspace.
 * Destructive: requires --yes (or interactive confirmation is refused).
 */
import { rmSync } from "node:fs";
import { log } from "../../core/logger.ts";
import { findWorkspace } from "../../core/workspace.ts";
import { type Command, type RunContext } from "../command.ts";

export const uninstall: Command = {
  name: "uninstall",
  summary: "Remove the local .zenrows/ workspace (requires --yes).",
  usage: "zenrows uninstall [--yes]",
  run(_argv: string[], ctx: RunContext): number {
    const ws = findWorkspace();
    if (!ws) {
      log.info("No .zenrows/ workspace found here.");
      return 0;
    }
    if (!ctx.yes) {
      log.warn(`This will delete ${ws.dir} (config, policy, runs, traces, installed assets).`);
      log.warn("Re-run with --yes to confirm. Your API key in .zenrows/secrets.json will also be removed.");
      return 1;
    }
    rmSync(ws.dir, { recursive: true, force: true });
    log.success(`Removed ${ws.dir}`);
    if (ctx.json) log.out(JSON.stringify({ ok: true, removed: ws.dir }, null, 2));
    return 0;
  },
};
