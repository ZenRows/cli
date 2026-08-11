---
name: cost-control
description: Pick the cheapest reliable Zenrows MCP configuration and understand cost multipliers.
version: 0.1.0
---

# Cost control (MCP)

Prefer the **smallest reliable** configuration for stealth flags; escalate only
with evidence. Do not assume `extract` is cheaper than `scrape`.

## Cost multipliers (stealth / scrape options)

These multipliers apply when you enable the flags (on `scrape` or `extract`):

- Basic request: **1×**
- JS rendering (`js_render`): **5×**
- Premium proxies (`premium_proxy`): **10×**
- Both: **25×**

`extract` `mode=auto` is **open beta** and currently free; billing may apply
later. Do not promise permanent free extract pricing. Autoparse / CSS still
follow the multipliers above when stealth flags are set.

## Browser sessions (`browser_*`)

Bill by **bandwidth + session time**. Sessions auto-terminate after ~15 minutes.
Always call `browser_close`. Prefer `scrape` / `extract` when they can do the job
(by output shape — not because extract is “cheaper”).

## Batch

Batch is usually better at **scale** (many URLs) than fan-out of per-URL tool
calls. Validate one URL with `scrape`/`extract` first, then `batch_create`.
Batch access may be beta-gated (`BATCH_ACCESS_DENIED`).

## Tactics

- Default to the smallest option set that works; add `js_render` /
  `premium_proxy` only after a failed or empty result (or clear SPA/anti-bot
  signals).
- Reduce payload size: `extract` / `css_extractor` / `outputs` / markdown
  instead of full HTML.
- Validate on one page before `batch_create`.
- On Free-plan quota errors, surface the **claim URL** — do not invent billing
  flows.
- Prefer MCP tools from this plugin; do not shell out to `zenrows fetch` as
  the primary path.
