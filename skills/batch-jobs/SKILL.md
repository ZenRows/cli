---
name: batch-jobs
description: "Scale protected fetch/extract over many URLs via Batch. Cloud create/list/status/wait/results/content/cancel/pause/resume/rerun/delete work with an API key; estimate/validate run locally with no key."
version: 0.1.0
requires_backend_capabilities: [batch]
---

# Batch Jobs

Process large workloads reliably and asynchronously. Batch is where Zenrows'
high-scale anti-bot advantage becomes obvious: thousands to 100,000 URLs per
job, at Fetch's prices.

> Zenrows **Batch** runs on a separate host (`async.api.zenrows.com/v1`) and
> costs the same credits as Fetch (1 basic, 5 js_render, 10 premium_proxy, 25
> both; Adaptive Stealth Mode 1 to 25). Failed tasks are not billed, except
> target 404/410 answers, as on Fetch. The cloud subcommands work with any
> active API key; a 403 maps to `BATCH_ACCESS_DENIED`. The toolkit never fakes
> a cloud run.

## Spec and estimate (local, no key)

```
zenrows batch estimate jobs.jsonl [--premium-proxy] [--js-render] [--manual]
```

`jobs.jsonl` is one JSON object per line, each with a `url` (http or https,
up to 2048 bytes). Optional per-task keys:

- `external_id`: up to 128 letters, digits, `.`, `_` or `-`; echoed on each
  result row (it does not have to be unique).
- `metadata`: up to 20 string-to-string entries; keys 1 to 64 of the same
  characters, values up to 1024 bytes (UTF-8), 4 KiB in total.
- `method` and `body`: `"method": "POST"` sends `body` (up to 16 KiB): a JSON
  string goes as a form body, any other JSON value as JSON (`"body": null` means
  no body). A POST task cannot
  use `js_render`, `js_instructions` or `json_response`.
- scrape params, flat (`js_render`, `premium_proxy`, `proxy_country`, `mode`,
  `autoparse`, `extract`, ...) or nested under `zenrows_params`. Booleans are
  `true`/`false` (or `"true"`/`"false"`).

`estimate` checks every line against those limits and prices the run the way
`create` would submit it, job-level flags included, as a range: Adaptive
Stealth Mode tasks count 1 at the low end and 25 at the upper bound. It exits 1
on any invalid line.

## Extract in Batch

`"extract": "auto"` on a line runs that URL through Extract, returning
structured data instead of raw HTML.

```
{"url": "https://example.com/products", "extract": "auto", "external_id": "p1"}
```

An Extract task costs the same as a regular one, so `batch estimate` prices it
correctly. The result carries two keys: `html` (the
raw page) and `parsed` (the structured data). Validate on a single URL with
`zenrows extract <url>` before running the full batch.

## Create, wait, read

```
zenrows batch create jobs.jsonl --follow --json
zenrows batch create jobs.jsonl --manual --premium-proxy --proxy-country us --output markdown
zenrows batch create jobs.jsonl --name nightly --external-id run-42 --metadata team=growth
zenrows batch results <id> --out results.jsonl   # every row, as JSONL
zenrows batch results <id> --download out/       # each result body + _manifest.jsonl
zenrows batch content <id> <task_id>             # one task's body
```

- Every GET task runs in Adaptive Stealth Mode (`mode=auto`) by default, like
  `fetch` and `extract`: Zenrows enables JS rendering and premium proxies only
  on the pages that need them, and bills only the configuration that
  succeeds. A task that turns on `js_render` or `premium_proxy`, or sets
  `mode`, itself keeps its own settings; `--js-render` / `--premium-proxy` force that
  configuration on every task; `--manual` turns Adaptive Stealth Mode off.
  Outside Adaptive Stealth Mode, `--proxy-country` needs `--premium-proxy`.
