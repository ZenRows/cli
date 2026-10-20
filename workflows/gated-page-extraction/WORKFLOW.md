---
name: gated-page-extraction
description: Get structured data out of pages that need interaction first, escalating to a browser only with evidence.
requires_backend_capabilities: [protected_fetch, browser, extract]
status: available
---

# Workflow: gated-page extraction

Some pages only show their data after an interaction: a login, a "load more",
a form. The rule from [[interact-browser]] applies end to end: **escalation
only** — a browser session costs more than fetch/extract (billed by bandwidth
plus session time, 15-minute cap), so it enters the flow only when the cheap
step has failed with evidence.

## Steps

1. **Try the cheap primitive first** ([[protected-fetch]]):
   ```
   zenrows fetch https://portal.example/reports
   ```
   If the response already carries the data, stop here — the rest of this
   workflow is unnecessary cost. If it fails, read the trace before escalating
   ([[trace-debug]]).
2. **Escalate to a scripted session.** Put the interaction (navigate, type,
   click, read) in a script and let the session close itself
   ([[interact-browser]]):
   ```
   zenrows browser run script.json
   ```
   Prefer the scripted form over an interactive session: interactive sessions
   you must `close` yourself, and every open minute bills.
3. **Turn the captured page into data** ([[extract]]):
   ```
   zenrows extract https://portal.example/reports --autoparse
   ```
   Or a selector map when you know the shape:
   ```
   zenrows extract https://portal.example/reports --css '{"report":"h2","total":".sum"}' --validate
   ```

## Explain

```
zenrows workflow explain gated-page-extraction
```

Each step declares its capability; the toolkit refuses honestly when a required
primitive is not available yet (`ASSET_REQUIRES_CAPABILITY`). Browser Sessions
is GA and on by default; a workspace that opted out re-enables it with
`zenrows policy set allow_browser true` ([[compliance-policy]]).
