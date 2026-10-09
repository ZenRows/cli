---
name: trace-debug
description: Read run traces and choose the next action when a fetch/extract fails.
version: 0.1.0
requires_backend_capabilities: []
---

# Trace & debug

Every `fetch`/`extract` writes a trace under `.zenrows/runs/<run-id>/` and
`.zenrows/traces/<run-id>/` (secret-free).

## Commands
```
zenrows trace inspect <run-id>    # raw run record
zenrows trace explain <run-id>    # what happened + likely cause + next action + exact command
zenrows trace replay <run-id>     # reconstruct the command line
zenrows trace export <run-id>     # JSON for sharing
```

## Failure → action map
- `FETCH_FAILED` / empty content → first retry in auto mode (`mode=auto`), which
  escalates for you and bills only for what succeeds. Only when auto mode has
  failed on its own, take manual control with `--manual --js-render`, then
  `--premium-proxy`. For slow pages, add `--wait-for <selector>` to a
  `--manual --js-render` run; auto mode may ignore it. Each step
  multiplies the cost of the request, and both together are the most expensive
  configuration available ([[cost-control]]).
- `REQUEST_TIMEOUT` → the CLI stopped waiting; the API was reached. Raise
  `--timeout` (default 120000ms, above the API's own 90s budget), or drop
  `--wait-for` so the request finishes inside that budget and the API returns
  its own error. Not a connectivity problem — do not chase the network.
- `BACKEND_UNAVAILABLE` → a genuine transport failure (DNS/TCP/TLS). Check
  connectivity and `zenrows config show`.
- `AUTH_INVALID` → re-check the key, `zenrows login --api-key …`.
- `KEY_CREDIT_CAP_REACHED` → this API key hit one of its own credit caps (HTTP
  402, gateway code `AUTH014`, Batch `api_key_cap_reached`). The account still
  has credits and its other keys keep working. Do not retry and do not escalate:
  `zenrows usage` shows the cap and when it resets. Wait for the reset, or have
  the account owner raise or remove the cap at
  https://app.zenrows.com/settings/api-keys.
- `POLICY_MAX_CREDITS_EXCEEDED` → the account itself is out of credits (or a
  local policy credit limit was hit). Do not retry-loop; `zenrows usage` shows
  when credits renew. Top up or upgrade, or claim the account if it is an
  auto-created Free plan.
- `BATCH_FAILED` → the batch run ended `failed`; `failure_reason` and
  `failure_detail` in `zenrows batch status <id> --json` say why.
- `CRAWL_NOT_ENABLED` → the API answered 403 `REQS008`: Crawl is not
  enabled for this account. Do not retry; ask Zenrows support for access.
- `CRAWL_TOO_MANY_CRAWLS` → 429 `too_many_crawls`: the account has reached
  its limit of active jobs (3 by default), shared with its Batch jobs.
  Nothing was created; retry after `retry_after` seconds (see
  `zenrows crawl list`).
- `CRAWL_FAILED` → the crawl ended `failed`; `error.code` in
  `zenrows crawl status <id> --json` says why, with `error.detail`. See
  [[crawl]].
- `PARAM_CONFLICT_AUTO_MANUAL` → drop the managed flags or add `--manual`.
- `CAPABILITY_UNAVAILABLE` → the primitive is not available on this account (e.g. beta/invite-only); use the local-spec path where offered.

Escalate only with evidence from the trace. See [[cost-control]].
