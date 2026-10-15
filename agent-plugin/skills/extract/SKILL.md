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
extract({ url })                                    # mode=auto (default), returns `parsed` only
extract({ url, include_html: true })                # also return the full page HTML
extract({ url, mode: "autoparse" })                 # deprecated Autoparse (any domain)
extract({ url, mode: "css", css_extractor: '{"title":"h1","price":".price"}' })
extract({ url, proxy_country: "US" })               # geo-targeted
```

`mode=auto` (`extract=auto`) works on any prepared domain, with any key, and
is currently free; billing may apply later. The result carries `parsed` only;
the page HTML is most of the response size, so ask for it with
`include_html: true` only when you need it.

Every mode uses Adaptive Stealth Mode by default: pass just the URL, even for
protected or dynamic sites. Set `js_render` or `premium_proxy` only to force a
fixed configuration; that turns Adaptive Stealth Mode off. Check `empty` in the
result: true means no field came back with a value.

## Domain not prepared yet (REQS007)

`mode=auto` works on any prepared domain, and you can prepare one yourself. On
a domain Extract hasn't prepared yet, `extract` returns a tool error (`REQS007`;
legacy `AUTH010`) that names the next step. It does not retry with Autoparse
unless you set `fallback_autoparse: true`. To prepare the domain:

```
POST https://api.zenrows.com/v1/extract/prepared-domains
X-API-Key: <your key>
{"domain":"example.com","example_urls":["https://example.com/p/1","https://example.com/p/2"]}
```

Give 1 to 5 example URLs of the pages you want. Preparation takes a few
minutes and uses no credits. Poll `GET /v1/extract/prepared-domains/{domain}`
until `status` is `ready` (or `failed`), then call `extract` again.

## Fallback: `scrape` extraction params

If `extract` is unavailable, similar outcomes are available on **`scrape`**:

```
scrape({ url, autoparse: true })                    # deprecated
scrape({ url, css_extractor: '{"title":"h1","price":".price"}' })
scrape({ url, outputs: "emails,links" })            # or "*" for all built-ins
```

`outputs` types: `emails`, `headings`, `links`, `menus`, `images`, `videos`,
`audios`.

## When to use which

- **`mode=auto`**: site-tailored fields on any prepared domain.
- **`mode=autoparse`** (deprecated): any website, only when asked for. Do not
  build new work on it.
- **`mode=css`**: known fields/selectors; deterministic.
- **Markdown via `scrape`**: feed clean content to an LLM yourself.

Do **not** assume extract is cheaper than scrape — pick by output shape.
Stealth flags (`js_render`, `premium_proxy`) still apply the usual multipliers
([[cost-control]]).

## Rules

- Validate on a single page before `batch_create` ([[batch-jobs]]).
- If a field is missing, switch to `css_extractor`, or add `js_render`
  for JS-heavy pages.
- Prefer MCP `extract` / `scrape` over CLI `zenrows extract` when the MCP
  server is connected.

See [[protected-fetch]] for retrieval-only semantics and [[cost-control]] for
multipliers.
