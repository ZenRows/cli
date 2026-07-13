# Eval: protected-fetch-smoke

Reproducible smoke test for Protected Fetch.

- **Target:** `https://httpbin.io/html`
- **Config:** Adaptive Stealth Mode (`mode=auto`)
- **Success criteria:** HTTP 2xx and ≥ 200 bytes of content
- **Cost:** ~1× basic request

```
zenrows eval run protected-fetch-smoke
zenrows eval report protected-fetch-smoke
```

Reports are written to `.zenrows/evals/<run-id>/` with `results.json`,
`report.md`, `failures.jsonl`, and `cost.json`. No competitor keys are bundled;
comparison evals require you to supply your own credentials.
