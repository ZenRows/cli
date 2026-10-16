# AGENTS.md

Instructions for coding agents working on this repository: the Zenrows CLI
(`@zenrows/cli`) and the agent skills, templates, workflows, recipes and evals
it ships. To *use* Zenrows from an agent instead, install the skills:
`npx skills add ZenRows/cli`.

## Commands

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # builds to dist/, then runs node:test
npm run dev -- --help
```

CI runs `typecheck` and `test` on Node 20 and 22. Run both before pushing.
`npm run test:e2e` hits the live API and bills the key's account; see
`docs/contributing.md` before running it.

## Code

- TypeScript with zero runtime dependencies. Use `fetch`, `node:util`
  `parseArgs`, `node:fs`, `node:crypto`. Do not add a runtime dependency.
- Layout and the steps for adding a primitive: `docs/contributing.md`.
- Never print or persist an API key. Redact secrets in logs and artifacts.
- Every error is agent-actionable: `code`, `message`, `likely_cause`,
  `next_action`, optional `suggested_commands`.
- Never fake backend behaviour; return a normalized error instead.

## Skills

- `skills/*/SKILL.md` are the CLI's skills; `agent-plugin/skills/` are the
  MCP-native copies for the agent plugin. Change both when a fact changes.
- Quote any frontmatter value that contains `: `. Strict YAML parsers, such
  as the one behind `npx skills add`, skip the whole skill otherwise; a test
  checks this.

## Commits and pull requests (CI enforces these)

- Conventional Commits in commit messages and the PR title:
  `type(scope): subject`. `fix`, `feat` and `perf` need a lowercase scope.
- The subject says why the change is needed, not what the diff does.
- No trailer lines (`Co-authored-by`, `Signed-off-by`, ...), no issue-tracker
  keys, and no "generated with/by" AI attribution, in commits, PR title or
  PR body.

## Releases

- Never edit the version in `package.json`, `package-lock.json` or
  `CLI_VERSION` in `src/core/config.ts`. release-please sets them.
- Merging the `chore: release X.Y.Z` PR tags, releases and publishes to npm.
  Recovery when a release fails: `docs/contributing.md`.
