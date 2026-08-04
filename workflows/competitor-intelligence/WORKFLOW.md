---
name: competitor-intelligence
description: Gather competitor pages, extract structured data, and keep it fresh.
requires_backend_capabilities: [protected_fetch, extract]
status: available
---

# Workflow: competitor intelligence

A higher-level process built on Zenrows **Fetch and Extract**: retrieve
protected pages with `zenrows fetch`, then turn them into structured data with
`zenrows extract` (the same API's Autoparse / CSS / Markdown — not a separate
product). Scheduling and scaling use the tools you already have (cron/CI, a
simple per-URL loop).

## Steps

1. **Collect target URLs.** Start from a known list (sitemap, category pages,
   your own research). Retrieve each page reliably with `zenrows fetch`:
   ```
   zenrows fetch https://competitor.example/products
   ```
2. **Validate extraction** on one page (extract is beta; extract=auto falls back to autoparse).
   ```
   zenrows extract https://competitor.example/p/123 --validate
   ```
3. **Scale** across the collected URLs — loop the validated extract step over
   each URL (from your own script, cron, or CI):
   ```
   zenrows extract https://competitor.example/p/124 --validate
   ```
   > For large or recurring lists, **Batch** (`zenrows batch`) is
   > the managed alternative — one job submits many URLs, retries transient
   > failures, and stores results, so you don't operate the loop yourself. It's
   > in beta; you can request access and validate/estimate a spec
   > locally today with `zenrows batch estimate jobs.jsonl` (see [[batch-jobs]]).
4. **Keep fresh.** Schedule the extract step on a recurring basis with cron or
   CI (e.g. a daily GitHub Action that runs `zenrows extract …`).

## Explain
```
zenrows workflow explain competitor-intelligence
```

Each step declares its capability; the toolkit refuses honestly when a required
primitive is not available yet (`ASSET_REQUIRES_CAPABILITY`).
