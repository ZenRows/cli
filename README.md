# Zenrows CLI

**Zenrows CLI is the open-source command-line, MCP, skills, templates,
workflows, recipes, and evals layer for giving AI agents reliable access to
protected web data through Zenrows cloud infrastructure.**

It makes the four Zenrows primitives — Fetch, Extract, Batch, and Browser
Sessions — installable and usable directly from AI agents and developer workflows —
so an agent can reliably access protected web data without hand-rolling anti-bot
handling, proxies, or browser rendering.

---

## 1. What this is

A single, dependency-light CLI (`zenrows`) plus an installable asset registry
(skills, templates, workflows, recipes, evals) and MCP configuration for popular
agent clients. It makes Zenrows installable, usable, testable, and distributable
through AI agents, developers, and teams.

## 2. Why Zenrows

Normal fetch fails. Generic scrapers fail. Browser-first tools are expensive.
Zenrows **Fetch** retrieves protected pages reliably and **Extract** structures
them, while **Browser Sessions** are there for the rare cases that
need a real browser. Zenrows wins when the workflow runs over thousands or
millions of URLs.

## 3. Product architecture

The core product is Zenrows **Fetch and Extract**
(`GET https://api.zenrows.com/v1/`). The CLI exposes it two ways: `zenrows fetch`
retrieves a protected page, and `zenrows extract` turns it into structured data
(JSON / CSS / Markdown). Both call the same endpoint — `extract` is just
that endpoint with extraction parameters, not a separate product.

| Command | What it does | Status (this build) |
| --- | --- | --- |
| `zenrows fetch` | Fetch: retrieve a protected page | **available**: `GET https://api.zenrows.com/v1/` |
| `zenrows extract` | Extract: turn a page into structured data with `extract=auto` on any prepared domain (falls back to Autoparse on one not prepared yet), CSS selectors, or Markdown | **available**: `GET https://api.zenrows.com/v1/?extract=auto` |
| `zenrows batch` | Batch: run Fetch and Extract over many URLs in one job; specs validate and estimate locally with no key | **available**: `POST https://async.api.zenrows.com/v1/jobs` |
| `zenrows crawl` | Crawl (new): collect the URLs behind one start page, optionally with each page's HTML | **available**: `POST https://api.zenrows.com/v1/crawls` |
| `zenrows browser` | Browser Sessions: a real cloud browser over REST (same backend as MCP `browser_*`); escalation-only, billed by bandwidth + time | **available**: `POST https://mcp.zenrows.com/browser/sessions` |
| `zenrows mcp` | MCP: set up the Zenrows MCP server in your client, remote or local | **available**: `https://mcp.zenrows.com/mcp` |
| `zenrows` | CLI: this repo, the commands above, plus skills and templates | **available**: `npm install -g @zenrows/cli` |

The CLI maintains a **capability matrix** (`registry/capabilities.json`). Every
command checks status before any cloud call, so the toolkit never fakes behavior
for primitives the backend does not expose. Run `zenrows status` for the live
matrix.

## 4. Quickstart

```bash
npm install -g @zenrows/cli # puts `zenrows` on PATH (466 ms, zero deps)
zenrows init
zenrows fetch https://httpbin.io/html # auto-provisions a Free plan account on first use
zenrows extract https://www.owler.com/company/meltwater # extract=auto on a prepared domain
zenrows extract https://www.scrapingcourse.com/ecommerce/ --autoparse # Autoparse (any domain)
```

> Prefer no global install? Prefix each command with `npx -y @zenrows/cli`
> (e.g. `npx -y @zenrows/cli fetch <url>`) — `npx` does not put `zenrows` on PATH.

No API key up front: on your first cloud call the toolkit creates a free,
unclaimed Zenrows Free plan account for you (see §6).

## 5. Install everything

```bash
zenrows init --all # workspace + config + policy + assets + MCP snippets + health check
zenrows init --agents claude-code,codex,cursor,gemini,opencode,windsurf,vscode
```

If a requested target cannot be auto-configured, the toolkit prints explicit
manual instructions rather than silently skipping it.

## 6. Zero-config access, signup & claim

