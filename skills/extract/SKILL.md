---
name: extract
description: Turn protected pages into structured data with Extract / Autoparse / CSS / Markdown.
version: 0.1.0
requires_backend_capabilities: [extract]
---

# Extract

Convert protected pages into structured data. The value is **protected page
access + extraction**, not generic LLM parsing.

## Methods
```
zenrows extract <url>                              # extract=auto (default); falls back to Autoparse if domain not enabled
zenrows extract <url> --autoparse                  # general-purpose Autoparse (any domain)
zenrows extract <url> --css '{"title":"h1","price":".price"}'   # selector map
zenrows extract <url> --outputs emails,links       # built-in output filters → JSON
zenrows extract <url> --output markdown            # Markdown conversion
zenrows extract <url> --validate                   # fail if not valid JSON
```

## When to use which
- **Extract** (`extract=auto`, default): richest fields on domains enabled for the open beta.
- **Autoparse**: any website; also the automatic fallback when Extract is not enabled for the domain.
- **CSS**: you know the exact fields/selectors and want determinism.
- **Markdown/plaintext**: feed clean content to an LLM yourself.

## Rules
- Validate on a single page before scaling across many URLs.
- If Autoparse misses fields, switch to `--css` with explicit selectors, or add
  `--manual --js-render` for JS-heavy pages.

See [[protected-fetch]] for retrieval semantics.
