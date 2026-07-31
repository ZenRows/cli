/**
 * `zenrows browser` — Interact / Browser Sessions (status: experimental).
 *
 * Browser is an ESCALATION layer, not the default. There is no documented REST
 * "sessions" API; Zenrows exposes Browser Sessions (CDP) and browser_*
 * tools via the @zenrows/mcp server. So this command is gated behind
 * policy.allow_browser and points users to those surfaces rather than faking a
 * sessions API.
 */
import { loadPolicy, assertBrowserAllowed } from "../../core/policy.ts";
import { getCapability } from "../../core/capabilities.ts";
import { log, ANSI, c } from "../../core/logger.ts";
import { type Command, type RunContext } from "../command.ts";
import { printError } from "../output.ts";

export const browser: Command = {
  name: "browser",
  summary: "Browser sessions — escalation only (experimental, via Browser Sessions / MCP).",
  usage: "zenrows browser <info> (escalation-only; disabled unless policy.allow_browser=true)",
  help: "Use this only when Protected Fetch / Extract cannot do the job (logins, multi-step flows). Backed by Zenrows Browser Sessions and @zenrows/mcp browser_* tools.",
  run(_argv: string[], ctx: RunContext): number {
    const policy = loadPolicy();
    try {
      assertBrowserAllowed(policy);
    } catch (err) {
      printError(err, ctx.json);
      return 2;
    }
    const cap = getCapability("browser");
    if (ctx.json) {
      log.out(JSON.stringify({ capability: cap, guidance: "Use @zenrows/mcp browser_* tools or Browser Sessions (CDP).", escalationOnly: true }, null, 2));
      return 0;
    }
    log.info(c(ANSI.bold, "Browser sessions (experimental, escalation-only)"));
    log.info("Prefer Protected Fetch / Extract first. Use the browser only for logins, clicks, forms, and persistent state.");
    log.info("");
    log.info("Today, browser workflows run through:");
    log.info("  • Zenrows Browser Sessions (CDP endpoint) — connect Playwright/Puppeteer");
    log.info("  • @zenrows/mcp browser_* tools (navigate, click, fill, screenshot, …)");
    log.dim("A managed REST sessions API is not part of the public backend yet, so this command does not fake one.");
    return 0;
  },
};
