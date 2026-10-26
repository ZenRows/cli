---
name: extract
description: Turn protected pages into structured data with Extract / CSS / Markdown (Autoparse is deprecated).
version: 0.1.0
requires_backend_capabilities: [extract]
---

# Extract

Convert protected pages into structured data. The value is **protected page
access + extraction**, not generic LLM parsing.

## Methods
```
zenrows extract <url>                              # extract=auto (default), any prepared domain
zenrows extract <url> --autoparse                  # deprecated general-purpose Autoparse (any domain)
zenrows extract <url> --css '{"title":"h1","price":".price"}'   # selector map
zenrows extract <url> --outputs emails,links       # built-in output filters → JSON
zenrows extract <url> --output markdown            # Markdown conversion
zenrows extract <url> --validate                   # fail if not valid JSON
```

## When to use which
- **Extract** (`extract=auto`, default): richest fields; works on any prepared
  domain (you can prepare one yourself, see below).
- **Autoparse** (deprecated): only with `--autoparse`. Never automatic; do not
  build new work on it.
- **CSS**: you know the exact fields/selectors and want determinism.
- **Markdown/plaintext**: feed clean content to an LLM yourself.

## REQS007: prepare the domain, then extract again

`extract=auto` works on any prepared domain, and you can prepare one yourself.
When Extract refuses a page with `403 REQS007`, `zenrows extract` says which
of three cases it is and prints the next step. It never retries with Autoparse.

| Error code | Meaning | Next step |
| --- | --- | --- |
| `EXTRACT_DOMAIN_NOT_PREPARED` | The domain is not prepared yet (also the legacy `402 AUTH010`). | Prepare it (below), then extract again. |
| `EXTRACT_PAGE_NOT_RECOGNISED` | The domain is prepared, but Extract did not recognise this page as one it can extract (a page with nothing to extract, such as a home page, or a transient failure). | Try a product, article or listing page on the same site instead. If this page should work, retry it once in a few minutes; do not retry in a loop. Otherwise use `--css`. Preparing the domain again does not change this. |
| `EXTRACT_DOMAIN_NOT_ENABLED` | Extract is not enabled for the site. | Use `--css`, or contact Zenrows support to have the site enabled. Preparing does not change this. |

Preparing a domain:

```
zenrows extract https://www.example.com/products/a  # 1. fails: EXTRACT_DOMAIN_NOT_PREPARED
zenrows extract prepare example.com \
  --url https://www.example.com/products/a \
  --url https://www.example.com/products/b \
  --url https://www.example.com/products/c --wait
                                                    # 2. prepare it and wait until ready (a few minutes)
zenrows extract https://www.example.com/products/a  # 3. extract again
```

- `--url`: 1 to 5 real pages you want to extract. One works; we recommend 3 or
  more of the same page type (e.g. 3 product pages), because Extract compares
  pages of one type to check the fields it found and fill in fields one page is
  missing. Several page types can share the 5 (e.g. 3 product pages + 2
  search-result pages). With fewer than 3 the command prints a tip on stderr;
  it is never an error.
- Without `--wait` the command returns at once; then check about every 30
  seconds with `zenrows extract prepare status example.com` until it says
  `ready`. `--wait` polls at the same pace.
- The domain is the host: `shop.example.com` and `example.com` are prepared
  separately, and a leading `www.` is dropped.
- Preparing takes a few minutes and costs no credits. Each new domain uses one
  slot of the account's monthly allowance; `prepare status` shows `used` /
  `limit` / `remaining`.
- `EXTRACT_PREPARE_OUT_OF_ALLOWANCE`: no slots left this month; use `--css`.
  `EXTRACT_PREPARE_UNAVAILABLE`: retry in a few minutes; do not loop.
  A `failed` status prints the next step for its failure code and says whether
  the attempt used an allowance slot.
- A domain that is already prepared answers `ready` at once
  (`already_prepared`) and uses no slot: run the extract. If it then fails with
  `EXTRACT_PAGE_NOT_RECOGNISED`, follow that row of the table, not `prepare`.

## Rules
- Validate on a single page before scaling across many URLs.
- Check `empty` in `--json` output: true means every field came back null or
  empty, so the result is not data.
- If a field is missing, switch to `--css` with explicit selectors. Auto
  mode already renders JS when the target needs it, so reach for
  `--manual --js-render` only after auto mode has returned an incomplete page:
  it costs several times a basic call ([[cost-control]]) and it makes the
  escalation yours.

See [[protected-fetch]] for retrieval semantics.
