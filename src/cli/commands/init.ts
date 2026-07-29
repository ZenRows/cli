/**
 * `zenrows init` — top-level onboarding.
 *
 * Creates the local workspace, writes default config/policy, optionally stores
 * an API key, prints MCP configs for detected/requested agents, installs core
 * skills + starter templates/workflows/recipes/evals, runs a health check, and
 * (when credentials exist and --no-test is not set) runs a test Protected Fetch.
 *
 * Hard rule: if a requested target cannot be auto-configured, we print explicit
 * manual instructions rather than silently skipping it.
 */
import { requireApiKey, saveApiKey, authState } from "../../core/auth.ts";
import { defaultConfig, loadConfig, saveConfig } from "../../core/config.ts";
import { defaultPolicy, loadPolicy, savePolicy } from "../../core/policy.ts";
import { log, ANSI, c } from "../../core/logger.ts";
import { mask } from "../../core/redact.ts";
import { createWorkspace } from "../../core/workspace.ts";
import { installAsset, loadRegistry } from "../../core/registry.ts";
import { buildMcpConfig, MCP_CLIENTS } from "../../installers/mcp/index.ts";
import { runFetch } from "../../adapters/protected-fetch.ts";
import { loadCapabilities } from "../../core/capabilities.ts";
import type { AssetType } from "../../types/index.ts";
import { parse, asString, type Command, type RunContext } from "../command.ts";
import { section } from "../output.ts";

const SMOKE_URL = "https://httpbin.io/html";

export const init: Command = {
  name: "init",
  summary: "Set up the workspace, auth, MCP, skills, and starter assets.",
  usage: "zenrows init [--all] [--api-key <key>] [--agents a,b,c] [--browser] [--yes] [--no-test]",
  help: [
    "Flags:",
    "  --all                 do everything reasonable (assets + MCP snippets + health check)",
    "  --api-key <key>       store credentials",
    "  --agents <list>       claude-code,codex,cursor,gemini,opencode,windsurf,vscode",
    "  --mcp/--plugins/--skills/--templates/--workflows/--recipes/--evals  enable selectively",
    "  --browser             allow browser escalation in policy",
    "  --experimental        allow experimental commands in policy",
    "  --no-telemetry        set telemetry=off",
    "  --no-test             skip the test Protected Fetch",
    "  --yes                 non-interactive",
  ].join("\n"),
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const { values } = parse(argv, {
      all: { type: "boolean" },
      "api-key": { type: "string" },
      agents: { type: "string" },
      browser: { type: "boolean" },
      mcp: { type: "boolean" },
      plugins: { type: "boolean" },
      skills: { type: "boolean" },
      templates: { type: "boolean" },
      workflows: { type: "boolean" },
      recipes: { type: "boolean" },
      evals: { type: "boolean" },
      workspace: { type: "string" },
      experimental: { type: "boolean" },
      "no-telemetry": { type: "boolean" },
      "no-test": { type: "boolean" },
    });

    const all = values.all === true;
    const want = (flag: unknown) => all || flag === true;
    const root = asString(values.workspace);

    log.info(c(ANSI.bold, "Zenrows CLI — init"));

    // 1. Workspace
    section("Workspace");
    const paths = createWorkspace(root);
    log.success(`Created ${paths.dir}`);
    if (!loadConfigSafe(root)) {
      const cfg = defaultConfig();
      if (values["no-telemetry"]) cfg.telemetry = "off";
      saveConfig(cfg, root);
    }
    const pol = loadPolicy(root) ?? defaultPolicy();
    if (values.browser) pol.allow_browser = true;
    if (values.experimental) pol.allow_experimental = true;
    if (values["no-telemetry"]) pol.telemetry = "off";
    savePolicy(pol, root);
    log.success("Wrote config.json + policy.json");

    // 2. Auth
    section("Auth");
    const key = asString(values["api-key"]);
    if (key) {
      saveApiKey(key, root);
      log.success(`Stored API key (${mask(key)}).`);
    } else {
      const st = authState(root);
      if (st.hasKey) log.success(`Using existing key (${st.masked}, ${st.source}).`);
      else log.warn("No API key configured. Run `zenrows login --api-key <key>` or `zenrows signup`.");
    }

    // 3. Assets
    if (want(values.skills) || want(values.plugins)) installSet("skill", root);
    if (want(values.templates)) installSet("template", root);
    if (want(values.workflows)) installSet("workflow", root);
    if (want(values.recipes)) installSet("recipe", root);
    if (want(values.evals)) installSet("eval", root);

    // 4. MCP / agents
    if (want(values.mcp) || want(values.plugins) || values.agents) {
      section("MCP / agent configs");
      const agents = (asString(values.agents) ?? "claude-code,cursor,vscode").split(",").map((s) => s.trim()).filter(Boolean);
      for (const a of agents) {
        try {
          const { client, snippet } = buildMcpConfig(a, "stdio");
          log.info(c(ANSI.bold, `• ${client.label} → ${client.configFile}`));
          if (!client.autoConfigurable) log.warn(`  Manual setup required for ${client.label}:`);
          log.out(snippet);
        } catch {
          log.warn(`  Unknown agent "${a}" — supported: ${Object.keys(MCP_CLIENTS).join(", ")}`);
        }
      }
      log.warn("Replace YOUR_ZENROWS_API_KEY with your key (prefer the ZENROWS_API_KEY env var).");
    }

    // 5. Health check
    section("Health check");
    const caps = loadCapabilities();
    log.success(`Capability matrix loaded (${Object.keys(caps).length} primitives).`);

    // 6. Test Protected Fetch
    if (!values["no-test"]) {
      const st = authState(root);
      if (st.hasKey) {
        section("Test Protected Fetch");
        try {
          const apiKey = requireApiKey(root);
          const { result } = await runFetch({ url: SMOKE_URL }, loadConfig(root), loadPolicy(root), apiKey);
          log.success(`Protected Fetch OK — HTTP ${result.status}, ${result.body.length} bytes, cost $${(result.costUsd ?? 0).toFixed(4)}.`);
        } catch (err) {
          log.warn(`Test fetch did not pass: ${err instanceof Error ? err.message : String(err)}`);
          log.dim("This is non-fatal for init. Check `zenrows status --check`.");
        }
      } else {
        log.dim("Skipping test fetch (no credentials).");
      }
    }

    // 7. Next steps
    section("Next steps");
    log.info("  zenrows status                 # verify everything");
    log.info("  zenrows fetch <url>            # Protected Fetch (auto mode)");
    log.info("  zenrows extract <url> --autoparse");
    log.info("  zenrows mcp config --client claude-code");
    log.info("  zenrows skill list");

    if (ctx.json) {
      log.out(JSON.stringify({ ok: true, workspace: paths.dir, hasKey: authState(root).hasKey }, null, 2));
    }
    return 0;
  },
};

function loadConfigSafe(root?: string): boolean {
  try {
    const cfg = loadConfig(root);
    return Boolean(cfg && cfg.version);
  } catch {
    return false;
  }
}

function installSet(type: AssetType, root?: string): void {
  const assets = loadRegistry(type).filter((a) => a.status === "available" || a.status === "experimental" || a.status === "beta");
  if (assets.length === 0) return;
  section(`Install ${type}s`);
  for (const a of assets) {
    installAsset(a, root);
    log.success(`  ${a.name}`);
  }
}