You do **not** need an API key to get started. On your first cloud call
(e.g. `zenrows fetch <url>`), the toolkit automatically creates a **free,
unclaimed Zenrows Free plan account**, stores the key in `.zenrows/secrets.json`
(0600, gitignored), and records the account in `.zenrows/account.json`
(no secret — just the accountId, Free-period info, and a claim link).

When you (or your agent) want to keep the usage and history, **claim** the
account — this sets an email + password; the same key keeps working:

```bash
zenrows account status # show account + Free period + claim link
zenrows account claim  # open the claim URL in the browser
zenrows usage          # plan usage, credits & concurrency (does not count against your limit)
```

Opt out of auto-provisioning at any time:

```bash
zenrows fetch <url> --no-signup # do not auto-create an account for this call
zenrows signup --agent          # explicitly provision a Free plan account, headless
zenrows login --api-key <key>   # use an existing key (stored 0600, gitignored)
zenrows login --env             # use the ZENROWS_API_KEY environment variable
```

Set `auto_signup: false` in `.zenrows/policy.json` to disable auto-provisioning
globally.

## 7. Protected Fetch

```bash
zenrows fetch <url> # Adaptive Stealth Mode (mode=auto)
zenrows fetch <url> --output markdown
zenrows fetch <url> --manual --js-render --premium-proxy
zenrows fetch <url> --proxy-country us --wait-for ".price"
```

## 8. Extract

```bash
zenrows extract https://www.owler.com/company/meltwater                # extract=auto (prepared domain)
zenrows extract https://www.scrapingcourse.com/ecommerce/ --autoparse   # Autoparse (any domain)
zenrows extract <url> --css '{"title":"h1","price":".price"}' --validate
zenrows extract <url> --outputs emails,links                            # built-in output filters → JSON
zenrows extract <url> --output markdown
```

## 9. Batch

Zenrows **Batch** (`https://async.api.zenrows.com/v1`) fans a
protected fetch/extract out over many URLs. The cloud subcommands work
with any active API key and spend the same credits as Fetch. Local spec
validation + credit estimation always work (no key needed).

```bash
zenrows batch estimate jobs.jsonl                    # validate the spec + estimate credits (local)
zenrows batch create jobs.jsonl --wait               # submit a job and wait for it to finish
zenrows batch status <job-id>                        # run status + progress stats
zenrows batch results <job-id> --out results.jsonl   # collect results (paginated)
zenrows batch cancel <job-id>                        # stop an in-flight run
```

`jobs.jsonl` is one JSON object per line, each with a `url` (plus optional
per-line overrides like `js_render`, `premium_proxy`, `proxy_country`,
`extract`). Validate and estimate locally first, then submit with `create`.

**Extract in Batch.** Set `"extract": "auto"` on a line to run that URL through
Extract — structured data instead of raw HTML:

```jsonl
{"url": "https://example.com/products", "extract": "auto", "external_id": "p1"}
{"url": "https://example.com/reviews", "extract": "auto", "external_id": "r1"}
```

An Extract task costs the same as a regular one (1 credit at base tier), so
`batch estimate` prices it correctly. Results for an Extract task carry two
keys: `html` (the raw page) and `parsed` (the structured data) — validate a
sample with `zenrows extract <url>` before running the full batch.

## 10. Crawl (new)

Crawl is still evolving: new features are coming, limits may be tuned, and the changelog announces each change.

Crawl (`https://api.zenrows.com/v1/crawls`)
takes one start URL and returns the URLs it finds behind it, optionally with
each page's HTML. Use it when you know the listing or section but not the item
URLs. Crawl follows the links on each page, up to `--depth` hops when you set
it, and stays on the start URL's registrable domain (subdomains count). Without
`--output-format html` it returns URLs only. An account without Crawl access gets
`CRAWL_NOT_ENABLED` ("Crawl is not enabled for this account", HTTP 403
`REQS008`).

```bash
zenrows crawl create https://example.com/products/ --depth 1 \
  --max-items 20 --include-patterns /product/ --follow  # create and wait for the end
zenrows crawl results <crawl-id> --out urls.jsonl       # every kept URL (paginated)
zenrows crawl create <url> --depth 2 --output-format html  # also fetch each kept page's HTML
zenrows crawl content <crawl-id> <content-id>           # one page's HTML
zenrows crawl download <crawl-id>                       # NDJSON export (URLs + HTML) → <crawl-id>.jsonl
zenrows crawl get <crawl-id>                            # status, coverage, stop reason, one page of results
zenrows crawl wait <crawl-id>                           # wait for the end
zenrows crawl list                                      # your crawls, newest first
zenrows crawl stop <crawl-id>                           # stop a running crawl
```

