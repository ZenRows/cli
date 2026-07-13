/**
 * Locate the package root so shipped assets (registry/, skills/, templates/…)
 * resolve identically whether running from `src/` (dev, native TS) or `dist/`
 * (published JS).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/** Walk upward from this module until we find package.json. */
export function packageRoot(): string {
  if (cached) return cached;
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, "package.json"))) {
      cached = cur;
      return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Fallback: two levels up from src/core or dist/src/core.
  cached = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return cached;
}

/** Resolve a path inside the shipped package. */
export function pkgPath(...segments: string[]): string {
  return join(packageRoot(), ...segments);
}
