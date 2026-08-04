/**
 * `zenrows config` — view / set non-secret toolkit config.
 *   show
 *   get <key>
 *   set <key> <value>
 *   reset
 */
import { defaultConfig, loadConfig, saveConfig } from "../../core/config.ts";
import { log } from "../../core/logger.ts";
import { ToolkitError } from "../../core/errors.ts";
import type { ToolkitConfig } from "../../types/index.ts";
import { kv } from "../output.ts";
import type { Command, RunContext } from "../command.ts";

const SETTABLE: Record<string, (c: ToolkitConfig, v: string) => void> = {
  apiBase: (c, v) => (c.apiBase = v),
  defaultMode: (c, v) => {
    if (v !== "auto" && v !== "manual") throw badValue("defaultMode", "auto|manual");
    c.defaultMode = v;
  },
  telemetry: (c, v) => {
    if (v !== "anonymous" && v !== "off") throw badValue("telemetry", "anonymous|off");
    c.telemetry = v;
  },
};

export const config: Command = {
  name: "config",
  summary: "View or update toolkit configuration (non-secret).",
  usage: "zenrows config <show|get <key>|set <key> <value>|reset>",
  run(argv: string[], ctx: RunContext): number {
    const [sub, key, value] = argv;
    const cfg = loadConfig();
    if (!sub || sub === "show") {
      if (ctx.json) return out(cfg, ctx);
      kv("apiBase", cfg.apiBase);
      kv("defaultMode", cfg.defaultMode);
      kv("telemetry", cfg.telemetry);
      kv("version", cfg.version);
      return 0;
    }
    if (sub === "get") {
      if (!key || !(key in cfg)) throw unknownKey(key);
      log.out(String((cfg as unknown as Record<string, unknown>)[key]));
      return 0;
    }
    if (sub === "set") {
      if (!key || value === undefined) {
        throw new ToolkitError({
          code: "INVALID_USAGE",
          message: "Usage: zenrows config set <key> <value>",
          likely_cause: "Missing key or value.",
          next_action: `Settable keys: ${Object.keys(SETTABLE).join(", ")}`,
        });
      }
      const setter = SETTABLE[key];
      if (!setter) throw unknownKey(key);
      setter(cfg, value);
      saveConfig(cfg);
      log.success(`Set ${key} = ${value}`);
      return 0;
    }
    if (sub === "reset") {
      saveConfig(defaultConfig());
      log.success("Reset config to defaults.");
      return 0;
    }
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Unknown config subcommand: ${sub}`,
      likely_cause: "Subcommand not recognized.",
      next_action: "Use show | get <key> | set <key> <value> | reset.",
    });
  },
};

function out(cfg: ToolkitConfig, _ctx: RunContext): number {
  log.out(JSON.stringify({ ok: true, ...cfg }, null, 2));
  return 0;
}
function unknownKey(key?: string): ToolkitError {
  return new ToolkitError({
    code: "INVALID_USAGE",
    message: `Unknown config key: ${key ?? "(none)"}`,
    likely_cause: "The key is not part of the config schema.",
    next_action: `Settable keys: ${Object.keys(SETTABLE).join(", ")}`,
  });
}
function badValue(key: string, allowed: string): ToolkitError {
  return new ToolkitError({
    code: "INVALID_USAGE",
    message: `Invalid value for ${key}.`,
    likely_cause: `Allowed: ${allowed}`,
    next_action: `Pass one of: ${allowed}`,
  });
}
