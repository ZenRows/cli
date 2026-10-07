/**
 * Toolkit config (`.zenrows/config.json`). Non-secret, safe defaults.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolkitConfig } from "../types/index.ts";
import { findWorkspace, readJson, workspacePaths, writeJson } from "./workspace.ts";

/** Confirmed Zenrows Fetch and Extract API base. */
export const DEFAULT_API_BASE = "https://api.zenrows.com/v1/";
export const CONFIG_VERSION = "0.1.0";
/**
 * Published toolkit version. Kept here (rather than importing from the CLI
 * entrypoint) so core modules — telemetry, signup provenance — can read it
 * without an import cycle. `VERSION` in `cli/index.ts` re-exports this.
 */
export const CLI_VERSION = "1.4.0";
/** The User-Agent on every request to a Zenrows API. The gateway reads the version from it. */
export const CLI_USER_AGENT = `zenrows-cli/${CLI_VERSION}`;
/** Env var to override the Fetch and Extract API base (local/staging testing). */
export const API_BASE_ENV = "ZENROWS_API_BASE";
/**
 * Env var to opt out of anonymous attribution. The toolkit never POSTs to a
 * telemetry endpoint; attribution is only anonymous provenance headers on the
 * signup request, the `X-ZenRows-Client` agent name on API requests
 * (`agent-client.ts`), and `utm_*` params on the browser URLs a human opens.
 * Setting this to `off` (or config `telemetry: "off"`) suppresses all of it.
 */
export const TELEMETRY_ENV = "ZENROWS_TELEMETRY";

/**
 * Whether to attach anonymous attribution (signup provenance headers, the
 * `X-ZenRows-Client` agent name, `utm_*` on browser URLs). Off when
 * `ZENROWS_TELEMETRY=off` or config `telemetry:"off"`.
 * There is no telemetry beacon — this only gates what rides on requests/URLs
 * the toolkit already makes.
 */
export function attributionEnabled(projectRoot?: string): boolean {
  if (process.env[TELEMETRY_ENV] === "off") return false;
  try {
    return loadConfig(projectRoot).telemetry !== "off";
  } catch {
    return true;
  }
}

export function defaultConfig(): ToolkitConfig {
  return {
    apiBase: DEFAULT_API_BASE,
    defaultMode: "auto",
    telemetry: "anonymous",
    version: CONFIG_VERSION,
  };
}

export function loadConfig(projectRoot?: string): ToolkitConfig {
  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  const stored = readJson<Partial<ToolkitConfig>>(ws.config);
  const config = { ...defaultConfig(), ...(stored ?? {}) };
  // Env override (highest priority) so local/staging testing needs no file edit.
  const envBase = process.env[API_BASE_ENV];
  if (envBase && envBase.trim()) config.apiBase = envBase.trim();
  return config;
}

export function saveConfig(config: ToolkitConfig, projectRoot?: string): void {
  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  writeJson(ws.config, config);
}

/** Env var to relocate the per-machine config directory (tests, sandboxes). */
export const CONFIG_HOME_ENV = "ZENROWS_CONFIG_HOME";

/** Per-machine config directory, shared by every workspace on this machine. */
export function machineConfigDir(): string {
  const override = process.env[CONFIG_HOME_ENV];
  if (override && override.trim()) return override.trim();
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "zenrows");
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg.trim() : join(homedir(), ".config"), "zenrows");
}

function readMachineTelemetryId(file: string): string | undefined {
  try {
    const id = readFileSync(file, "utf8").trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return the stable anonymous agent id, generating + persisting one on first
 * use. Sent as the `X-ZR-Agent-Id` header on signup so the backend can correlate
 * the (anonymous) device with the account it later merges on claim. Contains no
 * PII — a random uuid only.
 *
 * Stored per machine, not per workspace: a per-workspace id made every new
 * project folder look like a new device, so the backend could not tell a
 * rate-limited retry from the machine that had just signed up. An id already in
 * the workspace is adopted on first run so existing devices keep their identity.
 * If the machine directory is not writable, falls back to the workspace config.
 */
export function getOrCreateTelemetryId(projectRoot?: string): string {
  const file = join(machineConfigDir(), "telemetry-id");
  const machineId = readMachineTelemetryId(file);
  if (machineId) return machineId;

  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  // Merge onto the raw stored config (not loadConfig) so we never persist the
  // ZENROWS_API_BASE env override back into config.json.
  const stored = readJson<Partial<ToolkitConfig>>(ws.config) ?? {};
  const workspaceId = stored.telemetryId?.trim() ? stored.telemetryId.trim() : undefined;
  const id = workspaceId ?? randomUUID();

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
  } catch {
    if (!workspaceId) saveConfig({ ...defaultConfig(), ...stored, telemetryId: id }, projectRoot);
  }
  return id;
}
