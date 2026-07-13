# Eval: extract-smoke

Reproducible smoke test for Extract (Autoparse).

- **Target:** `https://www.scrapingcourse.com/ecommerce/` (public scraping demo)
- **Config:** `autoparse=true`
- **Success criteria:** HTTP 2xx and a non-empty body
- **Cost:** ~1× basic request

```
zenrows eval run extract-smoke
zenrows eval report extract-smoke
```
