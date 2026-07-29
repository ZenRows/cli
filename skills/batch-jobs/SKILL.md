---
name: batch-jobs
description: Scale protected fetch/extract over many URLs via the Batch Scraper API (beta). Cloud create/status/results/cancel/wait/retry-failed work with beta access; estimate/validate run locally with no key.
version: 0.1.0
requires_backend_capabilities: [batch]
---

# Batch Jobs

Process large workloads reliably and asynchronously. Batch is where Zenrows'
high-scale anti-bot advantage becomes obvious — Zenrows wins when the workflow
runs over thousands, millions, or recurring sets of URLs.

> Status: **beta**. The Zenrows Batch Scraper API is a real
> product in beta and runs on a separate host
> (`async.api.zenrows.com/v1`). The cloud subcommands work once your account has
> beta access; without it the API returns 403 → `BATCH_ACCESS_DENIED`. The
> toolkit never fakes a cloud run.

## Local (no key, always works)
```
zenrows batch estimate jobs.jsonl     # validate the spec + estimate credits
```

`jobs.jsonl` is one JSON object per line, each with a `url` (plus optional
per-task keys: `external_id`, `metadata`, and scrape params like `js_render`,
`premium_proxy`, `proxy_country`, `mode`, `autoparse`).

## Cloud (needs a key + beta access)
```
zenrows batch create jobs.jsonl [--js-render] [--premium-proxy] [--proxy-country cc] [--wait]
zenrows batch status <id>             # run status + stats
zenrows batch results <id> [--status successful|failed|all] [--out results.jsonl]
zenrows batch wait <id> [--timeout ms]
zenrows batch cancel <id>             # stop an in-flight run
zenrows batch retry-failed <id>       # rerun only the failed tasks (new run)
```

`create` validates the spec first, then submits. `--proxy-country` needs
`--premium-proxy` (or `mode=auto`) and is rejected before any request. Job-level
flags apply to every task; per-task keys in the JSONL override them.

Deferred (documented, not yet in the CLI): CSV upload, open/queue jobs,
scheduled jobs, webhooks/HMAC, and ZIP export.

Validate locally and fan out with `zenrows fetch` per URL on a small sample
before running a full batch.

Rules: **never batch before validating** the workflow on a single page
([[extract]]). Mind the cost multipliers ([[cost-control]]).
