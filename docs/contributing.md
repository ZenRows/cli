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
npm run build          # tsc → dist/
```

## Adding a primitive

1. Add/flip its entry in `registry/capabilities.json`.
2. Implement the adapter in `src/adapters/`.
3. Wire the command (`src/cli/commands/`) — guard with `assertUsable(<key>)`.
4. Add a skill + recipe/eval and declare `requires_backend_capabilities`.
5. Add tests. Never fake backend behavior; return a normalized error instead.

## Running the Crawl e2e test

`tests/e2e/crawl.e2e.test.ts` drives the built CLI (`zenrows crawl …`) against a
live Zenrows API: it creates one small crawl of the target you give it (depth 1,
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
`/v1` base. When the account has reached its limit of active jobs (3 by
default, shared with its Batch jobs), the test waits `retry_after` seconds and
retries the create for up to 5 minutes, so run concurrent e2e
runs on one account one at a time.

## Releases

Merge PRs with Conventional Commit titles, for example `fix(crawl): ...` or
`feat(extract): ...`. `fix`, `feat` and `perf` need a scope.

After each merge to `main`, release-please opens or updates the PR
`chore: release X.Y.Z`. It sets the version in `package.json`,
`package-lock.json` and `CLI_VERSION` in `src/core/config.ts`. Do not change
these by hand.

To release, merge that PR. The workflow runs the checks, creates the tag
`vX.Y.Z` and the GitHub release, and publishes `@zenrows/cli` to npm.

To publish an existing tag again, run the Release workflow by hand from
`main` with that tag.

### If the checks fail after the release PR is merged

The release PR runs no CI, so its checks first run after the merge. If they
fail, `main` already has the new version, but there is no tag, and the
merged release PR keeps the `autorelease: pending` label, which blocks the
next release PR. To recover:

1. Fix the problem in a normal PR and merge it.
2. Create the release on that fix commit, with the version from
   `.release-please-manifest.json`:
   `gh release create vX.Y.Z --target <fix commit> --title vX.Y.Z --generate-notes --notes-start-tag <previous tag>`
3. On the merged release PR, replace the label `autorelease: pending` with
   `autorelease: tagged`.
4. Run the Release workflow by hand from `main` with the tag `vX.Y.Z`.

## Rules

- Never print or persist API keys. Redact secrets in logs and artifacts.
- Every error must be agent-actionable: `code`, `message`, `likely_cause`,
  `next_action`, optional `suggested_commands`.
- Don't ship deceptive competitor benchmarks; evals must be reproducible.
