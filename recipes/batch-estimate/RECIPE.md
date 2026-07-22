---
name: batch-estimate
description: Validate a JSONL batch spec and estimate its credit cost (local, no key).
requires_backend_capabilities: []
status: available
---

# Recipe: estimate a batch job spec

Validates a JSONL job spec (one JSON object per line, each with a `url`) and
estimates the credit cost — entirely locally, with no API key and no cloud call.
This is the safe first step before submitting a batch: catch malformed lines and
see the cost up front.

## Run
```
zenrows recipe run batch-estimate
```

## Equivalent CLI
```
zenrows batch estimate jobs.jsonl
```

Swap `jobs.jsonl` for your own spec. Per-line keys (`js_render`,
`premium_proxy`, `proxy_country`, `mode`, `autoparse`, `external_id`) tune each
URL; cost multipliers are basic 1x / JS 5x / proxy 10x / both 25x.

Once the spec is clean, submit it with beta access:
```
zenrows batch create jobs.jsonl --wait
```
See [[batch-jobs]] for the full cloud flow (beta).
