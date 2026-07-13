/**
 * Local workspace management: the `.zenrows/` directory tree.
 *
 * The workspace holds config, policy, run artifacts, local specs, installed
 * assets, traces, and logs. Secrets live in `.zenrows/secrets.json`, which is
 * gitignored and never written into run artifacts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const WORKSPACE_DIRNAME = ".zenrows";

/** Subdirectories created inside `.zenrows/`. */
export const WORKSPACE_SUBDIRS = [
  "runs",
  "browser-sessions",
  "skills",
  "templates",
  "workflows",
  "recipes",
  "evals",
  "traces",
  "logs",
] as const;

export interface WorkspacePaths {
  root: string; // project root that contains .zenrows
  dir: string; // .../.zenrows
  config: string;
  policy: string;
  secrets: string;
  account: string;
  gitignore: string;
}

/** Resolve workspace paths for a given project root (defaults to cwd). */
export function workspacePaths(projectRoot: string = process.cwd()): WorkspacePaths {
  const root = resolve(projectRoot);
  const dir = join(root, WORKSPACE_DIRNAME);
  return {
    root,
    dir,
    config: join(dir, "config.json"),
    policy: join(dir, "policy.json"),
    secrets: join(dir, "secrets.json"),
    account: join(dir, "account.json"),
    gitignore: join(root, ".gitignore"),
  };
}

/**
 * Walk upward from `start` looking for an existing `.zenrows/` directory so
 * subcommands run from nested folders still find the workspace.
 */
export function findWorkspace(start: string = process.cwd()): WorkspacePaths | null {
  let cur = resolve(start);
  // Guard against infinite loop at filesystem root.
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, WORKSPACE_DIRNAME))) return workspacePaths(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function workspaceExists(projectRoot?: string): boolean {
  return existsSync(workspacePaths(projectRoot).dir);
}

/** Create the full `.zenrows/` tree. Idempotent. */
export function createWorkspace(projectRoot?: string): WorkspacePaths {
  const paths = workspacePaths(projectRoot);
  mkdirSync(paths.dir, { recursive: true });
  for (const sub of WORKSPACE_SUBDIRS) {
    mkdirSync(join(paths.dir, sub), { recursive: true });
  }
  ensureGitignore(paths);
  return paths;
}

/** Ensure `.zenrows/secrets.json` (and volatile artifacts) are gitignored. */
export function ensureGitignore(paths: WorkspacePaths): void {
  const required = [
    `${WORKSPACE_DIRNAME}/secrets.json`,
    `${WORKSPACE_DIRNAME}/config.json`,
    `${WORKSPACE_DIRNAME}/account.json`,
    `${WORKSPACE_DIRNAME}/runs/`,
    `${WORKSPACE_DIRNAME}/traces/`,
    `${WORKSPACE_DIRNAME}/logs/`,
  ];
  let current = "";
  if (existsSync(paths.gitignore)) current = readFileSync(paths.gitignore, "utf8");
  const lines = new Set(current.split(/\r?\n/));
  const missing = required.filter((r) => !lines.has(r));
  if (missing.length === 0) return;
  const header = current.includes("# ZenRows CLI")
    ? ""
    : "\n# ZenRows CLI (do not commit secrets or run artifacts)\n";
  const next = current.replace(/\s*$/, "") + header + missing.join("\n") + "\n";
  writeFileSync(paths.gitignore, next.replace(/^\n/, ""));
}

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
