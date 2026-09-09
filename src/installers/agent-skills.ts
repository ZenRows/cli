/**
 * Project-scoped skill installation.
 *
 * `init` writes `.zenrows/skills/`, but no agent harness reads that path, so
 * the skills ship and are never seen. This module copies them where the agent
 * actually looks.
 *
 * Project scope, not the home directory: the skills land in the repo, so the
 * whole team gets the same behaviour, a reviewer sees them in the diff, and
 * nothing leaks into projects that have no relation to scraping.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry, assetRunnable } from "../core/registry.ts";
import { pkgPath } from "../core/paths.ts";

/**
 * Where each client reads project-scoped skills.
 *
 * `.agents/skills` is the vendor-neutral location; the rest are client
 * specific. Only add a client here once its path is verified, because a wrong
 * path fails silently: the files land and the agent never reads them.
 */
export const CLIENT_SKILL_DIRS: Record<string, string> = {
  "claude-code": ".claude/skills",
  cursor: ".cursor/skills",
  generic: ".agents/skills",
};

export type SkillInstall = { client: string; dir: string; skills: string[] };

/** Skills usable against the current backend: available plus open beta. */
function payload(): { name: string; path: string }[] {
  return loadRegistry("skill")
    .filter(assetRunnable)
    .map((a) => ({ name: a.name, path: a.path }));
}

/**
 * Copy the skill payload into each client's project skills directory.
 * Replaces our own skill directories and leaves every other one alone.
 */
export function installProjectSkills(
  root: string,
  clients: string[],
  opts: { dryRun?: boolean } = {},
): SkillInstall[] {
  const skills = payload();
  const targets = [...new Set(["generic", ...clients])]
    .map((client) => ({ client, rel: CLIENT_SKILL_DIRS[client] }))
    .filter((t): t is { client: string; rel: string } => Boolean(t.rel));

  return targets.map(({ client, rel }) => {
    const dir = join(root, rel);
    if (!opts.dryRun) {
      mkdirSync(dir, { recursive: true });
      for (const s of skills) {
        const dest = join(dir, s.name);
        rmSync(dest, { recursive: true, force: true });
        cpSync(pkgPath(s.path), dest, { recursive: true });
      }
    }
    return { client, dir: rel, skills: skills.map((s) => s.name) };
  });
}

/** Clients we can install skills for, for error messages and help text. */
export function supportedSkillClients(): string[] {
  return Object.keys(CLIENT_SKILL_DIRS).filter((c) => c !== "generic");
}

/** True when a project already has our skills for a client. */
export function hasProjectSkills(root: string, client: string): boolean {
  const dir = CLIENT_SKILL_DIRS[client];
  return dir ? existsSync(join(root, dir, "zenrows")) : false;
}
