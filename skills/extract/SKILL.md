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

## Domain not prepared yet (REQS007)

`extract=auto` works on any prepared domain, and you can prepare one yourself.
On a domain Extract hasn't prepared yet the API answers `403 REQS007` (legacy:
`402 AUTH010`) and `zenrows extract` reports it; it does not retry with
Autoparse. To prepare the domain:

```
POST https://api.zenrows.com/v1/extract/prepared-domains
X-API-Key: <your key>
{"domain":"example.com","example_urls":["https://example.com/p/1","https://example.com/p/2"]}
```

Give 1 to 5 example URLs of the pages you want. Preparation takes a few
minutes and uses no credits. Poll `GET /v1/extract/prepared-domains/{domain}`
until `status` is `ready` (or `failed`), then retry the extract.

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
