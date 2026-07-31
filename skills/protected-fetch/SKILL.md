---
name: protected-fetch
description: Use Zenrows Protected Fetch for anti-bot-protected page retrieval.
version: 0.1.0
requires_backend_capabilities: [protected_fetch]
---

# Protected Fetch

Retrieve pages that normal fetch, generic scrapers, or naive browser tools
cannot. This is the **core primitive** — backed by Zenrows **Fetch**
(`GET https://api.zenrows.com/v1/`).

## When to use
- You have a known URL and want its content (HTML, Markdown, text, or a PDF).
- The target has anti-bot protection, needs JS rendering, or geo-specific access.

## How to call
```
zenrows fetch <url>                       # Adaptive Stealth Mode (recommended)
zenrows fetch <url> --output markdown     # convert to Markdown
zenrows fetch <url> --manual --js-render --premium-proxy   # full manual control
zenrows fetch <url> --proxy-country us    # geo-target (auto mode; in manual mode needs --premium-proxy)
zenrows fetch <url> --wait-for ".price"   # wait for a selector
```

## Rules
- Start with **auto mode**. In auto mode, `js_render` and `premium_proxy` are
  managed for you — passing them manually requires `--manual`
  (otherwise you get `PARAM_CONFLICT_AUTO_MANUAL`).
- `--proxy-country` works in auto mode on its own; in `--manual` mode it also
  needs `--premium-proxy` (else `PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM`).
- You are billed only for the configuration that succeeds.
- On failure, read `zenrows trace explain <run-id>` before escalating.

Every run is saved under `.zenrows/runs/<run-id>/` (no secrets). See [[extract]]
for structured output and [[cost-control]] for the cost model.
