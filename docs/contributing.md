# Contributing

## Stack

- TypeScript, **zero runtime dependencies**. Native `fetch`, `node:util`
  `parseArgs`, `node:fs`, `node:crypto`, `node:test`.
- The published package ships compiled JS in `dist/` (runs on Node 20+).
- For development, Node 23.6+ runs the `.ts` sources directly (type stripping).

## Layout

```
src/cli/         router + commands + asset-command factory
src/core/        auth, config, policy, workspace, capabilities, registry, http, artifacts, errors, logger
src/adapters/    protected-fetch, extract
src/installers/  MCP client config generators
registry/        capabilities.json + <type>.json asset manifests
skills/ templates/ workflows/ recipes/ evals/   shipped assets
tests/           node:test suites
```

## Common tasks

```bash
npm install            # dev deps only (typescript, @types/node)
npm run dev -- --help  # run the CLI from source
npm test               # node --test
npm run typecheck      # tsc --noEmit
npm run build          # tsc → dist/ (for publishing)
```

## Adding a primitive

1. Add/flip its entry in `registry/capabilities.json`.
2. Implement the adapter in `src/adapters/`.
3. Wire the command (`src/cli/commands/`) — guard with `assertUsable(<key>)`.
4. Add a skill + recipe/eval and declare `requires_backend_capabilities`.
5. Add tests. Never fake backend behavior; return a normalized error instead.

## Rules

- Never print or persist API keys. Redact secrets in logs and artifacts.
- Every error must be agent-actionable: `code`, `message`, `likely_cause`,
  `next_action`, optional `suggested_commands`.
- Don't ship deceptive competitor benchmarks; evals must be reproducible.
