/**
 * `zenrows policy` — view / set governance policy.
 *   show
 *   set <key> <value>
 */
import { defaultPolicy, loadPolicy, savePolicy } from "../../core/policy.ts";
import { log } from "../../core/logger.ts";
import { ToolkitError } from "../../core/errors.ts";
import type { Policy } from "../../types/index.ts";
import { kv } from "../output.ts";
import type { Command, RunContext } from "../command.ts";

const NUMERIC: Array<keyof Policy> = ["max_credits_per_run", "max_pages_per_run", "max_concurrency"];
const BOOLEAN: Array<keyof Policy> = ["allow_browser", "allow_experimental", "redact_secrets"];
const LIST: Array<keyof Policy> = ["allowed_domains", "blocked_domains"];

export const policy: Command = {
  name: "policy",
  summary: "View or update governance policy (limits, domain rules, browser/experimental gates).",
  usage: "zenrows policy <show|set <key> <value>|reset>",
  run(argv: string[], ctx: RunContext): number {
    const [sub, key, ...valueParts] = argv;
    const pol = loadPolicy();
    if (!sub || sub === "show") {
      if (ctx.json) {
        log.out(JSON.stringify({ ok: true, ...pol }, null, 2));
        return 0;
      }
      for (const [k, v] of Object.entries(pol)) kv(k, Array.isArray(v) ? `[${v.join(", ")}]` : String(v), 24);
      return 0;
    }
    if (sub === "reset") {
      savePolicy(defaultPolicy());
      log.success("Reset policy to safe defaults.");
      return 0;
    }
    if (sub === "set") {
      if (!key) throw usage();
      const value = valueParts.join(" ");
      applySet(pol, key, value);
      savePolicy(pol);
      log.success(`Set policy ${key} = ${value}`);
      return 0;
    }
    throw usage();
  },
};

function applySet(pol: Policy, key: string, value: string): void {
  if ((NUMERIC as string[]).includes(key)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw bad(key, "a non-negative number");
    (pol as unknown as Record<string, unknown>)[key] = n;
    return;
  }
  if ((BOOLEAN as string[]).includes(key)) {
    if (value !== "true" && value !== "false") throw bad(key, "true|false");
    (pol as unknown as Record<string, unknown>)[key] = value === "true";
    return;
  }
  if ((LIST as string[]).includes(key)) {
    (pol as unknown as Record<string, unknown>)[key] = value.split(",").map((s) => s.trim()).filter(Boolean);
    return;
  }
  if (key === "telemetry") {
    if (value !== "anonymous" && value !== "off") throw bad(key, "anonymous|off");
    pol.telemetry = value;
    return;
  }
  throw new ToolkitError({
    code: "INVALID_USAGE",
    message: `Unknown policy key: ${key}`,
    likely_cause: "Key not part of the policy schema.",
    next_action: `Keys: ${[...NUMERIC, ...BOOLEAN, ...LIST, "telemetry"].join(", ")}`,
  });
}

function usage(): ToolkitError {
  return new ToolkitError({
    code: "INVALID_USAGE",
    message: "Usage: zenrows policy <show|set <key> <value>|reset>",
    likely_cause: "Missing or invalid subcommand.",
    next_action: "Try `zenrows policy show`.",
  });
}
function bad(key: string, allowed: string): ToolkitError {
  return new ToolkitError({
    code: "INVALID_USAGE",
    message: `Invalid value for ${key} (expected ${allowed}).`,
    likely_cause: "Value did not match the expected type.",
    next_action: `Pass ${allowed}. Lists are comma-separated.`,
  });
}
