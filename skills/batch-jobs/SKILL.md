---
name: batch-jobs
description: Scale protected fetch/extract over many URLs via Batch. Cloud create/status/results/cancel/wait/retry-failed work with an API key; estimate/validate run locally with no key.
version: 0.1.0
requires_backend_capabilities: [batch]
---

# Batch Jobs

Process large workloads reliably and asynchronously. Batch is where Zenrows'
high-scale anti-bot advantage becomes obvious — Zenrows wins when the workflow
runs over thousands, millions, or recurring sets of URLs.

> Zenrows **Batch** runs on a separate host (`async.api.zenrows.com/v1`) and
> spends the same credits as Fetch. The cloud subcommands work with any active
> API key; a 403 maps to `BATCH_ACCESS_DENIED`. The toolkit never fakes a
> cloud run.

## Local (no key, always works)
```
zenrows batch estimate jobs.jsonl     # validate the spec + estimate credits
```

`jobs.jsonl` is one JSON object per line, each with a `url` (plus optional
per-task keys: `external_id`, `metadata`, and scrape params like `js_render`,
`premium_proxy`, `proxy_country`, `mode`, `autoparse`, `extract`).

## Extract in Batch

`"extract": "auto"` on a line runs that URL through Extract, returning
structured data instead of raw HTML.

```
{"url": "https://example.com/products", "extract": "auto", "external_id": "p1"}
```

Extract adds no charge of its own: an Extract task costs what the same task
costs without it, so `batch estimate` prices it correctly. The result carries two keys: `html` (the
raw page) and `parsed` (the structured data). Validate on a single URL with
`zenrows extract <url>` before running the full batch.

## Cloud (needs a key)
```
zenrows batch create jobs.jsonl [--proxy-country cc] [--follow [--timeout ms]]
zenrows batch create jobs.jsonl --manual [--js-render] [--premium-proxy]
zenrows batch status <id>             # run status + stats
zenrows batch results <id> [--status successful|failed|processing|all] [--out results.jsonl]
zenrows batch wait <id> [--timeout ms] # default 600000 ms (600s also works); fails if paused
zenrows batch cancel <id>             # stop an in-flight run
zenrows batch retry-failed <id> [--include-pending]   # rerun failed (and unfinished) tasks
```

`create` and `retry-failed` send an `Idempotency-Key` and reuse it for their
own automatic retries, so a dropped connection never starts a second job or
run. Running a command again sends a new key unless you pass one: a repeated
`create` creates another job, and a repeated `retry-failed`, once the
previous run has ended, may start another run of the tasks that still match.
Either re-scrapes and bills those tasks again. With the same
`--idempotency-key <key>`, the same file and flags, within 24 hours of the
first request, a repeat cannot create a duplicate (after 24 hours the key is
forgotten). Its answer is not guaranteed to be the original: the API may
replay it, answer 409 (no recorded answer yet, or a rerun whose run is still
in progress), or refuse it before looking at the key (for example 402, out of
credits). When a submit or rerun ends without a
usable answer (no response, a 5xx, a refusal after a lost attempt, or a
success answer that can't be read), the error carries `idempotency_key` and
prints the exact command to repeat; run that, not a fresh command. If it
does not return the job, or reports that an earlier attempt may have gone
through, check `zenrows batch status <id>` (or the dashboard) before running
anything else. With a workspace, `create` and `retry-failed` also record the
key in their run artifact. If `create --follow` fails after the job was
created, the error names the job: follow it with `zenrows batch wait <id>`,
do not create it again. Status reads retry transient errors on their own.
`--timeout` takes milliseconds, as before; `600s` and `600000ms` also work.
`--wait` still works as an alias of `--follow`.

`--include-pending` reruns every task that did not finish: `failed`, `pending`
(never started) and `processing` (cut off mid-flight). `wait` fails right
away when a run is paused (`BATCH_FAILED`, `reason: run_paused`, exit 1, the
same code and exit as the timeout it would otherwise reach): a paused run
picks up no new task, though tasks already started may still finish.

Every task runs in Adaptive Stealth Mode (`mode=auto`) by default, like `fetch`
and `extract`: Zenrows enables JS rendering and premium proxies only on the pages
that need them, and bills only the configuration that succeeds. A task that sets
`js_render`, `premium_proxy` or `mode` itself keeps its own settings, and
`--js-render` / `--premium-proxy` force that configuration on every task instead.
`--manual` turns Adaptive Stealth Mode off. `batch estimate` counts auto tasks at
the 25x upper bound, so it's the most the run can cost, not the expected cost.

`create` validates the spec first, then submits. Outside Adaptive Stealth Mode,
`--proxy-country` needs `--premium-proxy` and is rejected before any request.
Job-level flags apply to every task; per-task keys in the JSONL override them.

A run ends in one of `completed`, `failed`, `stopped`, or `deleted`. `status`,
`wait`, and `create --wait` exit non-zero (`ok: false` under `--json`) only for
`failed`, and print the run's `failure_reason` and `failure_detail`. When
`failure_reason` is `api_key_cap_reached`, the key hit its own credit cap
(`KEY_CREDIT_CAP_REACHED`): the account still has credits, other keys keep
working, and the tasks not yet run stay pending. Wait for the cap to reset
(`zenrows usage`) or raise the cap, then run what is left with
`zenrows batch retry-failed <id> --include-pending`; do not resubmit the job.
A run that failed with `insufficient_credits` keeps `BATCH_FAILED` and works
the same way once credits are added. Errors carry the Batch API's own code as
`server_code`, and a finer `reason` (`insufficient_credits`,
`api_key_cap_reached`, `too_many_active_jobs`, `too_many_scheduled_jobs`,
`run_paused`, `wait_timeout`) next to the unchanged `code`. A `429`
(`BATCH_QUOTA_EXCEEDED`) means an account limit: 3 active jobs and 5
scheduled jobs by default. A closed job counts as active while its run is in
progress (wait for it, or stop it), an open job until it is deleted, or
closed and its run has ended, and a scheduled job counts toward its limit
until it is deleted.

## Local policy caps

`create` checks the run against `.zenrows/policy.json` before anything is sent:
`max_pages_per_run` (default 1000 URLs) and `max_credits_per_run` (default
10000 estimated credits). The estimate is an upper bound and counts each
Adaptive Stealth Mode task as 25, so with the defaults a run of more than 400
auto-mode URLs stops with `POLICY_LIMIT_EXCEEDED`. Raise the caps for large
jobs, e.g. `zenrows policy set max_pages_per_run 50000` and
`zenrows policy set max_credits_per_run 1250000`; the error names the exact
command for the run you tried.

Deferred (documented, not yet in the CLI): CSV upload, open/queue jobs,
scheduled jobs, webhooks/HMAC, and ZIP export.

Validate locally and fan out with `zenrows fetch` per URL on a small sample
before running a full batch.

Rules: **never batch before validating** the workflow on a single page
([[extract]]). Mind the cost multipliers ([[cost-control]]).
