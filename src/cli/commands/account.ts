/**
 * `zenrows account <status|claim>` — inspect the auto-provisioned ZenRows
 * account and surface the human-facing claim link. Never handles payment or
 * upgrades; it only reports status and opens the claim URL.
 */
import { fetchAccountStatus, readAccount, writeAccount } from "../../core/agent-account.ts";
import { authState, resolveApiKey } from "../../core/auth.ts";
import { loadConfig } from "../../core/config.ts";
import { log } from "../../core/logger.ts";
import { openUrl } from "../../core/open-url.ts";
import { fetchUsage } from "../../core/usage.ts";
import { parse, type Command, type RunContext } from "../command.ts";

export const account: Command = {
  name: "account",
  summary: "Show the ZenRows account status and claim link.",
  usage: "zenrows account <status|claim> [--no-open]",
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const { values, positionals } = parse(argv, { "no-open": { type: "boolean" } });
    const sub = positionals[0] ?? "status";
    let acct = readAccount();
    const auth = authState();

    // Claiming happens in the browser, out-of-band from the CLI. If we hold an
    // unclaimed record and a key, ask the backend whether it has since been
    // claimed and refresh account.json. Best-effort — stay on local state offline.
    if (acct && acct.unclaimed && auth.hasKey) {
      const key = resolveApiKey().key;
      if (key) {
        try {
          const remote = await fetchAccountStatus(key);
          if (remote.claimed) {
            acct = { ...acct, unclaimed: false };
            writeAccount(acct);
          }
        } catch {
          // endpoint unavailable / offline — keep the local record
        }
      }
    }

    if (sub === "claim") {
      if (!acct) { log.info("No agent-created account to claim. Use `zenrows login --api-key` if you already have a key."); return 0; }
      if (!acct.unclaimed) {
        log.success("This account is already claimed.");
        if (ctx.json) log.out(JSON.stringify({ ok: true, claimed: true }, null, 2));
        return 0;
      }
      log.info("Claim this ZenRows account (set your email + password):");
      log.info(acct.claimUrl);
      if (!values["no-open"]) await openUrl(acct.claimUrl);
      if (ctx.json) log.out(JSON.stringify({ ok: true, claimUrl: acct.claimUrl }, null, 2));
      return 0;
    }

    // status — cycle dates from subscriptions/self/details
    let periodEndsAt: string | undefined;
    if (auth.hasKey) {
      const key = resolveApiKey().key;
      if (key) {
        try {
          const usage = await fetchUsage(loadConfig().apiBase, key);
          periodEndsAt = usage.period_ends_at;
        } catch {
          // offline / usage unavailable — status still useful without cycle dates
        }
      }
    }

    if (ctx.json) {
      log.out(JSON.stringify({ hasKey: auth.hasKey, account: acct ?? null, period_ends_at: periodEndsAt ?? null }, null, 2));
    } else if (acct) {
      log.info(`Account: ${acct.accountId} (${acct.unclaimed ? "unclaimed" : "claimed"})`);
      if (periodEndsAt) log.dim(`Billing period ends: ${periodEndsAt}`);
      if (acct.unclaimed) log.dim(`Claim it: ${acct.claimUrl}`);
    } else {
      log.info(auth.hasKey ? "Using a manually configured API key." : "No account yet. Run a command (e.g. `zenrows fetch <url>`) or `zenrows signup --agent`.");
      if (periodEndsAt) log.dim(`Billing period ends: ${periodEndsAt}`);
    }
    return 0;
  },
};
