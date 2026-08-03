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
| `zenrows fetch` | Fetch — retrieve a protected page | **available** — `GET https://api.zenrows.com/v1/` |
| `zenrows extract` | Extract — `extract=auto` (domain-gated open beta; falls back to Autoparse) / CSS / Markdown | **beta** — same `/v1/` |
| `zenrows batch` | Batch — fan out over many URLs | beta — cloud works with beta access; local validate/estimate always |
| `zenrows browser` | Browser Sessions REST API (same backend as MCP `browser_*`) | **available** — escalation-only; bills by bandwidth + time |
| `zenrows mcp` | MCP server config (remote + local) | **available** |
| Zenrows CLI | this repo | available |

The CLI maintains a **capability matrix** (`registry/capabilities.json`). Every
command checks status before any cloud call, so the toolkit never fakes behavior
for primitives the backend does not expose. Run `zenrows status` for the live
matrix.

## 4. Quickstart

```bash
npx -y @zenrows/cli init
zenrows fetch https://httpbin.io/html # auto-provisions a Free plan account on first use
zenrows extract https://www.owler.com/company/meltwater # extract=auto on an enabled domain
zenrows extract https://www.scrapingcourse.com/ecommerce/ --autoparse # Autoparse (any domain)
```

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
zenrows extract https://www.owler.com/company/meltwater                # extract=auto (enabled domain)
zenrows extract https://www.scrapingcourse.com/ecommerce/ --autoparse   # Autoparse (any domain)
zenrows extract <url> --css '{"title":"h1","price":".price"}' --validate
zenrows extract <url> --output markdown
```

## 9. Batch (beta)

Zenrows **Batch** (`https://async.api.zenrows.com/v1`) fans a
protected fetch/extract out over many URLs. It is a real product in
**beta**: the cloud subcommands work once your API key has
beta access; without it the API returns `BATCH_ACCESS_DENIED`. Local spec
validation + credit estimation always work (no key needed).

```bash
zenrows batch estimate jobs.jsonl                    # validate the spec + estimate credits (local)
zenrows batch create jobs.jsonl --wait               # submit a job and wait for it to finish
zenrows batch status <job-id>                        # run status + progress stats
zenrows batch results <job-id> --out results.jsonl   # collect results (paginated)
zenrows batch cancel <job-id>                        # stop an in-flight run
```

`jobs.jsonl` is one JSON object per line, each with a `url` (plus optional
per-line overrides like `js_render`, `premium_proxy`, `proxy_country`). Request
beta access from Zenrows to run in the cloud; until then, validate/estimate
locally or fan out with `zenrows fetch` per URL.

## 10. Browser Sessions

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

## 11. MCP

```bash
zenrows mcp status
zenrows mcp config --client claude-code      # exact `claude mcp add` command
zenrows mcp config --client cursor           # mcpServers JSON
zenrows mcp config --client vscode           # servers JSON
zenrows mcp config --client generic --remote # hosted server at https://mcp.zenrows.com/mcp
```

Local server: `npx -y @zenrows/mcp` (env `ZENROWS_API_KEY`). Remote server:
`https://mcp.zenrows.com/mcp`.

## 12. Plugins

```bash
zenrows plugin list
zenrows plugin install claude-code # installs core skills + prints MCP config
```

## 13. Skills

Agent-readable playbooks that teach agents how to choose primitives.

```bash
zenrows skill list
zenrows skill install --all
zenrows skill validate zenrows
```

The master skill `skills/zenrows/SKILL.md` teaches the full decision tree.

## 14. Templates

```bash
zenrows template list
zenrows template create protected-fetch-node --output ./my-project
```

## 15. Workflows

```bash
zenrows workflow list
zenrows workflow explain competitor-intelligence
```

## 16. Recipes

```bash
zenrows recipe list
zenrows recipe run fetch-protected-page
```

## 17. Evals

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

## 18. Security

- API keys are never printed or written into run artifacts/assets.
- Secrets live in `.zenrows/secrets.json` (0600, gitignored); logs are redacted.
- `.zenrows/account.json` holds no secret — only the accountId, Free-period info, and
  claim link.
- `.zenrows/policy.json` enforces credit/page/concurrency limits and domain allow/deny.
- Destructive `uninstall` requires `--yes`. Browser and experimental are off by
  default.

## 19. Capability matrix

See [`registry/capabilities.json`](registry/capabilities.json). `zenrows status
--json` emits it.

## 20. Contributing

The CLI is TypeScript with **zero runtime dependencies** (native `fetch`,
`node:util` `parseArgs`, `node:test`). Node 20+ runs the published build;
Node 23.6+ runs the TypeScript sources directly for development.

---

_Zenrows is building the protected web data infrastructure layer. The Zenrows
CLI is how that infrastructure becomes native to AI agents._
