/** `zenrows logout` — clear the stored API key. */
import { clearApiKey } from "../../core/auth.ts";
import { log } from "../../core/logger.ts";
import type { Command, RunContext } from "../command.ts";

export const logout: Command = {
  name: "logout",
  summary: "Remove the stored API key from this workspace.",
  usage: "zenrows logout",
  run(_argv: string[], ctx: RunContext): number {
    const cleared = clearApiKey();
    if (cleared) log.success("Cleared stored API key.");
    else log.info("No stored API key to clear (ZENROWS_API_KEY env, if set, is untouched).");
    if (ctx.json) log.out(JSON.stringify({ ok: true, cleared }, null, 2));
    return 0;
  },
};
