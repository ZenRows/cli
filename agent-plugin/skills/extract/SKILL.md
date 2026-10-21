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

## REQS007: prepare the domain, then extract again

`mode=auto` works on any prepared domain, and you can prepare one yourself.
When Extract refuses a page, `extract` returns a tool error with code
`REQS007` (legacy `AUTH010`) and a `reason`. It never retries with Autoparse.
`fallback_autoparse` is deprecated and has no effect; don't send it.

| `reason` | Meaning | Next step |
| --- | --- | --- |
| `domain_not_prepared` | The domain is not prepared yet. | `prepare_domain` (the error's `next_tool` holds its arguments), then poll, then `extract` again. |
| `page_not_recognised` | The domain is prepared, but Extract did not recognise this page as one it can extract (a page with nothing to extract, such as a home page, or a transient failure). | Try a product, article or listing page on the same site instead. If this page should work, retry it once in a few minutes; do not retry in a loop. Otherwise use `mode=css`. Do not call `prepare_domain`: preparing again does not change this. |
| `domain_not_enabled` | Extract is not enabled for the site. | Use `mode=css`, or contact Zenrows support to have the site enabled. Preparing does not change this. |

Preparing a domain:

```
extract({ url })                                          # 1. REQS007, reason domain_not_prepared
prepare_domain({ domain: "example.com", example_urls: [
  "https://www.example.com/products/a",
  "https://www.example.com/products/b",
  "https://www.example.com/products/c"] })
                                                          # 2. returns at once, status "preparing"
prepared_domain_status({ domain: "example.com" })         # 3. about every 30 seconds until "ready"
extract({ url })                                          # 4. extract again
```

- `example_urls`: real pages you want to extract, 1 to 5. One works; pass at
  least 3 example URLs of the same page type when you can, up to 5: several
  pages of each page type you need parsed (several types can share the 5, e.g.
  3 product pages + 2 search-result pages). Extract compares the pages of one
  type against each other, so it can check the fields it found and fill in
  fields one page is missing; more pages of a type give more complete, more
  reliable results.
- The domain is the host: `shop.example.com` and `example.com` are prepared
  separately, and a leading `www.` is dropped.
- Preparing takes a few minutes and costs no credits. Each new domain uses one
  slot of the account's monthly allowance; `prepared_domain_status` returns it
  (`used` / `limit` / `remaining`) and a `next` field with what to do now.
- `out_of_allowance`: no slots left this month; use `mode=css`.
  `overloaded` / `disabled`: retry in a few minutes; do not loop.
  A `failed` status carries `failure.code` and `failure.slot_consumed`; follow `next`.
- A domain that is already prepared answers `ready` at once
  (`already_prepared: true`) and uses no slot: call `extract`. If it then
  returns `page_not_recognised`, follow that row of the table, not `prepare_domain`.

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
