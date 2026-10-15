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
  402, code `AUTH014`). The account still
  has credits and its other keys keep working. Do not retry and do not escalate:
  `zenrows usage` shows the cap and when it resets. Wait for the reset, or have
  the account owner raise or remove the cap at
  https://app.zenrows.com/settings/api-keys.
- `POLICY_MAX_CREDITS_EXCEEDED` → the account itself is out of credits (or a
  local policy credit limit was hit). Do not retry-loop; `zenrows usage` shows
  when credits renew. Top up or upgrade, or claim the account if it is an
  auto-created Free plan.
- Batch's 402 keeps the codes above: `POLICY_MAX_CREDITS_EXCEEDED` (out of
  credits, `reason: insufficient_credits`) or `KEY_CREDIT_CAP_REACHED`
  (`reason: api_key_cap_reached`). A run that stopped for lack of credits ends
  `failed` with `BATCH_FAILED` and `reason: insufficient_credits`. Afterwards
  run the tasks that did not finish with
  `zenrows batch retry-failed <id> --include-pending`.
- `BATCH_QUOTA_EXCEEDED` → Batch's 429 (`reason: too_many_active_jobs` or
  `too_many_scheduled_jobs`): the account reached an active-job (3)
  or scheduled-job (5) limit, shared with Crawl. A closed job frees its slot
  when its run ends (wait, or stop it), an open job when it is deleted, or
  closed and its run has ended, and a scheduled job only when it is deleted.
- `BATCH_FAILED` → any other Batch error (400, 409, 5xx), a run that ended
  `failed`, or a `wait` that timed out (`reason: wait_timeout`) or found the
  run paused (`reason: run_paused`); `server_code` holds the API's own code, and `failure_reason` /
  `failure_detail` in `zenrows batch status <id> --json` say why a run failed.
  A Batch 401, 403 and 404 keep their own codes: `AUTH_INVALID`,
  `BATCH_ACCESS_DENIED` and `BATCH_NOT_FOUND`.
- `CRAWL_NOT_ENABLED` → the API answered 403 `REQS008`: Crawl is not
  enabled for this account. Do not retry; ask Zenrows support for access.
- `CRAWL_INSUFFICIENT_CREDITS` / `CRAWL_KEY_CAP_REACHED` → Crawl's 402: the
  account is out of credits, or this key reached its credit cap (`AUTH014`).
  Same advice as `POLICY_MAX_CREDITS_EXCEEDED` / `KEY_CREDIT_CAP_REACHED`.
- `CRAWL_TOO_MANY_CRAWLS` → 429 `too_many_crawls`: the account has reached
  its limit of active jobs (3 by default), shared with its Batch jobs.
  Nothing was created; retry after `retry_after` seconds (see
  `zenrows crawl list`).
- `CRAWL_FAILED` → the crawl ended `failed`; `error.code` in
  `zenrows crawl get <id> --json` says why, with `error.detail`. See
  [[crawl]].
- `PARAM_CONFLICT_AUTO_MANUAL` → drop the managed flags or add `--manual`.
- `CAPABILITY_UNAVAILABLE` → the primitive is not available on this account (e.g. beta/invite-only); use the local-spec path where offered.

Escalate only with evidence from the trace. See [[cost-control]].
