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

## Domain not prepared yet (REQS007): prepare it, then extract again

`extract=auto` works on any prepared domain, and you can prepare one yourself.
On a domain Extract hasn't prepared yet, `zenrows extract` fails with
`EXTRACT_DOMAIN_NOT_ENABLED` (API code `403 REQS007`; legacy `402 AUTH010`) and
prints the command to run. It does not retry with Autoparse. The flow:

```
zenrows extract https://example.com/p/1             # 1. fails: Extract hasn't prepared example.com yet
zenrows extract prepare example.com \
  --url https://example.com/p/1 --url https://example.com/list --wait
                                                    # 2. prepare it and wait until ready (a few minutes)
zenrows extract https://example.com/p/1             # 3. extract again
```

- `--url`: 1 to 5 real pages you want to extract, one per kind of page.
- Without `--wait` the command returns at once; then poll with
  `zenrows extract prepare status example.com` (about every 30 seconds) until
  it says `ready`.
- The domain is the host: `shop.example.com` and `example.com` are prepared
  separately; a leading `www.` is dropped.
- Preparing costs no credits. Each new domain uses one slot of the account's
  monthly allowance; `prepare status` shows `used` / `limit` / `remaining`.
- `EXTRACT_PREPARE_OUT_OF_ALLOWANCE`: no slots left this month; use `--css`.
  `EXTRACT_PREPARE_UNAVAILABLE`: retry in a few minutes, do not loop.
  A `failed` status prints the next step for its failure code and says whether
  the attempt used an allowance slot.
- **Do not loop.** If `prepare` answers `ready` at once (`already_prepared`),
  the domain was prepared before; an extract that still fails with REQS007
  means that kind of page is not covered, and preparing again changes nothing.
  The same goes for `EXTRACT_PAGE_NOT_RECOGNISED` (REQS007 on a prepared domain:
  Extract did not recognise this page). Use `--css`, or contact Zenrows support
  with the URL.

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
