/**
 * Credential management.
 *
 * Resolution order: explicit secrets file → ZENROWS_API_KEY env var.
 * The key is never printed in full and never written into run artifacts.
 */
import { chmodSync, existsSync } from "node:fs";
import type { AuthState, Secrets } from "../types/index.ts";
import { ToolkitError } from "./errors.ts";
import { registerSecret } from "./logger.ts";
import { mask } from "./redact.ts";
import { findWorkspace, readJson, workspacePaths, writeJson } from "./workspace.ts";

export const ENV_KEY = "ZENROWS_API_KEY";

function secretsPath(projectRoot?: string): string {
  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  return ws.secrets;
}

/** Resolve the active API key (or undefined), preferring the secrets file. */
export function resolveApiKey(projectRoot?: string): { key?: string; source: AuthState["source"] } {
  const file = secretsPath(projectRoot);
  const stored = readJson<Secrets>(file);
  if (stored?.apiKey) {
    registerSecret(stored.apiKey);
    return { key: stored.apiKey, source: "secrets-file" };
  }
  const env = process.env[ENV_KEY];
  if (env) {
    registerSecret(env);
    return { key: env, source: "env" };
  }
  return { source: "none" };
}

export function authState(projectRoot?: string): AuthState {
  const { key, source } = resolveApiKey(projectRoot);
  return {
    hasKey: Boolean(key),
    source,
    masked: key ? mask(key) : undefined,
  };
}

/** Persist the API key to `.zenrows/secrets.json` with 0600 permissions. */
export function saveApiKey(apiKey: string, projectRoot?: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Empty API key.",
      likely_cause: "No value was passed to --api-key.",
      next_action: "Run: zenrows login --api-key <your-key>",
    });
  }
  const file = secretsPath(projectRoot);
  writeJson(file, { apiKey: trimmed } satisfies Secrets);
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort on platforms without POSIX permissions
  }
  registerSecret(trimmed);
}

export function clearApiKey(projectRoot?: string): boolean {
  const file = secretsPath(projectRoot);
  if (!existsSync(file)) return false;
  writeJson(file, {} satisfies Secrets);
  return true;
}

/** Throw AUTH_MISSING if no key is configured. */
export function requireApiKey(projectRoot?: string): string {
  const { key } = resolveApiKey(projectRoot);
  if (!key) {
    throw new ToolkitError({
      code: "AUTH_MISSING",
      message: "No ZenRows API key configured.",
      likely_cause: "You have not logged in and ZENROWS_API_KEY is not set.",
      next_action: "Log in with your API key, then retry.",
      suggested_commands: [
        "zenrows login --api-key <your-key>",
        "zenrows signup",
      ],
    });
  }
  return key;
}
