---
name: compliance-policy
description: Respect domain allow/deny rules, credit limits, and secret handling.
version: 0.1.0
requires_backend_capabilities: []
---

# Compliance & policy

Every cloud call is checked against `.zenrows/policy.json` before it runs.

## Policy knobs
```
zenrows policy show
zenrows policy set max_credits_per_run 5000
zenrows policy set blocked_domains "example.com,foo.test"
zenrows policy set allowed_domains "mysite.com"      # non-empty = allow-list mode
zenrows policy set allow_browser false               # opt OUT of browser (on by default)
zenrows policy set allow_experimental true
```

## Hard rules
- **Never** print or commit API keys. Keys live in `.zenrows/secrets.json`
  (0600, gitignored) and are redacted from logs and run artifacts.
- Respect `allowed_domains` / `blocked_domains` — enforced by the CLI (→ `POLICY_BLOCKED_DOMAIN`).
- `max_credits_per_run` / `max_pages_per_run` / `max_concurrency` are **advisory budgets** surfaced by `zenrows status` (not hard-enforced by the CLI today) — self-limit against them.
- Confirm destructive `uninstall` with `--yes`.
- **Experimental** commands are off by default (`allow_experimental`). **Browser is on by default** (opt out with `allow_browser=false`).

See [[cost-control]] and [[trace-debug]].
