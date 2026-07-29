/** `zenrows logout` — clear stored credentials for this workspace. */
import { clearAccount } from "../../core/agent-account.ts";
import { clearApiKey, ENV_KEY } from "../../core/auth.ts";
import { log } from "../../core/logger.ts";
import type { Command, RunContext } from "../command.ts";

export const logout: Command = {
  name: "logout",
  summary: "Remove the stored API key (and agent account record) from this workspace.",
  usage: "zenrows logout",
  run(_argv: string[], ctx: RunContext): number {
    const clearedKey = clearApiKey();
    const clearedAccount = clearAccount();
    const envSet = Boolean(process.env[ENV_KEY]?.trim());

    if (clearedKey || clearedAccount) {
      log.success(
        clearedKey && clearedAccount
          ? "Cleared stored API key and agent account."
          : clearedKey
            ? "Cleared stored API key."
            : "Cleared local agent account record.",
      );
    } else {
      log.info(`No stored API key or agent account to clear.`);
    }

    if (envSet) {
      log.warn(
        `${ENV_KEY} is still set in this shell — the CLI will keep using it. Run \`unset ${ENV_KEY}\` to fully deauthenticate.`,
      );
    }

    if (ctx.json) {
      log.out(JSON.stringify({ ok: true, clearedKey, clearedAccount, envStillSet: envSet }, null, 2));
    }
    return 0;
  },
};
