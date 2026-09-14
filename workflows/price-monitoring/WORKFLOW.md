---
name: price-monitoring
description: Watch prices across many product pages, validated once and then run as a managed batch.
requires_backend_capabilities: [protected_fetch, extract, batch]
status: available
---

# Workflow: price monitoring

Three primitives in a row: prove the page with **Fetch**, prove the structure
with **Extract**, then let **Batch** operate the loop. Each step is the cheapest
tool that answers the next question, per [[cost-control]].

## Steps

1. **Prove the page loads with its price.** One protected fetch, waiting for
   the selector you care about ([[protected-fetch]]):
   ```
   zenrows fetch https://shop.example/p/123 --wait-for ".price"
   ```
2. **Prove the structure once.** A selector map that must come back as valid
   JSON, or fail loudly ([[extract]]):
   ```
   zenrows extract https://shop.example/p/123 --css '{"title":"h1","price":".price"}' --validate
   ```
3. **Estimate before spending.** Put the full URL list in `jobs.jsonl` and ask
   what the run would cost — this validates the spec locally and needs no key
   ([[batch-jobs]]):
   ```
   zenrows batch estimate jobs.jsonl
   ```
4. **Run it managed.** Batch submits every URL, retries transient failures and
   stores results, so you do not operate the loop yourself:
   ```
   zenrows batch create jobs.jsonl --wait
   zenrows batch results <id> --status all --out results.jsonl
   ```
5. **Keep it fresh.** Rerun on a schedule (cron or CI). Failures do not restart
   the world:
   ```
   zenrows batch retry-failed <id>
   ```

## Explain

```
zenrows workflow explain price-monitoring
```

Each step declares its capability; the toolkit refuses honestly when a required
primitive is not available yet (`ASSET_REQUIRES_CAPABILITY`). Batch is beta —
`estimate` runs locally today, the cloud steps need beta access.
