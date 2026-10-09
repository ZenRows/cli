---
name: crawl
description: Collect the URLs behind one start page with Crawl (beta): create a crawl, wait for it, read the kept URLs and optionally each page's HTML, stop it. Use when the user has a listing or section URL but not the item URLs.
version: 0.1.0
requires_backend_capabilities: [crawl]
---

# Crawl (beta)

Crawl is in beta. Give Crawl one start URL; it follows the links on that page (and, with a
higher depth, on the pages behind it) and returns the URLs it keeps. Use it
when you know where the items live (a category page, a blog index, a docs
section) but not the item URLs themselves. Once you have the URLs, read pages
with `zenrows fetch` / `zenrows extract`, or ask Crawl for each page's HTML
with `--output-format html`.

Crawl stays on the start URL's registrable domain; subdomains count. An account without Crawl access gets
403 `REQS008` → `CRAWL_NOT_ENABLED` ("Crawl is not enabled for this account");
do not retry it.

## Create, wait, read

```
zenrows crawl create https://example.com/products/ --depth 1 \
  --max-items 20 --max-pages 25 --include-pattern /product/ --follow --json
zenrows crawl results <id> --json            # every kept URL
zenrows crawl results <id> --out urls.jsonl  # same, as JSONL
```

- `--depth N` is required: link hops from the start URL. `1` = the start
  page's links; `2` = also the links on each of those pages.
- `--max-items` (kept URLs) and `--max-pages` (fetched pages) cap the crawl;
  both default to 10. `--max-pages` bounds the cost: each page is one fetch.
  The local policy `max_pages_per_run` caps `--max-pages` (default 1000);
  above it the CLI refuses with `POLICY_LIMIT_EXCEEDED` before any request.
- `--include-pattern` / `--exclude-pattern` are substring matches on the
  normalized URL and repeat:
  `--include-pattern /product/ --exclude-pattern ?add-to-cart`.
- `create` returns at once. `--follow` (or `zenrows crawl wait <id>`) polls
  until the crawl ends or `--timeout` seconds run out (default 600). When the
  time runs out, the command exits 0 and prints the crawl with status
  `running` and the hint `zenrows crawl wait <id>`. The crawl keeps running;
  it is not stopped. Ctrl-C also stops the wait, not the crawl, and exits 130;
  resume with `zenrows crawl wait <id>`.
- `results` on a running crawl returns the URLs kept so far, with
  `partial: true`. Read again once the crawl ends. `--limit` sets the page size
  of each request.

## Page HTML

```
zenrows crawl create <url> --depth 1 --output-format html --max-pages 20 --follow
zenrows crawl results <id> --json        # fetched results carry content_url
zenrows crawl content <id> <content_id>  # one page's HTML (or pass the content_url)
zenrows crawl download <id> --out pages.jsonl  # every URL + HTML, NDJSON
```

`--output-format html` uses up the page budget: each kept page is one more
fetch, and `--max-pages` counts it. Raise `--max-pages` to keep the same number
of URLs. A result's `content_status` is `pending`, `fetched` or `failed`; only
`fetched` results have content (else `CRAWL_CONTENT_NOT_FOUND`). `download`
reports the crawl's `status`, and `partial: true` while it runs.

## While it runs, and after

```
zenrows crawl get <id>                       # status, coverage, stop_reason / error, one page of results
zenrows crawl get <id> --cursor <c> --json   # the next page; keep polling with next_cursor
zenrows crawl list                           # your crawls, newest first (--cursor, --limit)
zenrows crawl stop <id>                      # stop it; kept URLs stay readable
```

A crawl ends `completed` (nothing left, or a cap hit: `stop_reason`
`max_items` / `max_pages`), `stopped` (you stopped it) or `failed` (`error.code`
and `error.detail` say why). Only `failed` exits non-zero (`CRAWL_FAILED`).
`stop` on a crawl that already ended prints the status it ended with.

## Limits

When the account has reached its limit of active jobs (3 by default), shared
with its Batch jobs, a create gets 429 `too_many_crawls` →
`CRAWL_TOO_MANY_CRAWLS`; nothing was created. Retry after `retry_after`
seconds (about 30), or stop one of your crawls or Batch jobs first.

## Errors

Every Crawl error carries the API's code as `server_code` (when the API sent
one), and `crawl_id` on any call about one crawl.

| Code | Meaning | Retry? |
| --- | --- | --- |
| `CRAWL_NOT_ENABLED` | 403 `REQS008`: Crawl is not enabled for this account | no |
| `AUTH_INVALID` | 401: the API key was rejected | no, log in again |
| `CRAWL_QUOTA_EXCEEDED` | 402: the account is out of credits (claim the account or add credits) | after credits renew or are added |
| `CRAWL_KEY_CAP_REACHED` | 402 `AUTH014`: this API key reached its credit cap | after the cap resets or is raised |
| `CRAWL_INVALID_REQUEST` | 400 or 422: fix the request. For `idempotency_key_reused`, send a new key or no key | no, not as is |
| `CRAWL_REQUEST_IN_FLIGHT` | 409: the same Idempotency-Key is still in flight | yes, once the first request ends |
| `CRAWL_NOT_FOUND` / `CRAWL_CONTENT_NOT_FOUND` | 404: wrong id, or the page has no content | no |
| `CRAWL_TOO_MANY_CRAWLS` | 429: the account's active-job limit | yes, after `retry_after` |
| `CRAWL_FAILED` | the crawl ended `failed`, or another error | 5xx: yes, with backoff |
| `BACKEND_UNAVAILABLE` | the API could not be reached | yes |

Rules: start small (`--depth 1`, low caps) and check the results before a
deep crawl. Mind the cost ([[cost-control]]). Read errors with
[[trace-debug]].
