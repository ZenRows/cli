/**
 * `zenrows mcp` — configure the Zenrows MCP server in agent clients.
 *   config --client <id> [--remote]   print a config snippet (and how to apply)
 *   install [--client <id>]           same as config; convenience alias
 *   status                            show MCP endpoints + supported clients
 *   uninstall --client <id>           print removal instructions
 */
import { loadCapabilities } from "../../core/capabilities.ts";
import { log, ANSI, c } from "../../core/logger.ts";
import { ToolkitError } from "../../core/errors.ts";
import { buildMcpConfig, MCP_CLIENTS, REMOTE_URL, type McpTransport } from "../../installers/mcp/index.ts";
import { parse, asString, type Command, type RunContext } from "../command.ts";

export const mcp: Command = {
  name: "mcp",
  summary: "Configure the Zenrows MCP server (remote or local) in agent clients.",
  usage: "zenrows mcp <config|install|status|uninstall> [--client <id>] [--remote]",
  help: [
    "Subcommands:",
    "  status                         show MCP endpoints and supported clients",
    "  config --client <id>           generate a config snippet for a client",
    "  install --client <id>          alias for config",
    "  uninstall --client <id>        show how to remove the server",
    "",
    `Clients: ${Object.keys(MCP_CLIENTS).join(", ")}`,
    "Add --remote to target the hosted server instead of the local STDIO server.",
  ].join("\n"),
  run(argv: string[], ctx: RunContext): number {
    const [sub, ...rest] = argv;
    const { values } = parse(rest, { client: { type: "string" }, remote: { type: "boolean" } });
    const clientId = asString(values.client);
    const transport: McpTransport = values.remote ? "remote" : "stdio";

    if (!sub || sub === "status") return statusCmd(ctx);
    if (sub === "config" || sub === "install") {
      if (!clientId) {
        throw new ToolkitError({
          code: "INVALID_USAGE",
          message: "Specify a client.",
          likely_cause: "--client was not provided.",
          next_action: `Pick one: ${Object.keys(MCP_CLIENTS).join(", ")}`,
          suggested_commands: ["zenrows mcp config --client claude-code"],
        });
      }
      const { client, snippet } = buildMcpConfig(clientId, transport);
      if (ctx.json) {
        log.out(JSON.stringify({ client: client.id, transport, configFile: client.configFile, autoConfigurable: client.autoConfigurable, snippet }, null, 2));
        return 0;
      }
      log.info(c(ANSI.bold, `MCP config for ${client.label} (${transport})`));
      log.info(`config file: ${client.configFile}`);
      if (client.notes) log.dim(`note: ${client.notes}`);
      log.info("");
      log.out(snippet);
      log.info("");
      log.warn("Replace YOUR_ZENROWS_API_KEY with your key. Never commit it; prefer the ZENROWS_API_KEY env var.");
      return 0;
    }
    if (sub === "uninstall") {
      if (!clientId) throw new ToolkitError({ code: "INVALID_USAGE", message: "Specify --client.", likely_cause: "Missing client.", next_action: "e.g. zenrows mcp uninstall --client cursor" });
      const { client } = buildMcpConfig(clientId, transport);
      log.info(`To remove the Zenrows MCP server from ${client.label}:`);
      if (client.format === "cli") log.out("claude mcp remove zenrows");
      else log.out(`Edit ${client.configFile} and delete the "zenrows" server entry.`);
      return 0;
    }
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Unknown mcp subcommand: ${sub}`,
      likely_cause: "Subcommand not recognized.",
      next_action: "Use status | config | install | uninstall.",
    });
  },
};

function statusCmd(ctx: RunContext): number {
  const cap = loadCapabilities().mcp;
  if (ctx.json) {
    log.out(JSON.stringify({ capability: cap, remote: REMOTE_URL, local: "npx -y @zenrows/mcp", clients: Object.values(MCP_CLIENTS) }, null, 2));
    return 0;
  }
  log.info(c(ANSI.bold, "Zenrows MCP"));
  log.info(`status:  ${cap?.status}`);
  log.info(`remote:  ${REMOTE_URL}`);
  log.info(`local:   npx -y @zenrows/mcp  (env ZENROWS_API_KEY)`);
  log.info("");
  log.info("Supported clients:");
  for (const cl of Object.values(MCP_CLIENTS)) {
    log.info(`  ${cl.id.padEnd(14)} ${cl.autoConfigurable ? c(ANSI.green, "auto") : c(ANSI.yellow, "manual")}  ${cl.configFile}`);
  }
  log.dim("Generate a snippet: zenrows mcp config --client <id> [--remote]");
  return 0;
}
