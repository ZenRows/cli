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

> Status: **experimental**, gated behind `policy.allow_browser` (default false).
> There is no managed REST "sessions" API; browser workflows run through the
> Zenrows **Scraping Browser** (CDP — connect Playwright/Puppeteer) and the
> `@zenrows/mcp` `browser_*` tools (navigate, click, fill, screenshot, …).

## Rules
- Try [[protected-fetch]] / [[extract]] first; escalate only with evidence.
- Enable in policy explicitly: `zenrows policy set allow_browser true`.
- Keep sessions short; capture a trace for debugging hard targets.
