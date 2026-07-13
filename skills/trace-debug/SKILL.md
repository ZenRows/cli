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
- `FETCH_FAILED` / empty content → retry `--manual --js-render`, then add
  `--premium-proxy`; for slow pages add `--wait-for <selector>`.
- `AUTH_INVALID` → re-check the key, `zenrows login --api-key …`.
- `PARAM_CONFLICT_AUTO_MANUAL` → drop the managed flags or add `--manual`.
- `CAPABILITY_UNAVAILABLE` → the primitive is not available on this account (e.g. beta/invite-only); use the local-spec path where offered.

Escalate only with evidence from the trace. See [[cost-control]].
