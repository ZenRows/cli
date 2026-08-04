/**
 * `zenrows usage` — show plan usage, credits, and concurrency for the current
 * API key, via the Fetch and Extract API's `subscriptions/self/details`.
 */
import { requireApiKey } from "../../core/auth.ts";
import { loadConfig } from "../../core/config.ts";
import { log } from "../../core/logger.ts";
import { fetchUsage } from "../../core/usage.ts";
import { parse, type Command, type RunContext } from "../command.ts";

/** Free plan still ships as plan_code=trial in R1; display the product name. */
export function formatPlanName(name: string | undefined): string {
  if (!name) return "—";
  if (/^trial$/i.test(name.trim())) return "Free";
  return name;
}

/** Stripe/Cashier may still report trialing for the Free row — surface as active. */
export function formatPlanStatus(status: string | undefined): string {
  if (!status) return "—";
  if (/^trialing$/i.test(status.trim())) return "active";
  return status;
}

export const usage: Command = {
  name: "usage",
  summary: "Show plan usage, credits, and concurrency for the current API key.",
  usage: "zenrows usage [--json]",
  help: "Calls GET /v1/subscriptions/self/details (does not count against your concurrency limit).",
  async run(argv: string[], ctx: RunContext): Promise<number> {
    parse(argv, {});
    const config = loadConfig();
    const apiKey = requireApiKey();

    const u = await fetchUsage(config.apiBase, apiKey);

    if (ctx.json) {
      log.out(JSON.stringify({ ok: true, ...u }, null, 2));
      return 0;
    }

    const api = u.plan?.products?.api;
    log.info(`Plan:    ${formatPlanName(u.plan?.name)}${u.plan?.recurrence ? ` (${u.plan.recurrence})` : ""}`);
    log.info(`Status:  ${formatPlanStatus(u.status)}`);
    if (u.usage !== undefined) {
      log.info(`Usage:   ${u.usage}${u.usage_percent !== undefined ? ` (${u.usage_percent}% of plan)` : ""}`);
    }
    if (api?.concurrency) {
      log.info(`API concurrency: ${api.concurrency.usage ?? 0} in use / ${api.concurrency.limit ?? "—"} max`);
    }
    if (u.period_ends_at) log.info(`Billing period ends: ${u.period_ends_at}`);
    if (Array.isArray(u.top_ups) && u.top_ups.length) log.info(`Top-ups: ${u.top_ups.length}`);
    return 0;
  },
};