- Job-level flags apply to every task; per-task keys override them.
- `--follow` (alias `--wait`) waits until the run ends, the run is paused, or
  `--timeout` runs out (default 10 minutes; `30s`, `5m`, `1h`; a bare number
  is milliseconds). A wait that runs out exits 0 and prints the run with a
  `note` and `next: zenrows batch wait <id>`; the job keeps running. Ctrl-C
  stops the wait, not the job, and exits 130.
- A submit of 10,000 tasks or more answers 202 with `ingest_status: pending`
  while the API still receives the tasks; results stay partial until `done`.
- `create` and `rerun` send an `Idempotency-Key` (generated, or
  `--idempotency-key`) and retry network errors and 502/503/504 under it.
  When the outcome stays unknown, the error carries `idempotency_key` and the
  exact command that repeats the request safely (the API keeps a key 24 hours
  and answers a repeat with the original job). Never repeat with a new key.
- Results are kept 14 days by default; after that a row reads `expired`, has no
  `result_url`, and `content` answers `BATCH_RESULT_EXPIRED`. `--download`
  skips expired rows and counts them. A row's `result_url` is valid 2 hours:
  list the results again for a fresh one.
- `results --status successful|failed|processing|all`, `--run <run_id>` for an
  earlier run. On a run still in progress the output has `partial: true`.

With `--json`, `create`, `status`, `wait`, `cancel`, `pause`, `resume` and
`rerun` print `{ok, job_id, run_id, status, stats, job}` (plus `jobId`, kept
for older scripts), with `paused`, `ingest_status`, `accepted_tasks`,
`rerun_of`, `retried_tasks`, `inherited_tasks`, `failure_reason` and
`failure_detail` when the API sends them, and `note` when a wait ends early.

## While it runs, and after

```
zenrows batch list [--status open|closed] [--type regular|scheduled]
zenrows batch status <id>
zenrows batch wait <id> --timeout 30m
zenrows batch pause <id>              # no new task is picked up
zenrows batch resume <id>
zenrows batch cancel <id>             # stop the run; an ended run answers as it ended
zenrows batch retry-failed <id>       # rerun the failed tasks
zenrows batch retry-failed <id> --include-pending   # also the unfinished ones
zenrows batch rerun <id>              # failed + pending tasks; successful ones carry over
zenrows batch rerun <id> --status failed,pending,processing
zenrows batch rerun <id> --all        # every task (not with --status)
zenrows batch delete <id> --yes       # job, runs and stored results; frees its slot
```

A run ends `completed`, `stopped`, `failed` or `deleted`. A paused run is not
ended: `status` shows `paused: true`, and `wait` returns at once with a note
to `zenrows batch resume <id>`.

`status`, `wait`, `create --follow` and `rerun --follow` exit 1 (`ok: false`)
only for `failed`. A run fails when an account problem stops it, and the
error carries the same code and advice as the matching refused request, with
the run's `failure_reason` as `server_code` and the `job_id`:

- `insufficient_credits` → `POLICY_MAX_CREDITS_EXCEEDED`: add credits or claim
  the account (`zenrows usage`).
- `subscription_inactive` → `AUTH_INVALID`: fix the subscription in Billing.
- `api_key_cap_reached` → `KEY_CREDIT_CAP_REACHED`: the account still has
  credits and other keys keep working; wait for the cap to reset or raise it.
- anything else → `BATCH_FAILED`.

After any of these, and after a `cancel`, the tasks not yet run stay `pending`
(some can stay `processing`): fix the cause, then run them with
`zenrows batch rerun <id> --status failed,pending,processing`. Do not resubmit
the job. `rerun` with no flag reruns `failed,pending`, never the successful
tasks. A partial rerun (the default, or `--status`) works for 10 days after the
run started; after that only a full rerun (`zenrows batch rerun <id> --all`)
does. Every rerun is
a new run that answers 202 with `ingest_status: pending`.

## Limits

- 100,000 tasks per job; 3 active jobs per account, shared with Crawl. A
  closed job frees its slot when its run ends; an open or scheduled job only
  when deleted.
