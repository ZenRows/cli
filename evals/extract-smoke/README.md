# Eval: extract-smoke

Reproducible smoke test for Extract (`extract=auto`).

- **Target:** `https://www.owler.com/company/meltwater` (enabled domain, real company page)
- **Config:** `extract=auto`
- **Success criteria:** HTTP 2xx and a non-empty body
- **Cost:** ~1× basic request

```
zenrows eval run extract-smoke
zenrows eval report extract-smoke
```
