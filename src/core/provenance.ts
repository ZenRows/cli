/**
 * Best-effort host-agent provenance detection.
 *
 * Sniffs the environment to guess which AI coding agent (if any) is driving the
 * CLI. Used only for anonymous attribution — provenance headers on the signup
 * request and `utm_*` params on the browser URLs a human opens. Never sends env
 * values themselves, only the derived brand label. Pure and unit-testable: pass
 * an env object for tests; defaults to `process.env`.
 */

export interface Provenance {
  /** Host agent brand, e.g. "claude-code", "cursor", or "unknown". */
  client: string;
  /** `process.platform`, e.g. "darwin". */
  os: string;
  /** `process.version`, e.g. "v22.0.0". */
  node: string;
  /** True when running in a known CI environment. */
  ci: boolean;
}

type Env = Record<string, string | undefined>;

function hasPrefix(env: Env, prefix: string): boolean {
  return Object.keys(env).some((k) => k.startsWith(prefix));
}

/** Detect the host agent brand + runtime, best-effort, from env vars. */
export function detectClient(env: Env = process.env): Provenance {
  const term = env.TERM_PROGRAM;

  let client = "unknown";
  if (env.CLAUDECODE || hasPrefix(env, "CLAUDE_CODE") || hasPrefix(env, "CLAUDE_")) {
    client = "claude-code";
  } else if (env.CURSOR_TRACE_ID || hasPrefix(env, "CURSOR_") || term === "cursor") {
    client = "cursor";
  } else if (hasPrefix(env, "OPENAI_") || hasPrefix(env, "CODEX_")) {
    client = "openai-codex";
  } else if (hasPrefix(env, "WINDSURF")) {
    client = "windsurf";
  } else if (term === "vscode" || hasPrefix(env, "VSCODE_")) {
    client = "vscode";
  }

  const ci = Boolean(env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE);

  return {
    client,
    os: process.platform,
    node: process.version,
    ci,
  };
}

/**
 * Attribution query params for the browser URLs the CLI hands to a human (the
 * signup page today). Firecrawl-style: the data rides a URL the user opens, so
 * the web app attributes the visit — no separate request from the CLI. Uses the
 * standard `utm_*` keys so any URL-based analytics picks them up automatically.
 */
export function attributionParams(client: string = detectClient().client): Record<string, string> {
  return { utm_source: "agent", utm_medium: client, utm_campaign: "cli" };
}
