/** `zenrows update` — refresh installed assets and show how to update the CLI. */
import { log } from "../../core/logger.ts";
import { installAsset, listInstalled, requireAsset } from "../../core/registry.ts";
import type { AssetType } from "../../types/index.ts";
import type { Command, RunContext } from "../command.ts";

const TYPES: AssetType[] = ["skill", "template", "workflow", "recipe", "eval"];

export const update: Command = {
  name: "update",
  summary: "Refresh installed assets; print how to update the CLI itself.",
  usage: "zenrows update",
  run(_argv: string[], ctx: RunContext): number {
    let refreshed = 0;
    for (const t of TYPES) {
      for (const name of listInstalled(t)) {
        installAsset(requireAsset(t, name));
        refreshed++;
      }
    }
    log.success(`Refreshed ${refreshed} installed asset(s) from the bundled registry.`);
    log.info("To update the CLI itself: npm i -g @zenrows/cli@latest  (or rerun via npx -y).");
    if (ctx.json) log.out(JSON.stringify({ ok: true, refreshed }, null, 2));
    return 0;
  },
};
