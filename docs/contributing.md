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

## Running the Crawl e2e test

`tests/e2e/crawl.e2e.test.ts` drives the built CLI (`zenrows crawl …`) against a
live Zenrows API: it starts one small crawl of the target you give it (depth 1,
3 items, 5 pages, HTML output), waits for it, reads its results, one page's
HTML and the NDJSON export, lists crawls, stops the ended crawl and checks a
missing id. It is not part of `npm test`, and it skips unless `ZENROWS_E2E=1`,
`ZENROWS_API_KEY` and `ZENROWS_E2E_CRAWL_URL` are all set. It bills a few
pages on the key's account.

| Variable | Value |
| --- | --- |
| `ZENROWS_E2E` | `1` to run the test |
| `ZENROWS_API_KEY` | a key with Crawl access |
| `ZENROWS_E2E_CRAWL_URL` | the start URL to crawl, e.g. `https://example.com/products/` |
| `ZENROWS_E2E_CRAWL_INCLUDE` | optional include pattern, e.g. `/product/`; every result URL must contain it |
| `ZENROWS_CRAWL_API_BASE` | optional API base, default `https://api.zenrows.com/v1` |

Read the key from a file rather than typing it, so it stays out of your shell
history:

```bash
export ZENROWS_API_KEY="$(tr -d '\n' < path/to/api.key)"
ZENROWS_E2E=1 ZENROWS_E2E_CRAWL_URL=https://example.com/products/ \
  ZENROWS_E2E_CRAWL_INCLUDE=/product/ npm run test:e2e
```

To target a local or staging deployment, set `ZENROWS_CRAWL_API_BASE` to its
`/v1` base. When the account has too many crawls running, the test waits
`Retry-After` and retries the start for up to 5 minutes, so run concurrent e2e
runs on one account one at a time.

## Rules

- Never print or persist API keys. Redact secrets in logs and artifacts.
- Every error must be agent-actionable: `code`, `message`, `likely_cause`,
  `next_action`, optional `suggested_commands`.
- Don't ship deceptive competitor benchmarks; evals must be reproducible.