`--depth` (link hops, 1 to 100000) is optional: leave it out and the crawl
follows links until `--max-items` or `--max-pages` stops it, or nothing is left
to open. `--max-items` and `--max-pages` cap the crawl (API default 100 each),
and `--max-pages` bounds the cost, since each page is one fetch. The local policy `max_pages_per_run` caps `--max-pages` (default
1000). `--output-format html` uses up the page budget: each kept page is one
more fetch, and `--max-pages` counts it. `--include-patterns` /
`--exclude-patterns` are repeatable substring filters on the URL. A crawl whose
pages held nothing new to follow ends `completed` with no results and exits 0.
When patterns were set, it prints a note (under `--json`, in `note`) to check
them against the URLs the start page links to. `get` and
`list` read one page and take `--cursor` and `--limit`. `results` follows every
page (`--limit` is the page size); on a running crawl it returns the URLs kept
so far, with `partial: true`. `download` reports the crawl's `status` (`null`
when the API sends none), and `partial: true` while it runs.

With `--json`, `create`, `get`, `wait` and `stop` print
`{ok, crawl_id, status, crawl}`. The crawl object (with `coverage`,
`stop_reason` and `error`) is under `crawl`. `get` adds `results` and
`next_cursor`. All keys are snake_case.

`wait`, and `create --follow`, poll until the crawl ends or `--timeout` seconds
run out (default 600). When the time runs out, the command exits 0 and prints
the crawl with status `running` and the hint `zenrows crawl wait <crawl-id>`
(under `--json`, in `note`); the crawl keeps running. Ctrl-C stops the wait, not the crawl, and exits 130;
resume with `zenrows crawl wait <crawl-id>`. A crawl that ends `failed` exits 1
with `CRAWL_FAILED`. A crawl that ends `stopped` because the account ran out of
credits or the API key hit a credit cap also exits 1, with the code a refused
create gets: `CRAWL_INSUFFICIENT_CREDITS` or `CRAWL_KEY_CAP_REACHED`, and the
API's `insufficient_credits` or `api_key_cap_reached` as `server_code`. Older
deployments end such a crawl `failed`; it gets the same codes. Its fetched pages
stay readable.

Errors carry the API's code as `server_code`, `crawl_id` on any call about one
crawl, and `retry_after` on a 429. When the account has reached its limit of
active jobs (3 by default), shared with its Batch jobs, a create gets 429
`too_many_crawls`, mapped to `CRAWL_TOO_MANY_CRAWLS`, and creates nothing; retry
after `retry_after` seconds. Any other 429 is `CRAWL_RATE_LIMITED`: requests
are being throttled; retry after `retry_after` seconds. Other codes: `CRAWL_INSUFFICIENT_CREDITS` and `CRAWL_KEY_CAP_REACHED` (402, with the
same claim, top-up and key-cap advice as other commands),
`CRAWL_INVALID_REQUEST` (400/422, do not retry as is), `CRAWL_REQUEST_IN_FLIGHT`
(409, retry once the first request ends), `CRAWL_NOT_FOUND`,
`CRAWL_CONTENT_NOT_FOUND`, `CRAWL_BUSY` (503 on a stop that was not saved yet;
run it again, it is safe) and `CRAWL_FAILED`. Set `ZENROWS_CRAWL_API_BASE` to
point the CLI at another deployment.

The CLI retries transient failures, as the Crawl SDKs do: up to 3 retries,
waiting the `Retry-After` seconds (at most 30) or 250 ms x 2^n (+/-20% jitter,
at most 10 s).
Reads retry on 429, 502, 503, 504 and network errors (a timeout counts).
`create` retries only with `--idempotency-key`, and only on 502, 503, 504 and
network errors, never on 429. `stop` retries on 429, 502, 503 (a `crawl_busy`
means the stop was not saved and the crawl still runs) and 504, waiting the
`Retry-After` seconds (at most 30) or 1 s; repeating a stop is safe.

