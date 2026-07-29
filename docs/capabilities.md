# Capability matrix

The CLI consults `registry/capabilities.json` before every cloud call. This is
the single source of truth that prevents hallucinated execution.

## Status values

- **available** — a documented endpoint exists and the command does real work.
- **available-but-needs-confirmation** — likely available; verify per account.
- **experimental** — exists but gated (e.g. browser, behind `policy.allow_browser`).
- **beta** — real product in beta; limited access (local spec / validation works today, cloud execution needs beta access).
- **planned** — no documented endpoint yet; local spec / validation only.
- **not-implemented** / **deprecated** — not usable.

## How each primitive was classified

Classification is based on the public Zenrows documentation:

| Capability | Backend evidence | Status |
| --- | --- | --- |
| `protected_fetch` | Universal Scraper API `GET https://api.zenrows.com/v1/` with `mode`, `js_render`, `premium_proxy`, `proxy_country`, `wait`/`wait_for`, `js_instructions`, `response_type`, `screenshot`, `original_status`, … | available |
| `extract` | Same `/v1/` endpoint via `autoparse`, `css_extractor`, `response_type=markdown\|plaintext` | available |
| `batch` | Zenrows Batch Scraper API `https://async.api.zenrows.com/v1` (separate host, `X-API-Key` header) — real product in beta. Cloud subcommands (create/status/results/cancel/wait/retry-failed) work WITH beta access; without it the API returns 403 → `BATCH_ACCESS_DENIED`. Local JSONL spec validation + credit estimation work with no key. | beta |
| `browser` | Zenrows Scraping Browser (CDP) + `@zenrows/mcp` `browser_*` tools; no managed REST sessions API | experimental |
| `mcp` | Hosted `https://mcp.zenrows.com/mcp` + local `npx -y @zenrows/mcp` | available |

## Important honesty note

`protected_fetch` and `extract` are the **same** product: a single `/v1/`
Universal Scraper API. "Extract" is not a separate endpoint — it is parameters
on that endpoint (`autoparse` / `css_extractor` / `response_type`). The CLI keeps
them as separate commands only for ergonomics.
