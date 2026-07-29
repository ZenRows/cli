# batch-jsonl-pipeline

Scaffold for a high-scale workload expressed as a JSONL job spec, run on the
Zenrows **Batch Scraper API**. One JSON object per line, each with a `url` (plus
optional per-line overrides like `js_render`, `premium_proxy`, `proxy_country`,
`mode`, `autoparse`, and an `external_id` echoed back on each result).

## Local (no key)

```bash
zenrows batch estimate jobs.example.jsonl    # validate the spec + estimate credits
```

## Cloud (needs a key + Batch beta access)

The Batch Scraper API is in **beta**. With beta access the
cloud subcommands run for real; without it the API returns `BATCH_ACCESS_DENIED`.

```bash
zenrows batch create jobs.example.jsonl --wait          # submit + wait for the run to finish
zenrows batch status <job-id>                           # run status + progress stats
zenrows batch results <job-id> --out results.jsonl      # collect results (paginated)
zenrows batch retry-failed <job-id>                     # rerun only the failed tasks
zenrows batch cancel <job-id>                           # stop an in-flight run
```

Job-level scrape options come from flags (`--js-render`, `--premium-proxy`,
`--proxy-country`, `--output`); per-line keys override them for that URL.
Without beta access yet, validate/estimate locally or fan out with
`zenrows fetch` per URL on a small sample first.
