/**
 * Toolkit config (`.zenrows/config.json`). Non-secret, safe defaults.
 */
import { randomUUID } from "node:crypto";
import type { ToolkitConfig } from "../types/index.ts";
import { findWorkspace, readJson, workspacePaths, writeJson } from "./workspace.ts";

/** Confirmed Zenrows Universal Scraper API base. */
export const DEFAULT_API_BASE = "https://api.zenrows.com/v1/";
export const CONFIG_VERSION = "0.1.0";
/**
 * Published toolkit version. Kept here (rather than importing from the CLI
 * entrypoint) so core modules — telemetry, signup provenance — can read it
 * without an import cycle. `VERSION` in `cli/index.ts` re-exports this.
 */
export const CLI_VERSION = "0.1.3";
/** Env var to override the Universal Scraper API base (local/staging testing). */
export const API_BASE_ENV = "ZENROWS_API_BASE";
/**
 * Env var to opt out of anonymous attribution. The toolkit never POSTs to a
 * telemetry endpoint; attribution is only anonymous provenance headers on the
 * signup request + `utm_*` params on the browser URLs a human opens. Setting
 * this to `off` (or config `telemetry: "off"`) suppresses all of it.
 */
export const TELEMETRY_ENV = "ZENROWS_TELEMETRY";

/**
 * Whether to attach anonymous attribution (signup provenance headers + `utm_*`
 * on browser URLs). Off when `ZENROWS_TELEMETRY=off` or config `telemetry:"off"`.
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

/**
 * Return the stable anonymous agent id, generating + persisting one on first
 * use. Sent as the `X-ZR-Agent-Id` header on signup so the backend can correlate
 * the (anonymous) device with the account it later merges on claim. Contains no
 * PII — a random uuid only.
 */
export function getOrCreateTelemetryId(projectRoot?: string): string {
  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  // Merge onto the raw stored config (not loadConfig) so we never persist the
  // ZENROWS_API_BASE env override back into config.json.
  const stored = readJson<Partial<ToolkitConfig>>(ws.config) ?? {};
  const existing = stored.telemetryId;
  if (existing && existing.trim()) return existing;
  const id = randomUUID();
  saveConfig({ ...defaultConfig(), ...stored, telemetryId: id }, projectRoot);
  return id;
}