## 11. Browser Sessions

Escalation only — **prefer `fetch`/`extract` for the vast majority of cases**;
they cost less. Use the browser for logins, forms, and multi-step JS flows that
Protected Fetch can't handle. Drives the managed Browser Sessions REST API
(`mcp.zenrows.com/browser/sessions/*`, same backend as the `@zenrows/mcp`
`browser_*` tools). `zenrows browser connect` prints the raw CDP wss URL for
bring-your-own Playwright/Puppeteer.

**Billing & lifecycle:** sessions bill by **bandwidth + session time** and
**auto-terminate after 15 minutes** — `run <script.json>` closes automatically;
close interactive sessions with `zenrows browser close`. On by default; opt out
with `zenrows policy set allow_browser false`.

## 12. MCP

```bash
zenrows mcp status
zenrows mcp config --client claude-code      # exact `claude mcp add` command
zenrows mcp config --client cursor           # mcpServers JSON
zenrows mcp config --client vscode           # servers JSON
zenrows mcp config --client generic --remote # hosted server at https://mcp.zenrows.com/mcp
```

Local server: `npx -y @zenrows/mcp` (stdio; can auto-provision a Free plan key).
Remote server: `https://mcp.zenrows.com/mcp` (streamable-http; client OAuth).

The portable Agent Plugins package at [`agent-plugin/`](agent-plugin/) declares
both servers in `mcp.json` (no secrets) and ships MCP-native skills under
`agent-plugin/skills/`. It is included in the published `@zenrows/cli` npm
tarball (`node_modules/@zenrows/cli/agent-plugin`).

## 13. Plugins

```bash
zenrows plugin list
zenrows plugin install claude-code # installs core skills + prints MCP config
```

**Agent Plugins 1.0:** after `npm install @zenrows/cli`, use
`node_modules/@zenrows/cli/agent-plugin/` (`plugin.json` + `mcp.json` +
MCP-native skills). See [`agent-plugin/README.md`](agent-plugin/README.md).
Legacy per-client snippets from `zenrows plugin install` remain available.
CLI-oriented skills stay under repo-root `skills/`.

## 14. Skills

Agent-readable playbooks that teach agents how to choose primitives.

```bash
zenrows skill list
zenrows skill install --all
zenrows skill validate zenrows
```

The master skill `skills/zenrows/SKILL.md` teaches the full decision tree.

## 15. Templates

```bash
zenrows template list
zenrows template create protected-fetch-node --output ./my-project
```

## 16. Workflows

```bash
zenrows workflow list
zenrows workflow explain competitor-intelligence
```

## 17. Recipes

```bash
zenrows recipe list
zenrows recipe run fetch-protected-page
```

## 18. Evals

Reproducible, transparent benchmarks. **No competitor keys are bundled** and
nothing is hardcoded to make Zenrows win — comparison evals require you to supply
your own credentials.

```bash
zenrows eval list
zenrows eval run protected-fetch-smoke
zenrows eval report protected-fetch-smoke
```

Reports write `input.json`, `results.json`, `report.md`, `failures.jsonl`,
`cost.json`, and `traces/` under `.zenrows/evals/<run-id>/`.

## 19. Security

- API keys are never printed or written into run artifacts/assets.
- Secrets live in `.zenrows/secrets.json` (0600, gitignored); logs are redacted.
- `.zenrows/account.json` holds no secret — only the accountId, Free-period info, and
  claim link.
- `.zenrows/policy.json` enforces credit/page/concurrency limits and domain allow/deny.
- Destructive `uninstall` requires `--yes`. Browser is on by default; opt out with
  `zenrows policy set allow_browser false`. Experimental features are off by default.

## 20. Capability matrix

See [`registry/capabilities.json`](registry/capabilities.json). `zenrows status
--json` emits it.

## 21. Contributing

The CLI is TypeScript with **zero runtime dependencies** (native `fetch`,
`node:util` `parseArgs`, `node:test`). Node 20+ runs the published build;
Node 23.6+ runs the TypeScript sources directly for development.

---

_Zenrows is building the protected web data infrastructure layer. The Zenrows
CLI is how that infrastructure becomes native to AI agents._
