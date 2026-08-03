/**
 * `zenrows plugin` — install agent integrations (per-client config bundles).
 *
 * In V1 a "plugin" is the combination of the Zenrows MCP server config + the
 * core skills for a given agent client. We generate the MCP snippet and install
 * skills, and for clients we cannot auto-configure we print explicit manual
 * instructions (never silently skip — the hard rule).
 */
import { log, ANSI, c } from "../../core/logger.ts";
import { ToolkitError } from "../../core/errors.ts";
import { buildMcpConfig, MCP_CLIENTS } from "../../installers/mcp/index.ts";
import { assetRunnable, installAsset, listInstalled, loadRegistry } from "../../core/registry.ts";
import { parse, type Command, type RunContext } from "../command.ts";

export const plugin: Command = {
  name: "plugin",
  summary: "Install Zenrows agent integrations (MCP + skills) for a client.",
  usage: "zenrows plugin <list|install <client>|status|update|remove <client>>",
  help: `Clients: ${Object.keys(MCP_CLIENTS).join(", ")}`,
  run(argv: string[], ctx: RunContext): number {
    const [sub, name] = argv;
    if (!sub || sub === "list") {
      if (ctx.json) {
        log.out(JSON.stringify({ clients: Object.values(MCP_CLIENTS) }, null, 2));
        return 0;
      }
      log.info(c(ANSI.bold, "Installable agent plugins:"));
      for (const cl of Object.values(MCP_CLIENTS)) {
        log.info(`  ${cl.id.padEnd(14)} ${cl.autoConfigurable ? c(ANSI.green, "auto") : c(ANSI.yellow, "manual")}  ${cl.label}`);
      }
      return 0;
    }
    if (sub === "status") {
      const skills = listInstalled("skill");
      if (ctx.json) {
        log.out(JSON.stringify({ installedSkills: skills }, null, 2));
        return 0;
      }
      log.info(`Installed skills: ${skills.join(", ") || "none"}`);
      log.dim("Plugins layer MCP config + skills per client. Use `zenrows mcp config --client <id>`.");
      return 0;
    }
    if (sub === "install") {
      const { positionals } = parse(argv.slice(1), {});
      const client = name && !name.startsWith("-") ? name : positionals[0];
      if (!client) {
        throw new ToolkitError({
          code: "INVALID_USAGE",
          message: "Specify a client to install.",
          likely_cause: "No client id was provided.",
          next_action: `One of: ${Object.keys(MCP_CLIENTS).join(", ")}`,
          suggested_commands: ["zenrows plugin install claude-code"],
        });
      }
      const { client: spec, snippet } = buildMcpConfig(client, "stdio");
      // Install the usable skills (available + open-beta) as the agent payload —
      // beta is usable, so core skills like extract/batch ship too.
      const skills = loadRegistry("skill").filter(assetRunnable);
      for (const s of skills) installAsset(s);
      log.success(`Installed ${skills.length} core skill(s) for ${spec.label}.`);
      log.info("");
      log.info(c(ANSI.bold, `MCP server config (${spec.configFile}):`));
      log.out(snippet);
      if (!spec.autoConfigurable) {
        log.warn(`${spec.label} cannot be auto-configured — apply the snippet above manually.`);
      }
      log.warn("Replace YOUR_ZENROWS_API_KEY with your key (prefer the ZENROWS_API_KEY env var).");
      return 0;
    }
    if (sub === "update") {
      const skills = loadRegistry("skill").filter(assetRunnable);
      for (const s of skills) installAsset(s);
      log.success(`Refreshed ${skills.length} core skill(s).`);
      return 0;
    }
    if (sub === "remove") {
      log.info(`To remove an MCP server config, edit the client's config file or run \`claude mcp remove zenrows\`.`);
      return 0;
    }
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Unknown plugin subcommand: ${sub}`,
      likely_cause: "Subcommand not recognized.",
      next_action: "Use list | install <client> | status | update | remove <client>.",
    });
  },
};
