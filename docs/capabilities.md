# Capability matrix

The CLI consults `registry/capabilities.json` before every cloud call. This is
the single source of truth that prevents hallucinated execution.

## Status values

- **available** — a documented endpoint exists and the command does real work.
- **available-but-needs-confirmation** — likely available; verify per account.
- **experimental** — exists but not yet promoted to a stable status.
- **planned** — no documented endpoint yet; local spec / validation only.
- **not-implemented** / **deprecated** — not usable.

## How each primitive was classified

Classification is based on the public Zenrows documentation:

| Capability | Backend evidence | Status |
| --- | --- | --- |
| `protected_fetch` | Fetch `GET https://api.zenrows.com/v1/` with `mode`, `js_render`, `premium_proxy`, `proxy_country`, `wait`/`wait_for`, `js_instructions`, `response_type`, `screenshot`, `original_status`, … | available |
| `extract` | Extract `GET https://api.zenrows.com/v1/` via `extract=auto` (any prepared domain; on one not prepared yet the CLI reports REQS007 as `EXTRACT_DOMAIN_NOT_ENABLED` with the command to prepare it: `zenrows extract prepare <domain> --url <page>`, which calls `POST /v1/extract/prepared-domains`; a page Extract did not recognise on a prepared domain is `EXTRACT_PAGE_NOT_RECOGNISED`, which preparing does not change), plus deprecated `autoparse`, `css_extractor`, `outputs`, `response_type=markdown\|plaintext` | available |
| `batch` | Batch `https://async.api.zenrows.com/v1` (separate host, `X-API-Key` header). Local JSONL spec validation + credit estimation work with no key. | available |
| `crawl` | Crawl `https://api.zenrows.com/v1/crawls` (`X-API-Key` header; same host as Fetch/Extract). Follows the links on each page from one start URL, up to `depth` when set (optional; no depth limit when omitted), on the start URL's registrable domain (subdomains count); returns URLs, and with `output_format: "html"` each page's HTML. Subcommands: `create`, `get`, `list`, `results`, `content`, `download`, `stop`, `wait`. Without Crawl access the API returns 403 `REQS008` → `CRAWL_NOT_ENABLED`. | available |
| `browser` | Browser Sessions REST API `https://mcp.zenrows.com/browser/sessions/*` (Bearer; same backend as `@zenrows/mcp` `browser_*`); CDP via `zenrows browser connect`. Escalation-only (prefer fetch/extract); on by default, opt out via `policy.allow_browser`; bills by bandwidth + session time (15-min max) | available |
| `mcp` | Hosted `https://mcp.zenrows.com/mcp` + local `npx -y @zenrows/mcp` | available |
