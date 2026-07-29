---
name: cost-control
description: Pick the cheapest reliable primitive and understand the Zenrows cost multipliers.
version: 0.1.0
requires_backend_capabilities: []
---

# Cost control

Prefer the **cheapest reliable** configuration; escalate only with evidence.

## Cost multipliers (Universal Scraper API)
- Basic request: **1×**
- JS rendering (`js_render`): **5×**
- Premium proxies (`premium_proxy`): **10×**
- Both: **25×**

With `mode=auto` (Adaptive Stealth Mode) you are billed only for the
configuration that **succeeds** — failed internal attempts are not charged.

## Tactics
- Default to `mode=auto`; let Zenrows escalate only when needed.
- Reduce response size with `--css` or `--output markdown` (avoids 413s too).
- Validate on one page before scaling across many URLs.
- Set guardrails in policy: `max_credits_per_run`, `max_pages_per_run`,
  `max_concurrency` ([[compliance-policy]]).
- Track per-run cost in `.zenrows/runs/<id>/run.json` (`costUsd`, from the
  `X-Request-Cost` header).
