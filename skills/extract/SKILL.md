---
name: extract
description: Turn protected pages into structured data with Autoparse / CSS / Markdown.
version: 0.1.0
requires_backend_capabilities: [extract]
---

# Extract

Convert protected pages into structured data. The value is **protected page
access + extraction**, not generic LLM parsing.

> Honest note: there is no separate `/extract` endpoint. Extraction runs on the
> same Fetch and Extract API (`/v1/`) via `autoparse`, `css_extractor`, and
> `response_type`.

## Methods (available today)
```
zenrows extract <url> --autoparse                 # automatic structured JSON
zenrows extract <url> --css '{"title":"h1","price":".price"}'   # selector map
zenrows extract <url> --output markdown           # Markdown conversion
zenrows extract <url> --validate                  # fail if not valid JSON
```

## When to use which
- **Autoparse**: quick prototyping; product/article/job/listing pages.
- **CSS**: you know the exact fields/selectors and want determinism.
- **Markdown/plaintext**: feed clean content to an LLM yourself.

## Rules
- Validate on a single page before scaling across many URLs.
- If autoparse misses fields, switch to `--css` with explicit selectors, or add
  `--manual --js-render` for JS-heavy pages.

See [[protected-fetch]] for retrieval semantics.
