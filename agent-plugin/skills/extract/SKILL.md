---
name: extract
description: Turn protected pages into structured data with the Zenrows MCP extract tool (and scrape extraction params).
version: 0.1.0
---

# Extract (MCP)

Convert protected pages into structured data. Value is **protected page access
+ extraction**, not generic LLM parsing.

## Primary tool: `extract`

Use **`extract`** when you need structured JSON fields rather than a full page:

```
extract({ url })                                    # mode=auto (default)
extract({ url, mode: "autoparse" })                 # general Autoparse (any domain)
extract({ url, mode: "css", css_extractor: '{"title":"h1","price":".price"}' })
extract({ url, js_render: true, premium_proxy: true })  # stealth flags when needed
```

`mode=auto` (`extract=auto`) is **open beta**: richest on enabled domains,
currently free; billing may apply later. If the domain is not enabled (AUTH010),
the tool retries once with Autoparse by default (`fallback_autoparse`).

## Fallback: `scrape` extraction params

If `extract` is unavailable, similar outcomes are available on **`scrape`**:

```
scrape({ url, autoparse: true })
scrape({ url, css_extractor: '{"title":"h1","price":".price"}' })
scrape({ url, outputs: "emails,links" })            # or "*" for all built-ins
```

`outputs` types: `emails`, `headings`, `links`, `menus`, `images`, `videos`,
`audios`.

## When to use which

- **`mode=auto`**: site-tailored fields on beta-enabled domains.
- **`mode=autoparse`**: any website; also the automatic AUTH010 fallback.
- **`mode=css`**: known fields/selectors; deterministic.
- **Markdown via `scrape`**: feed clean content to an LLM yourself.

Do **not** assume extract is cheaper than scrape — pick by output shape.
Stealth flags (`js_render`, `premium_proxy`) still apply the usual multipliers
([[cost-control]]).

## Rules

- Validate on a single page before `batch_create` ([[batch-jobs]]).
- If Autoparse misses fields, switch to `css_extractor`, or add `js_render`
  for JS-heavy pages.
- Prefer MCP `extract` / `scrape` over CLI `zenrows extract` when the MCP
  server is connected.

See [[protected-fetch]] for retrieval-only semantics and [[cost-control]] for
multipliers.
