# Capability matrix

The CLI consults `registry/capabilities.json` before every cloud call. This is
the single source of truth that prevents hallucinated execution.

## Status values

- **available** — a documented endpoint exists and the command does real work.
- **available-but-needs-confirmation** — likely available; verify per account.
- **experimental** — exists but gated (e.g. browser, behind `policy.allow_browser`).
- **beta** — open beta; usable by any key. Product-specific limits (e.g. Extract
  domain coverage) are handled by adapters / API errors, not by blocking the CLI.
- **planned** — no documented endpoint yet; local spec / validation only.
- **not-implemented** / **deprecated** — not usable.

## How each primitive was classified

Classification is based on the public Zenrows documentation:

| Capability | Backend evidence | Status |
| --- | --- | --- |
| `protected_fetch` | Fetch `GET https://api.zenrows.com/v1/` with `mode`, `js_render`, `premium_proxy`, `proxy_country`, `wait`/`wait_for`, `js_instructions`, `response_type`, `screenshot`, `original_status`, … | available |
| `extract` | Extract `GET https://api.zenrows.com/v1/` via `extract=auto` (domain-gated open beta; CLI falls back to `autoparse`), plus `autoparse`, `css_extractor`, `outputs`, `response_type=markdown\|plaintext` | beta |
| `batch` | Batch `https://async.api.zenrows.com/v1` (separate host, `X-API-Key` header) — open beta. Local JSONL spec validation + credit estimation work with no key. | beta |
| `browser` | Zenrows Browser Sessions (CDP) + `@zenrows/mcp` `browser_*` tools; gated behind `policy.allow_browser` | available |
| `mcp` | Hosted `https://mcp.zenrows.com/mcp` + local `npx -y @zenrows/mcp` | available |
