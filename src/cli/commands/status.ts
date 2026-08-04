/**
 * `zenrows status [--json] [--check]`
 *
 * Reports auth, workspace, backend reachability, the capability matrix, MCP
 * status, installed assets, and the policy summary. `--check` performs a live
 * reachability probe (no credits consumed — an intentionally invalid request
 * that proves the API responds).
 */
import { authState } from "../../core/auth.ts";
import { loadCapabilities } from "../../core/capabilities.ts";
import { loadConfig } from "../../core/config.ts";
import { loadPolicy } from "../../core/policy.ts";
import { log, ANSI, c } from "../../core/logger.ts";
import { findWorkspace } from "../../core/workspace.ts";
import { listInstalled } from "../../core/registry.ts";
import type { AssetType } from "../../types/index.ts";
import { parse, type Command, type RunContext } from "../command.ts";
import { kv, section } from "../output.ts";

const ASSET_TYPES: AssetType[] = ["plugin", "skill", "template", "workflow", "recipe", "eval"];

export const status: Command = {
  name: "status",
  summary: "Show auth, workspace, capabilities, MCP, installed assets, and policy.",
  usage: "zenrows status [--json] [--check]",
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const { values } = parse(argv, { check: { type: "boolean" }, json: { type: "boolean" } });
    const auth = authState();
    const cfg = loadConfig();
    const pol = loadPolicy();
    const ws = findWorkspace();
    const caps = loadCapabilities();

    let reachable: boolean | "unknown" = "unknown";
    if (values.check) reachable = await probe(cfg.apiBase);

    const installed: Record<string, string[]> = {};
    for (const t of ASSET_TYPES) installed[t] = listInstalled(t);

    if (ctx.json || values.json) {
      log.out(
        JSON.stringify(
          {
            ok: true,
            auth: { hasKey: auth.hasKey, source: auth.source, masked: auth.masked ?? null },
            workspace: { initialized: Boolean(ws), root: ws?.root ?? null, dir: ws?.dir ?? null },
            backend: { apiBase: cfg.apiBase, reachable },
            capabilities: caps,
            mcp: { remote: "https://mcp.zenrows.com/mcp", local: "npx -y @zenrows/mcp", configured: "run `zenrows mcp config --client <id>`" },
            installed,
            policy: pol,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    section("Auth");
    kv("api key", auth.hasKey ? `${auth.masked} (${auth.source})` : c(ANSI.yellow, "not configured"));

    section("Workspace");
    kv("initialized", ws ? c(ANSI.green, "yes") : c(ANSI.yellow, "no — run `zenrows init`"));
    if (ws) kv("location", ws.dir);

    section("Backend");
    kv("api base", cfg.apiBase);
    kv("default mode", cfg.defaultMode);
    kv("reachable", reachable === "unknown" ? "unknown (run with --check)" : reachable ? c(ANSI.green, "yes") : c(ANSI.red, "no"));

    section("Capabilities");
    for (const cap of Object.values(caps)) {
      const badge =
        cap.status === "available" ? c(ANSI.green, "available") :
        cap.status === "experimental" ? c(ANSI.yellow, "experimental") :
        c(ANSI.dim, cap.status);
      kv(cap.command, `${badge}  → ${cap.backend}`, 22);
    }

    section("MCP");
    kv("remote", "https://mcp.zenrows.com/mcp");
    kv("local", "npx -y @zenrows/mcp");
    kv("configure", "zenrows mcp config --client <claude-code|cursor|vscode|…>");

    section("Installed assets");
    for (const t of ASSET_TYPES) kv(t + "s", installed[t]!.length ? installed[t]!.join(", ") : c(ANSI.dim, "none"), 14);

    section("Policy");
    kv("max credits/run", String(pol.max_credits_per_run), 18);
    kv("max pages/run", String(pol.max_pages_per_run), 18);
    kv("allow browser", String(pol.allow_browser), 18);
    kv("allow experimental", String(pol.allow_experimental), 18);
    kv("blocked domains", pol.blocked_domains.length ? pol.blocked_domains.join(", ") : "none", 18);

    return 0;
  },
};

/** Reachability probe that does not consume credits. */
async function probe(apiBase: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    // No apikey + no url → the API responds with a 4xx error, which still
    // proves the endpoint is reachable. We never send a billable request.
    const res = await fetch(apiBase, { method: "GET", signal: controller.signal });
    clearTimeout(t);
    return res.status > 0;
  } catch {
    return false;
  }
}
