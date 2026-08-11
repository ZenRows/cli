---
name: batch-jobs
description: Scale protected fetch/extract over many URLs via Zenrows MCP batch_* tools (beta).
version: 0.1.0
---

# Batch Jobs (MCP)

Process large workloads asynchronously. Batch is where Zenrows' high-scale
anti-bot advantage becomes obvious — thousands to millions of URLs.

> Status: **beta**. Cloud Batch lives on `async.api.zenrows.com/v1`. Without
> beta access the API returns `BATCH_ACCESS_DENIED`. Do not fake a successful
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
   `autoparse`, `external_id`, `metadata`).
3. Poll `batch_status` until terminal (`completed` / `stopped` / …).
4. Collect with `batch_results`.
5. `batch_cancel` if the user aborts or the run should stop early.

## Rules

- **Never batch before validating** on a single page ([[extract]] /
  [[protected-fetch]]).
- Do **not** fan out hundreds of `scrape`/`extract` calls when Batch is the
  right primitive.
- Mind cost multipliers ([[cost-control]]).
- On Free-plan quota errors, surface the claim URL.
- Prefer these MCP tools over CLI `zenrows batch` when the MCP server is
  connected.
