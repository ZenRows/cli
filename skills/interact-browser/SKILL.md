---
name: interact-browser
description: Escalate to browser sessions only when fetch/extract cannot do the job.
version: 0.1.0
requires_backend_capabilities: [browser]
---

# Interact / Browser Sessions

Operate protected browser workflows (logins, clicks, forms, multi-step flows,
persistent cookies) on JS-heavy or interactive pages that Protected Fetch
cannot handle. This is **escalation only** — use it only when Protected Fetch
or Extract is insufficient.

> Browser Sessions is a **GA** Zenrows product (formerly Scraping Browser),
> **on by default** (opt out with `policy.allow_browser=false`). It is
> escalation-only and costs more than fetch/extract: sessions bill by
> **bandwidth + session time** and auto-terminate after **15 minutes**.
> Drive sessions with `zenrows browser` against the managed REST API
> (`https://mcp.zenrows.com/browser/sessions/*`, same backend as `@zenrows/mcp`
> `browser_*`). For raw CDP, `zenrows browser connect` prints the wss endpoint.

## Rules
- Try [[protected-fetch]] / [[extract]] first; escalate only with evidence — they cost less.
- On by default; if a workspace opted out, re-enable with `zenrows policy set allow_browser true`.
- Prefer `zenrows browser run <script.json>` for multi-step flows (auto-closes).
- Always `close` interactive sessions — billed by bandwidth + session time (15-min hard cap).
- `select --value` matches the option's `value` attribute (bare value or a CSS
  selector like `option[value="2"]`). Label text / index are not supported.