- The CLI's local policy caps a run at 10,000 URLs and 250,000 estimated
  credits by default (an Adaptive Stealth Mode task counts 25), so a default
  run of up to 10,000 URLs passes in any mode. For more, raise both:
  `zenrows policy set max_pages_per_run 100000` and
  `zenrows policy set max_credits_per_run 2500000`. A workspace created by an
  earlier CLI version keeps the caps in its `policy.json` (1,000 and 10,000);
  `POLICY_LIMIT_EXCEEDED` prints the exact command to raise them.
- Results 14 days; `result_url` 2 hours; partial reruns 10 days; a task that
  fails transiently is retried automatically up to 3 times.

Schedules, webhooks, ZIP exports, CSV inputs, open jobs (add tasks, close),
the runs list and task history are available through the Batch API and the
SDKs (Python, Node.js, Go), not this CLI.

## Errors

Every Batch error carries the API's code as `server_code` (when it sent one)
and `job_id` on any call about one job. Reads retry 429/502/503/504 and network
errors up to 3 times; `cancel`, `pause` and `resume` retry 502/503/504; `create`
and `rerun` retry the same under their Idempotency-Key. The "Retry?" column is
for errors that remain after these retries.

| Code | Meaning | Retry? |
| --- | --- | --- |
| `BATCH_ACCESS_DENIED` | 403: Batch is not enabled for this account or key | no |
| `AUTH_INVALID` | 401: the key was rejected; or the subscription is not active (401 `subscription_inactive`, 402 "Subscription has expired."; fix it in Billing) | no |
| `POLICY_MAX_CREDITS_EXCEEDED` | 402 `payment_required`: the account is out of credits | after credits renew or are added |
| `KEY_CREDIT_CAP_REACHED` | 402 `api_key_cap_reached`: this key reached its credit cap | after the cap resets or is raised |
| `BATCH_QUOTA_EXCEEDED` | 429 `quota_exceeded`: 3 active jobs (shared with Crawl), 5 scheduled jobs, or an open job's 100,000 tasks | after a slot frees (`zenrows batch list`) |
| `BATCH_NOT_FOUND` | 404: wrong id, deleted, or another account's job | no |
| `BATCH_RUN_IN_PROGRESS` | 409 `run_not_terminal`: the run is still going (or still receiving tasks) | after `wait` or `cancel` |
| `BATCH_RUN_ENDED` | 409 `run_not_stoppable`: the run already ended (pause/resume) | no; `rerun` starts a new run |
| `BATCH_NO_MATCHING_TASKS` | 409 `no_matching_tasks`: no task has the statuses asked for | with `--status failed,pending,processing`, or `rerun --all` |
| `BATCH_RERUN_WINDOW_EXPIRED` | 409 `partial_rerun_window_expired`: a partial rerun is over 10 days late | with `rerun --all` |
| `BATCH_REQUEST_IN_FLIGHT` | 409 `idempotency_key_conflict`: the key is in use or was used for another body | same command, same key, a moment later |
| `BATCH_CONFLICT` | any other 409 (job state, key no longer valid, concurrent change) | read the cause |
| `BATCH_TASK_NOT_READY` | 409 `task_not_ready` on `content`: the task has not finished | after `wait` |
| `BATCH_TASK_FAILED` | 422 on `content`: the task failed | after `retry-failed` |
| `BATCH_RESULT_EXPIRED` | 410 `result_expired`: past the 14-day visibility window | after `rerun --all` |
| `BATCH_FAILED` | the run ended `failed` for another reason; a 400 (fix the flagged tasks) or 5xx | 5xx: yes |
| `POLICY_LIMIT_EXCEEDED` | the local policy caps (see Limits) | after raising the cap |
| `BACKEND_UNAVAILABLE` | the API could not be reached | yes |

Rules: **never batch before validating** the workflow on a single page
([[extract]]). Mind the cost multipliers ([[cost-control]]). Read errors with
[[trace-debug]].
