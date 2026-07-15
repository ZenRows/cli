#!/usr/bin/env node
/**
 * Keep CLI_VERSION (src/core/config.ts) in lockstep with package.json.
 *
 * There are two version sources: package.json (npm/publish) and the hardcoded
 * CLI_VERSION const, which drives `zenrows --version` and the X-ZR-CLI-Version
 * header. This script rewrites CLI_VERSION to match package.json so they never
 * drift. It runs automatically via the npm `version` lifecycle (so
 * `npm version <patch|minor|major>` updates both), and is also runnable
 * standalone: `node scripts/sync-version.mjs`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const configPath = join(root, "src", "core", "config.ts");
const src = readFileSync(configPath, "utf8");

const re = /(export const CLI_VERSION = ")[^"]*(";)/;
if (!re.test(src)) {
  console.error("sync-version: could not find `export const CLI_VERSION` in src/core/config.ts");
  process.exit(1);
}

const next = src.replace(re, `$1${version}$2`);
if (next === src) {
  console.log(`sync-version: CLI_VERSION already ${version}`);
} else {
  writeFileSync(configPath, next);
  console.log(`sync-version: CLI_VERSION -> ${version}`);
}
