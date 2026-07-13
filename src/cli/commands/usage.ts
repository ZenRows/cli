/**
 * `zenrows usage` — show plan usage, credits, and concurrency for the current
 * API key, via the Universal Scraper API's `subscriptions/self/details`.
 */
import { requireApiKey } from "../../core/auth.ts";
import { loadConfig } from "../../core/config.ts";
import { log } from "../../core/logger.ts";
import { fetchUsage } from "../../core/usage.ts";
import { parse, type Command, type RunContext } from "../command.ts";

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
      log.out(JSON.stringify(u, null, 2));
      return 0;
    }

    const api = u.plan?.products?.api;
    log.info(`Plan:    ${u.plan?.name ?? "—"}${u.plan?.recurrence ? ` (${u.plan.recurrence})` : ""}`);
    log.info(`Status:  ${u.status ?? "—"}`);
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
