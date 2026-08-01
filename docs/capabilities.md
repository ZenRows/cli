# Capability matrix

The CLI consults `registry/capabilities.json` before every cloud call. This is
the single source of truth that prevents hallucinated execution.

## Status values

- **available** — a documented endpoint exists and the command does real work.
- **available-but-needs-confirmation** — likely available; verify per account.
- **experimental** — exists but not yet promoted to a stable status.
- **beta** — real product in beta; limited access (local spec / validation works today, cloud execution needs beta access).
- **planned** — no documented endpoint yet; local spec / validation only.
- **not-implemented** / **deprecated** — not usable.

## How each primitive was classified

Classification is based on the public Zenrows documentation:

| Capability | Backend evidence | Status |
| --- | --- | --- |
| `protected_fetch` | Fetch `GET https://api.zenrows.com/v1/` with `mode`, `js_render`, `premium_proxy`, `proxy_country`, `wait`/`wait_for`, `js_instructions`, `response_type`, `screenshot`, `original_status`, … | available |
| `extract` | Extract `GET https://api.zenrows.com/v1/` with `/v1/` endpoint via `extract`, `css_extractor`, `response_type=markdown\|plaintext` | available |
| `batch` | Batch `https://async.api.zenrows.com/v1` (separate host, `X-API-Key` header) — real product in beta. Cloud subcommands (create/status/results/cancel/wait/retry-failed) work WITH beta access; without it the API returns 403 → `BATCH_ACCESS_DENIED`. Local JSONL spec validation + credit estimation work with no key. | beta |
| `browser` | Browser Sessions REST API `https://mcp.zenrows.com/browser/sessions/*` (Bearer; same backend as `@zenrows/mcp` `browser_*`); CDP via `zenrows browser connect`. Escalation-only (prefer fetch/extract); on by default, opt out via `policy.allow_browser`; bills by bandwidth + session time (15-min max) | available |
| `mcp` | Hosted `https://mcp.zenrows.com/mcp` + local `npx -y @zenrows/mcp` | available |
