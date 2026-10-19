/**
 * `zenrows account <status|claim>` — inspect the auto-provisioned Zenrows
 * account and surface the human-facing claim link. Never handles payment or
 * upgrades; it only reports status and opens the claim URL, asking the API for
 * a fresh one when the stored link is missing or close to its 30-day expiry.
 */
import { fetchAccountStatus, readAccount, writeAccount } from "../../core/agent-account.ts";
import { authState, ENV_KEY, resolveApiKey } from "../../core/auth.ts";
import { refreshClaimState, usableClaimUrl } from "../../core/claim-link.ts";
import { loadConfig } from "../../core/config.ts";
import { ToolkitError } from "../../core/errors.ts";
import { log } from "../../core/logger.ts";
import { openUrl } from "../../core/open-url.ts";
import { fetchUsage } from "../../core/usage.ts";
import { parse, type Command, type RunContext } from "../command.ts";

export const account: Command = {
  name: "account",
  summary: "Show the Zenrows account status and claim link.",
  usage: "zenrows account <status|claim> [--no-open]",
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const { values, positionals } = parse(argv, { "no-open": { type: "boolean" } });
    const sub = positionals[0] ?? "status";
    const auth = authState();

    if (sub === "claim") {
      const state = await refreshClaimState({ force: true });
      if (state.status === "none") {
        log.info("No agent-created account to claim. Use `zenrows login --api-key` if you already have a key.");
        return 0;
      }
      if (state.status === "claimed") {
        log.success("This account is already claimed. Nothing to do: the same API key keeps working.");
        if (ctx.json) log.out(JSON.stringify({ ok: true, claimed: true }, null, 2));
        return 0;
      }
      if (!state.claimUrl) {
        throw new ToolkitError({
          code: "FETCH_FAILED",
          message: "No valid claim link is available.",
          likely_cause: auth.hasKey
            ? "The stored claim link expired and a fresh one could not be requested."
            : "The stored claim link expired, and no API key is configured to request a fresh one.",
          next_action: "Check connectivity and run `zenrows account claim` again.",
          suggested_commands: ["zenrows account claim"],
        });
      }
      log.info("Claim this Zenrows account: open the link and confirm your email (Google, GitHub or a 6-digit code).");
      log.info(state.claimUrl);
      if (!values["no-open"]) await openUrl(state.claimUrl);
      if (ctx.json) log.out(JSON.stringify({ ok: true, claimUrl: state.claimUrl, refreshed: state.refreshed }, null, 2));
      return 0;
    }

    let acct = readAccount();
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
        }
      }
    }

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
      log.out(JSON.stringify({
        ok: true,
        hasKey: auth.hasKey,
        source: auth.source,
        account: acct ?? null,
        period_ends_at: periodEndsAt ?? null,
      }, null, 2));
    } else if (acct) {
      log.info(`Account: ${acct.accountId} (${acct.unclaimed ? "unclaimed" : "claimed"})`);
      if (auth.hasKey) log.dim(`Key source: ${auth.source}`);
      if (periodEndsAt) log.dim(`Billing period ends: ${periodEndsAt}`);
      if (acct.unclaimed) log.dim(`Claim it: ${usableClaimUrl(acct) ?? "run `zenrows account claim` for a fresh link"}`);
    } else {
      if (auth.hasKey) {
        log.info(
          auth.source === "env"
            ? `Using API key from ${ENV_KEY} (environment).`
            : "Using a manually configured API key (secrets file).",
        );
      } else {
        log.info("No account yet. Run a command (e.g. `zenrows fetch <url>`) or `zenrows signup --agent`.");
      }
      if (periodEndsAt) log.dim(`Billing period ends: ${periodEndsAt}`);
    }
    return 0;
  },
};
