---
name: zenrows
description: Master playbook for choosing the right Zenrows MCP primitive for any web-data task, with cost and escalation rules.
version: 0.1.0
---

# Zenrows (MCP): how to think about protected web data

Zenrows is the **protected web data infrastructure layer**: strong anti-bot +
high scale + extraction + browser escalation. This plugin exposes that
infrastructure through the Zenrows MCP server.

Your job as an agent is to pick a **reliable MCP tool** for the task (match
output shape; escalate only with evidence). Prefer MCP tools over shelling
out to the Zenrows CLI. For stealth flags, start simple — see [[cost-control]].

## Getting access (zero-config)

You do **not** need an API key in the plugin package.

- **stdio** (`npx -y @zenrows/mcp`): on first cloud call the server can
  auto-create a **free, unclaimed** Zenrows Free plan account and persist the
  key locally. When the Free plan nears its limit (or the user asks), surface
  the **claim URL** so a human can claim the account (email + password). The
  same key keeps working after claim. Never handle payment or upgrades —
  only show the claim link.
- **Remote** (`https://mcp.zenrows.com/mcp`): the client runs **OAuth**
  (Login or Create Free account → consent → token). Do not invent a parallel
  auth flow and do not ask the user to paste keys into `mcp.json`.

## The decision tree (follow this exactly)

```
If the user has a known URL and wants page content:
  → Use Protected Fetch.            (MCP tool: scrape)

If the user has a known URL and wants structured data:
  → Use Extract.                    (MCP tool: extract)
                                     Fallback: scrape with autoparse / css_extractor / outputs

If the user has many URLs (bulk):
  → Use Batch.                      (validate one page with scrape/extract first,
                                     then batch_create → batch_status → batch_results)
                                     Prefer Batch over fan-out of scrape/extract
                                     per URL for bulk work (may be beta-gated).
                                     Cancel with batch_cancel when needed.

If the user needs login, clicks, forms, sessions, or persistent state:
  → Use Interact / Browser Sessions.(MCP tools: browser_*)    [escalation-only]
```

## Preference rules

- Match the tool to the output: `scrape` for page content, `extract` for
  structured fields. Start simple; add `js_render` / `premium_proxy` only with
  evidence of failure or dynamic/protected content.
- **Escalate only with evidence.** If `scrape`/`extract` fails or returns
  empty/blocked content, diagnose before jumping to `browser_*`.
- **Do not use the browser unless required.** Browser bills by bandwidth +
  session time and auto-terminates after ~15 minutes. Always `browser_close`
  when done.
- **Do not scale before validating** the workflow on a small sample.

## MCP tools available

| Primitive | MCP tools | Notes |
| --- | --- | --- |
| Protected Fetch | `scrape` | Default markdown; HTML / plaintext / PDF / screenshot options |
| Extract | `extract` | Structured JSON (`extract=auto`, autoparse, css_extractor). `extract=auto` open beta (currently free; billing may apply later) |
| Batch | `batch_create`, `batch_status`, `batch_results`, `batch_cancel` | Beta; may return `BATCH_ACCESS_DENIED` without access |
| Browser | `browser_*` (start with `browser_navigate`) | Escalation-only; same backend as Browser Sessions |

## Cost notes

Stealth multipliers on requests: basic **1×**, JS rendering **5×**, premium
proxies **10×**, both **25×**. Keep responses small with `css_extractor`,
`outputs`, or `response_type: markdown`. Do not claim extract is cheaper than
scrape. See [[cost-control]].

See also: [[protected-fetch]], [[extract]], [[batch-jobs]], [[interact-browser]].
