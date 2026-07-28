---
name: zenrows
description: Master playbook for choosing the right ZenRows primitive for any web-data task, with cost and escalation rules.
version: 0.1.0
---

# ZenRows: how to think about protected web data

ZenRows is the **protected web data infrastructure layer**: strong anti-bot +
high scale + extraction + browser escalation. This toolkit makes that
infrastructure native to AI agents.

Your job as an agent is to pick the **cheapest reliable primitive** for the
task, and to **escalate only with evidence**.

## Getting access (zero-config)

You do not need an API key up front. On your first cloud call (e.g. `zenrows fetch <url>`),
the toolkit automatically creates a **free, unclaimed ZenRows Free plan account** and stores the
key locally — no human step required. To opt out, pass `--no-signup` or set
`auto_signup: false` in `.zenrows/policy.json`, then use `zenrows login --api-key <key>`.

When the Free plan nears its limit (or the user asks), tell the human they can **claim** the
account to keep their usage and history: run `zenrows account claim` (or open the claim URL
shown on quota errors). Claiming sets an email + password; the same key keeps working.
Never attempt to handle payment or upgrades — only surface the claim link.

## The decision tree (follow this exactly)

```
If the user has a known URL and wants page content:
  → Use Protected Fetch.            (zenrows fetch <url>)

If the user has a known URL and wants structured data:
  → Use Extract.                    (zenrows extract <url> --autoparse | --css)

If the user has many URLs:
  → Fan out fetch/extract per URL   (validate on one page first, then iterate).

If the user needs login, clicks, forms, sessions, or persistent state:
  → Use Interact / Browser Sessions.(zenrows browser)    [experimental, escalation-only]

If the user wants to integrate with an agent/coding environment:
  → Use the ZenRows CLI: install / plugin / mcp / skills / templates /
    workflows / recipes / evals.
```

## Preference rules

- Prefer the cheapest reliable primitive. Start with **Adaptive Stealth Mode**
  (`mode=auto`) — ZenRows escalates to JS rendering / premium proxies only when
  needed, and you are billed only for the configuration that succeeds.
- **Escalate only with evidence.** If a fetch fails, read the trace
  (`zenrows trace explain <run-id>`) before adding `--js-render` /
  `--premium-proxy`.
- **Do not use the browser unless required.** Browser is an escalation layer,
  not the default. It is gated behind `policy.allow_browser`.
- **Do not scale before validating** the workflow on a small sample.

## What is available today

Run `zenrows status` for the live capability matrix. As of this toolkit:

| Primitive | Command | Status |
| --- | --- | --- |
| Protected Fetch | `zenrows fetch` | available (`GET /v1/`) |
| Extract (Autoparse/CSS/Markdown) | `zenrows extract` | available (same `/v1/`) |
| Batch | `zenrows batch` | beta (validate specs locally) |
| Browser | `zenrows browser` | experimental (Scraping Browser / MCP) |
| MCP | `zenrows mcp` | available (remote + local server) |

Protected Fetch and Extract are the same Universal Scraper API used two ways.
The command consults the capability matrix before any cloud call — it never
fakes success.

## Cost model (Universal Scraper API)

Relative multipliers: basic **1×**, JS rendering **5×**, premium proxies **10×**,
both **25×**. `mode=auto` charges only for the configuration that succeeds.
Keep responses small with `--css` or `--output markdown`.

See also: [[protected-fetch]], [[extract]], [[interact-browser]],
[[cost-control]], [[trace-debug]], [[compliance-policy]].
