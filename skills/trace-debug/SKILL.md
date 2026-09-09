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
  escalates for you and bills only for what succeeds. For slow pages add
  `--wait-for <selector>`. Only when auto mode has failed on its own, take
  manual control with `--manual --js-render`, then `--premium-proxy`. Each step
  multiplies the cost of the request, and both together are the most expensive
  configuration available ([[cost-control]]).
- `REQUEST_TIMEOUT` → the CLI stopped waiting; the API was reached. Raise
  `--timeout` (default 120000ms, above the API's own 90s budget), or drop
  `--wait-for` so the request finishes inside that budget and the API returns
  its own error. Not a connectivity problem — do not chase the network.
- `BACKEND_UNAVAILABLE` → a genuine transport failure (DNS/TCP/TLS). Check
  connectivity and `zenrows config show`.
- `AUTH_INVALID` → re-check the key, `zenrows login --api-key …`.
- `PARAM_CONFLICT_AUTO_MANUAL` → drop the managed flags or add `--manual`.
- `CAPABILITY_UNAVAILABLE` → the primitive is not available on this account (e.g. beta/invite-only); use the local-spec path where offered.

Escalate only with evidence from the trace. See [[cost-control]].
