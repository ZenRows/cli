---
name: batch-jobs
description: Scale protected fetch/extract over many URLs via Zenrows MCP batch_* tools.
version: 0.1.0
---

# Batch Jobs (MCP)

Process large workloads asynchronously. Batch is where Zenrows' high-scale
anti-bot advantage becomes obvious: thousands to 100,000 URLs per job, at
Fetch's prices.

> Cloud Batch lives on `async.api.zenrows.com/v1`. A 403 maps to
> `BATCH_ACCESS_DENIED`. Do not fake a successful
> run. This is **not** `browser_batch` (that batches browser actions in one
> session).

## MCP tools

| Tool | Purpose |
| --- | --- |
| `batch_create` | Submit a job (list of URL tasks + optional scrape/extract params) |
| `batch_status` | Poll run status + progress stats |
| `batch_results` | Page results (cursor pagination; filter successful/failed/all) |
| `batch_cancel` | Stop an in-flight run |

Optional if exposed by the server: `batch_wait` to block until terminal status.

## Workflow

1. Validate the workflow on **one** URL with `scrape` or `extract`.
2. `batch_create` with the full task list (each task: `url` + optional
   overrides like `js_render`, `premium_proxy`, `proxy_country`, `mode`,
   `autoparse`, `extract`, `external_id`, `metadata`). `extract: "auto"`
   returns structured data instead of raw HTML, at the same credit cost as a
   regular task; the result carries `html` and `parsed` keys.
3. Poll `batch_status` until terminal (`completed`, `stopped`, `failed` or
   `deleted`). A paused run (`pause_state: paused`) is not terminal and picks
   up no new task until resumed: report it instead of polling on.
4. Collect with `batch_results`. Results are kept 14 days by default (then a
   row reads `expired`); a `result_url` is valid 2 hours.
5. `batch_cancel` if the user aborts or the run should stop early.

A run ends `failed` when an account problem stops it: `failure_reason`
`insufficient_credits` (add credits), `subscription_inactive` (fix it in
Billing) or `api_key_cap_reached` (the key's own cap; the account still has
credits). The tasks not yet run stay `pending`: once fixed, rerun them with
status `failed,pending,processing` rather than resubmitting the job.

Schedules, webhooks, ZIP exports and CSV inputs are available through the
Batch API and the SDKs.

## Rules

- **Never batch before validating** on a single page ([[extract]] /
  [[protected-fetch]]).
- Do **not** fan out hundreds of `scrape`/`extract` calls when Batch is the
  right primitive.
- Mind cost multipliers ([[cost-control]]).
- On Free-plan quota errors, surface the claim URL.
- Prefer these MCP tools over CLI `zenrows batch` when the MCP server is
  connected.
