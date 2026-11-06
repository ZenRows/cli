/**
 * Skill installation into the directories agent harnesses actually read.
 *
 * `init` writes `.zenrows/skills/`, but no harness reads that path, so the
 * skills ship and are never seen. This module copies them where the agent
 * looks.
 *
 * Global by default, because a CLI installed once should work in every
 * directory rather than needing an `init` per repository. `--project` keeps the
 * copy inside the repository instead, which is the right choice when scraping
 * is a dependency of that codebase and the team should share one behaviour.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRegistry, assetRunnable } from "../core/registry.ts";
import { pkgPath } from "../core/paths.ts";

/**
 * Where each client reads skills, relative to the home directory or the
 * repository root depending on scope.
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

export type SkillScope = "global" | "project";
export type SkillInstall = { client: string; dir: string; skills: string[] };

/** Skills usable against the current backend: available plus open beta. */
function payload(): { name: string; path: string }[] {
  return loadRegistry("skill")
    .filter(assetRunnable)
    .map((a) => ({ name: a.name, path: a.path }));
}

/**
 * Copy the skill payload into each client's skills directory.
 * Replaces our own skill directories and leaves every other one alone.
 */
export function installAgentSkills(
  clients: string[],
  opts: { scope?: SkillScope; root?: string; dryRun?: boolean } = {},
): SkillInstall[] {
  const scope = opts.scope ?? "global";
  const base = scope === "global" ? homedir() : (opts.root ?? process.cwd());
  const skills = payload();
  const targets = [...new Set(["generic", ...clients])]
    .map((client) => ({ client, rel: CLIENT_SKILL_DIRS[client] }))
    .filter((t): t is { client: string; rel: string } => Boolean(t.rel));

  return targets.map(({ client, rel }) => {
    const dir = join(base, rel);
    if (!opts.dryRun) {
      mkdirSync(dir, { recursive: true });
      for (const s of skills) {
        const dest = join(dir, s.name);
        rmSync(dest, { recursive: true, force: true });
        cpSync(pkgPath(s.path), dest, { recursive: true });
      }
    }
    return { client, dir, skills: skills.map((s) => s.name) };
  });
}

/** Clients we can install skills for, for error messages and help text. */
export function supportedSkillClients(): string[] {
  return Object.keys(CLIENT_SKILL_DIRS).filter((c) => c !== "generic");
}

/** True when our skills are already installed for a client at this scope. */
export function hasAgentSkills(client: string, scope: SkillScope = "global", root?: string): boolean {
  const rel = CLIENT_SKILL_DIRS[client];
  if (!rel) return false;
  const base = scope === "global" ? homedir() : (root ?? process.cwd());
  return existsSync(join(base, rel, "zenrows"));
}
