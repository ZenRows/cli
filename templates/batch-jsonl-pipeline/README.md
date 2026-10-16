# batch-jsonl-pipeline

Scaffold for a high-scale workload expressed as a JSONL job spec, run on the
Zenrows **Batch**. One JSON object per line, each with a `url` (plus
optional per-line overrides like `js_render`, `premium_proxy`, `proxy_country`,
`mode`, `autoparse`, `extract`, an `external_id` echoed back on each result,
string `metadata`, and `"method": "POST"` with a `body`). `batch estimate`
checks every line against the API's limits.

Set `"extract": "auto"` on a line to run that URL through Extract — structured
data instead of raw HTML, at the same credit cost as a regular task. Extract
results carry `html` and `parsed` keys.

## Local (no key)

```bash
zenrows batch estimate jobs.example.jsonl    # validate the spec + estimate credits
```

## Cloud (needs a key)

The cloud subcommands run with any active API key and cost the same credits
as Fetch.

```bash
zenrows batch create jobs.example.jsonl --follow        # submit + wait for the run to finish
zenrows batch status <job-id>                           # run status + progress stats
zenrows batch results <job-id> --out results.jsonl      # collect results (paginated)
zenrows batch retry-failed <job-id> --include-pending   # rerun what did not succeed
zenrows batch cancel <job-id>                           # stop an in-flight run
```

The local policy caps a run at 10,000 URLs and 250,000 estimated credits by
default; raise them with `zenrows policy set max_pages_per_run <n>` and
`zenrows policy set max_credits_per_run <n>`.

Tasks use Adaptive Stealth Mode (`mode=auto`) by default. Job-level scrape
options come from flags (`--js-render`, `--premium-proxy`, `--proxy-country`,
`--output`, or `--manual` to turn Adaptive Stealth Mode off); per-line keys
override them for that URL.
Validate/estimate locally, or try `zenrows fetch` per URL on a small sample
first.
