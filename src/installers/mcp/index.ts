/**
 * MCP client configuration generator.
 *
 * Confirmed from Zenrows docs:
 *   - Remote MCP:  https://mcp.zenrows.com/mcp
 *   - Local STDIO: npx -y @zenrows/mcp   (env: ZENROWS_API_KEY)
 *
 * Each supported client has a different config shape and file location. We
 * generate accurate config snippets (and the exact CLI command where one
 * exists). We never write the real API key into a generated config — the
 * snippet references the ZENROWS_API_KEY environment variable / placeholder,
 * per the security rules.
 */
import { ToolkitError } from "../../core/errors.ts";

export type McpTransport = "stdio" | "remote";

export interface McpClientSpec {
  id: string;
  label: string;
  /** Well-known config file (relative to home `~` or project `.`). */
  configFile: string;
  /** Config format. */
  format: "json-mcpServers" | "json-servers" | "toml" | "cli";
  autoConfigurable: boolean;
  notes?: string;
}

export const KEY_PLACEHOLDER = "YOUR_ZENROWS_API_KEY";
export const REMOTE_URL = "https://mcp.zenrows.com/mcp";

export const MCP_CLIENTS: Record<string, McpClientSpec> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    configFile: ".mcp.json (project) or run `claude mcp add`",
    format: "cli",
    autoConfigurable: true,
    notes: "Confirmed: `claude mcp add zenrows -e ZENROWS_API_KEY=… -- npx -y @zenrows/mcp`.",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    configFile: "~/.cursor/mcp.json (or .cursor/mcp.json in a project)",
    format: "json-mcpServers",
    autoConfigurable: true,
  },
  vscode: {
    id: "vscode",
    label: "VS Code (Copilot MCP)",
    configFile: ".vscode/mcp.json",
    format: "json-servers",
    autoConfigurable: true,
    notes: "VS Code uses the `servers` key (not `mcpServers`).",
  },
  windsurf: {
    id: "windsurf",
    label: "Windsurf",
    configFile: "~/.codeium/windsurf/mcp_config.json",
    format: "json-mcpServers",
    autoConfigurable: true,
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    configFile: "~/.gemini/settings.json",
    format: "json-mcpServers",
    autoConfigurable: true,
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    configFile: "~/.codex/config.toml",
    format: "toml",
    autoConfigurable: false,
    notes: "Codex uses TOML; add the snippet manually under [mcp_servers.zenrows].",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    configFile: "opencode.json",
    format: "json-mcpServers",
    autoConfigurable: false,
  },
  generic: {
    id: "generic",
    label: "Generic MCP client",
    configFile: "(your client's MCP config)",
    format: "json-mcpServers",
    autoConfigurable: false,
  },
};

export function resolveClient(id: string): McpClientSpec {
  const spec = MCP_CLIENTS[id];
  if (!spec) {
    const supported = Object.keys(MCP_CLIENTS).join(", ");
    throw new ToolkitError({
      code: "MCP_CLIENT_UNSUPPORTED",
      message: `MCP client "${id}" is not supported.`,
      likely_cause: "The client id is not in the supported list.",
      next_action: `Use one of: ${supported}. For others, generate a generic snippet.`,
      suggested_commands: ["zenrows mcp config --client generic"],
    });
  }
  return spec;
}

const stdioServer = {
  command: "npx",
  args: ["-y", "@zenrows/mcp"],
  env: { ZENROWS_API_KEY: KEY_PLACEHOLDER },
};

const remoteServer = { url: REMOTE_URL, headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } };

/** Produce a config snippet string for a client + transport. */
export function renderSnippet(spec: McpClientSpec, transport: McpTransport): string {
  const server = transport === "remote" ? remoteServer : stdioServer;

  if (spec.format === "cli") {
    if (transport === "remote") {
      return `claude mcp add --transport http zenrows ${REMOTE_URL} \\\n  --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`;
    }
    return `claude mcp add zenrows -e ZENROWS_API_KEY=${KEY_PLACEHOLDER} -- npx -y @zenrows/mcp`;
  }
  if (spec.format === "toml") {
    if (transport === "remote") {
      return [
        "[mcp_servers.zenrows]",
        `url = "${REMOTE_URL}"`,
        `# set ZENROWS_API_KEY in your environment / headers`,
      ].join("\n");
    }
    return [
      "[mcp_servers.zenrows]",
      'command = "npx"',
      'args = ["-y", "@zenrows/mcp"]',
      "",
      "[mcp_servers.zenrows.env]",
      `ZENROWS_API_KEY = "${KEY_PLACEHOLDER}"`,
    ].join("\n");
  }
  const key = spec.format === "json-servers" ? "servers" : "mcpServers";
  return JSON.stringify({ [key]: { zenrows: server } }, null, 2);
}

export interface McpConfigResult {
  client: McpClientSpec;
  transport: McpTransport;
  snippet: string;
}

export function buildMcpConfig(clientId: string, transport: McpTransport = "stdio"): McpConfigResult {
  const client = resolveClient(clientId);
  return { client, transport, snippet: renderSnippet(client, transport) };
}
