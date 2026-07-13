/**
 * Installable asset registry.
 *
 * All installable assets (plugins, skills, templates, workflows, recipes,
 * evals) are declared in `registry/<type>.json`. Commands read the registry
 * rather than hardcoding scattered asset logic, and each asset declares the
 * backend capabilities it requires so we never run something the backend
 * cannot support.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AssetType, RegistryAsset } from "../types/index.ts";
import { ToolkitError } from "./errors.ts";
import { isUsable } from "./capabilities.ts";
import { pkgPath } from "./paths.ts";
import { findWorkspace, workspacePaths } from "./workspace.ts";

const REGISTRY_FILES: Record<AssetType, string> = {
  plugin: "plugins.json",
  skill: "skills.json",
  template: "templates.json",
  workflow: "workflows.json",
  recipe: "recipes.json",
  eval: "evals.json",
};

/** Plural workspace subdir for installed assets of each type. */
const INSTALL_SUBDIR: Record<AssetType, string> = {
  plugin: "skills", // plugins install agent configs; tracked alongside skills
  skill: "skills",
  template: "templates",
  workflow: "workflows",
  recipe: "recipes",
  eval: "evals",
};

const cache = new Map<AssetType, RegistryAsset[]>();

export function loadRegistry(type: AssetType): RegistryAsset[] {
  if (cache.has(type)) return cache.get(type)!;
  const file = pkgPath("registry", REGISTRY_FILES[type]);
  if (!existsSync(file)) {
    cache.set(type, []);
    return [];
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { assets: RegistryAsset[] };
  const assets = parsed.assets ?? [];
  cache.set(type, assets);
  return assets;
}

export function findAsset(type: AssetType, name: string): RegistryAsset | undefined {
  return loadRegistry(type).find((a) => a.name === name);
}

export function requireAsset(type: AssetType, name: string): RegistryAsset {
  const asset = findAsset(type, name);
  if (!asset) {
    const available = loadRegistry(type).map((a) => a.name).join(", ") || "(none)";
    throw new ToolkitError({
      code: "ASSET_NOT_FOUND",
      message: `No ${type} named "${name}".`,
      likely_cause: "The asset name is not declared in the registry.",
      next_action: `Pick one of: ${available}`,
      suggested_commands: [`zenrows ${type} list`],
    });
  }
  return asset;
}

/** True if all backend capabilities the asset depends on are usable today. */
export function assetRunnable(asset: RegistryAsset): boolean {
  return asset.requires_backend_capabilities.every((c) => isUsable(c));
}

/**
 * Throw ASSET_REQUIRES_CAPABILITY when an asset depends on a primitive that is
 * not available yet (used by `run`-style commands).
 */
export function assertAssetRunnable(asset: RegistryAsset, code: "ASSET_REQUIRES_CAPABILITY" | "EVAL_REQUIRES_CAPABILITY" = "ASSET_REQUIRES_CAPABILITY"): void {
  const missing = asset.requires_backend_capabilities.filter((c) => !isUsable(c));
  if (missing.length === 0) return;
  throw new ToolkitError({
    code,
    message: `"${asset.name}" requires backend capabilities that are not available yet: ${missing.join(", ")}.`,
    likely_cause: "One or more required cloud primitives are planned/experimental for this backend.",
    next_action: "Use `explain` to read it, or run a recipe/eval that only needs available primitives.",
    suggested_commands: [`zenrows ${asset.type} explain ${asset.name}`, "zenrows status"],
  });
}

export interface InstalledAsset {
  type: AssetType;
  name: string;
  path: string;
}

/** Copy a registry asset's source directory into the local workspace. */
export function installAsset(asset: RegistryAsset, projectRoot?: string): InstalledAsset {
  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  const src = pkgPath(asset.path);
  if (!existsSync(src)) {
    throw new ToolkitError({
      code: "ASSET_NOT_FOUND",
      message: `Source for "${asset.name}" is missing at ${asset.path}.`,
      likely_cause: "The registry references a path that does not exist in the package.",
      next_action: "Reinstall the toolkit or report this as a packaging bug.",
    });
  }
  const dest = join(ws.dir, INSTALL_SUBDIR[asset.type], asset.name);
  cpSync(src, dest, { recursive: true });
  return { type: asset.type, name: asset.name, path: dest };
}

export function removeInstalledAsset(type: AssetType, name: string, projectRoot?: string): boolean {
  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  const dest = join(ws.dir, INSTALL_SUBDIR[type], name);
  if (!existsSync(dest)) return false;
  rmSync(dest, { recursive: true, force: true });
  return true;
}

export function listInstalled(type: AssetType, projectRoot?: string): string[] {
  const ws = projectRoot ? workspacePaths(projectRoot) : findWorkspace();
  if (!ws) return [];
  const dir = join(ws.dir, INSTALL_SUBDIR[type]);
  if (!existsSync(dir)) return [];
  // Only count names that exist in the registry for this type (skills dir is
  // shared by skills + plugins).
  const declared = new Set(loadRegistry(type).map((a) => a.name));
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && declared.has(d.name))
    .map((d) => d.name);
}
