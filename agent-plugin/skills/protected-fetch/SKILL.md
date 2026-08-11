---
name: protected-fetch
description: Use the Zenrows MCP scrape tool for anti-bot-protected page retrieval.
version: 0.1.0
---

# Protected Fetch (MCP `scrape`)

Retrieve pages that normal fetch, generic scrapers, or naive browser tools
cannot. Primary MCP tool: **`scrape`**.

## When to use

- Known URL, want page content (markdown, HTML, text, PDF, or screenshot).
- Target has anti-bot protection, needs JS rendering, or geo-specific access.

## How to call

```
scrape({ url })
scrape({ url, response_type: "markdown" })          # default — ideal for LLMs
scrape({ url, js_render: true })                    # SPAs / dynamic content
scrape({ url, js_render: true, premium_proxy: true })  # heavy anti-bot
scrape({ url, premium_proxy: true, proxy_country: "us" })
scrape({ url, js_render: true, wait_for: ".price" })
```

## Rules

- Start minimal. Enable `js_render` when content is clearly JS-loaded or the
  first result is empty/incomplete. Enable `premium_proxy` when you see
  403/blocked even with JS rendering.
- `proxy_country` requires `premium_proxy`.
- Prefer `response_type: "markdown"` for LLM consumption; use `html` only when
  you need raw markup.
- For **structured** fields, prefer the `extract` tool (or `scrape` with
  `autoparse` / `css_extractor` / `outputs`) — see [[extract]].
- On failure, escalate with evidence before `browser_*` ([[interact-browser]]).
- Cost model: [[cost-control]].

Do **not** treat CLI `zenrows fetch` as the primary interface when this MCP
server is available.
