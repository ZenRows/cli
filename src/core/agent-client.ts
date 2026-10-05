/**
 * Which AI coding agent is running the CLI, sent to Zenrows as the
 * `X-ZenRows-Client` header so the dashboard Activity Log can say "CLI, driven
 * by Claude Code" instead of just "CLI".
 *
 * Only the derived name is sent, never an environment value: the header carries
 * one of the fixed names below, or the user's own `ZENROWS_CLIENT` override.
 * When no agent is detected, no header is sent at all. `ZENROWS_TELEMETRY=off`
 * (or config `telemetry: "off"`) suppresses it, override included.
 *
 * The gateway resolves the value against its own list of client names and
 * stores anything it does not know as "other", so a name that is new here is
 * harmless there.
 */
import { attributionEnabled } from "./config.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** The request header the Zenrows gateway reads the client name from. */
export const CLIENT_HEADER = "X-ZenRows-Client";
/** Env var a user sets to name the client themselves. It wins over detection. */
export const CLIENT_OVERRIDE_ENV = "ZENROWS_CLIENT";

/**
 * The gateway considers at most 32 bytes of the header.
 * Anything we send must also be a legal header value, or `fetch` throws on
 * every request, so the override is held to a plain-token charset.
 */
const CLIENT_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

interface AgentSignal {
  /** The name sent in the header. Matches the gateway's name where it has one. */
  client: string;
  /** Detected when any of these is set to a non-empty value. */
  vars: readonly string[];
}

/**
 * Each agent's signal is a variable the agent itself sets in the shells it runs
 * commands in, verified against the agent's docs or source. Agents we found no
 * such variable for (Windsurf, Aider, Copilot CLI, the Copilot cloud agent) are
 * left out rather than guessed.
 *
 * The first match wins. Every variable here is set by the agent itself when it
 * launches a command, never by an IDE or extension in a terminal a person types
 * in, so a human at the keyboard is never labelled as an agent.
 */
const AGENT_SIGNALS: readonly AgentSignal[] = [
  // Cursor agent terminals: "Use the CURSOR_AGENT environment variable in your
  // shell config to detect when Cursor is running".
  // https://cursor.com/docs/agent/tools/terminal
  { client: "cursor", vars: ["CURSOR_AGENT"] },
  // GitHub Copilot agent mode in VS Code sets COPILOT_AGENT=1 in agent terminals.
  // Sent as "vscode", the name the gateway already has for VS Code's agent.
  // https://github.com/microsoft/vscode/pull/316267
  // https://github.com/microsoft/vscode/blob/45373f06ff77cc97a7754a376548d8937fb3af54/src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/toolTerminalCreator.ts#L156-L159
  { client: "vscode", vars: ["COPILOT_AGENT"] },
  // OpenAI Codex CLI injects CODEX_THREAD_ID into every shell-tool environment,
  // and CODEX_SANDBOX when the command runs sandboxed.
  // https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/protocol/src/shell_environment.rs#L151-L154
  // https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/spawn.rs#L23-L26
  { client: "codex", vars: ["CODEX_THREAD_ID", "CODEX_SANDBOX"] },
  // Gemini CLI sets GEMINI_CLI=1 for every shell command it executes.
  // https://google-gemini.github.io/gemini-cli/docs/cli/commands.html
  // https://github.com/google-gemini/gemini-cli/blob/fb972b2f87fe7d5b06d37eac711490162d98de2c/packages/core/src/services/shellExecutionService.ts#L582-L585
  { client: "gemini-cli", vars: ["GEMINI_CLI"] },
  // Claude Code sets CLAUDE_CODE_CHILD_SESSION=1 in what its Bash, PowerShell and
  // Monitor tools, hooks and status line spawn, "only set by Claude Code itself
  // ... and not by IDE extensions" (v2.1.172+). Not CLAUDECODE: the IDE extensions
  // export that into every integrated terminal, so a person typing `zenrows` there
  // would read as Claude Code. Older versions send no name rather than a wrong one,
  // and so does a stdio MCP server, which gets neither variable's guarantee.
  // https://code.claude.com/docs/en/env-vars
  { client: "claude-code", vars: ["CLAUDE_CODE_CHILD_SESSION"] },
];

/** Every variable detection reads, so tests can keep the ambient shell out. */
export const AGENT_ENV_VARS: readonly string[] = AGENT_SIGNALS.flatMap((s) => s.vars);

/**
 * The client name to send, or `undefined` to send nothing. Pure: reads only
 * `env`. A valid `ZENROWS_CLIENT` override is sent even when no agent is
 * detected: setting it is an explicit opt-in. It replaces detection entirely, so
 * an override that is not a valid name sends nothing rather than a detected name
 * the user asked not to send.
 */
export function detectAgentClient(env: Env): string | undefined {
  const override = env[CLIENT_OVERRIDE_ENV]?.trim();
  if (override) {
    // Same normalisation the gateway applies: lower-case, spaces to dashes.
    const name = override.toLowerCase().split(/\s+/).join("-");
    return CLIENT_NAME.test(name) ? name : undefined;
  }
  return AGENT_SIGNALS.find((s) => s.vars.some((v) => isSet(env[v])))?.client;
}

/** Empty, `0` and `false` (any case) count as unset, the way `CLAUDE_CODE_CHILD_SESSION=0` reads. */
function isSet(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return Boolean(v) && v !== "0" && v !== "false";
}

/**
 * The header to spread into a request to a Zenrows API: `{ "X-ZenRows-Client":
 * name }` when there is a name and attribution is on, `{}` otherwise. Pass
 * `projectRoot` when the caller works on a workspace other than the one above
 * the cwd (`init --workspace`), so that workspace's `telemetry: "off"` applies.
 */
export function agentClientHeader(opts: { projectRoot?: string; env?: Env } = {}): Record<string, string> {
  if (!attributionEnabled(opts.projectRoot)) return {};
  const client = detectAgentClient(opts.env ?? process.env);
  return client ? { [CLIENT_HEADER]: client } : {};
}
