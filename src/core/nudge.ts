/**
 * Proactive claim nudge.
 *
 * After a successful cloud call on an UNCLAIMED agent account, surface the claim
 * link BEFORE the account hits its usage wall — so the agent can hand the claim
 * URL to a human in time. Free plan credits renew monthly; claiming is about
 * ownership (email/password), not expiry.
 */
import type { AgentAccount, ToolkitConfig } from "../types/index.ts";
import { readAccount, writeAccount } from "./agent-account.ts";
import { resolveApiKey } from "./auth.ts";
import { log } from "./logger.ts";
import { fetchUsage } from "./usage.ts";

/** How high usage must be (percent) before we nudge. */
const USAGE_NUDGE_PERCENT = 80;
/** Minimum spacing between usage checks (throttle). */
const USAGE_CHECK_THROTTLE_MS = 10 * 60 * 1000;

/**
 * Build the claim-nudge message, or null if no nudge is warranted. Pure and
 * fully testable — takes the account and the current usage percent.
 * `now` is kept for callers/tests; Free has no time-based claim nudge.
 */
export function nudgeMessage(
  account: AgentAccount,
  usagePercent: number | undefined,
  _now?: Date,
): string | null {
  if (!account.unclaimed) return null;
  if (typeof usagePercent === "number" && usagePercent >= USAGE_NUDGE_PERCENT) {
    return `You've used ${usagePercent}% of your Zenrows Free plan — claim your account to keep your usage & history: ${account.claimUrl}`;
  }
  return null;
}

/**
 * Best-effort claim nudge after a successful command. Reads the local account,
 * fetches usage (throttled), records the check time, and logs a nudge if
 * warranted. Never throws — a nudge must never break the command that triggers it.
 */
export async function maybeNudgeClaim(
  config: ToolkitConfig,
  opts: { projectRoot?: string; apiKey?: string; fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<void> {
  try {
    const { projectRoot } = opts;
    const acct = readAccount(projectRoot);
    if (!acct?.unclaimed) return;

    const key = opts.apiKey ?? resolveApiKey(projectRoot).key;
    if (!key) return;

    const now = opts.now ?? new Date();
    if (acct.lastUsageCheckAt) {
      const last = new Date(acct.lastUsageCheckAt).getTime();
      if (!Number.isNaN(last) && now.getTime() - last < USAGE_CHECK_THROTTLE_MS) return;
    }

    let usage;
    try {
      usage = await fetchUsage(config.apiBase, key, { fetchImpl: opts.fetchImpl });
    } catch {
      return;
    }

    writeAccount({ ...acct, lastUsageCheckAt: now.toISOString() }, projectRoot);

    const msg = nudgeMessage(acct, usage.usage_percent, now);
    if (msg) log.warn(msg);
  } catch {
    // A nudge must never break the command it follows.
  }
}
