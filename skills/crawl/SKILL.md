---
name: crawl
description: Collect the URLs behind one start page with Crawl (beta) — start a crawl, wait for it, read the kept URLs and optionally each page's HTML, stop it. Use when the user has a listing or section URL but not the item URLs.
version: 0.1.0
requires_backend_capabilities: [crawl]
---

# Crawl (beta)

Crawl is in beta. Give Crawl one start URL; it follows the links on that page (and, with a
higher depth, on the pages behind it) and returns the URLs it keeps. Use it
when you know where the items live (a category page, a blog index, a docs
section) but not the item URLs themselves. Once you have the URLs, read pages
with `zenrows fetch` / `zenrows extract`, or ask Crawl for each page's HTML
with `--html`.

Crawl stays on the start URL's registrable domain; subdomains count. An account without Crawl access gets
403 `REQS008` → `CRAWL_NOT_ENABLED` ("Crawl is not enabled for this account");
do not retry it.

## Start, wait, read

```
zenrows crawl start https://example.com/products/ --depth 1 \
  --max-items 20 --max-pages 25 --include /product/ --follow --json
zenrows crawl results <id> --json            # every kept URL
zenrows crawl results <id> --out urls.jsonl  # same, as JSONL
```

- `--depth N` is required: link hops from the start URL. `1` = the start
  page's links; `2` = also the links on each of those pages.
- `--max-items` (kept URLs) and `--max-pages` (fetched pages) cap the crawl;
  both default to 10. `--max-pages` bounds the cost: each page is one fetch.
  The local policy `max_pages_per_run` caps `--max-pages` (default 1000);
  above it the CLI refuses with `POLICY_LIMIT_EXCEEDED` before any request.
- `--include` / `--exclude` are substring matches on the normalized URL and
  repeat: `--include /product/ --exclude ?add-to-cart`.
- `start` returns at once. `--follow` (or `zenrows crawl wait <id>`) polls
  until the crawl ends (default timeout 600000 ms). On `--timeout` the crawl
  keeps running (it is not stopped) and you get `CRAWL_WAIT_TIMEOUT` with
  `crawl_id`. Ctrl-C also stops the wait, not the crawl, and exits 130;
  resume with `zenrows crawl wait <id>`.
- `results` on a running crawl returns the URLs kept so far, with
  `partial: true`. Read again once the crawl ends.

## Page HTML

```
zenrows crawl start <url> --depth 1 --html --max-pages 20 --follow
zenrows crawl results <id> --json        # fetched results carry content_url
zenrows crawl content <id> <content_id>  # one page's HTML (or pass the content_url)
zenrows crawl results <id> --download --out pages.jsonl  # every URL + HTML, NDJSON
```

`--html` uses up the page budget: each kept page is one more fetch, and
`--max-pages` counts it. Raise `--max-pages` to keep the same number of URLs.
A result's `content_status` is `pending`, `fetched` or `failed`; only
`fetched` results have content (else `CRAWL_CONTENT_NOT_FOUND`).

## While it runs, and after

```
zenrows crawl status <id>                       # status, coverage, stop_reason / error
zenrows crawl results <id> --cursor <c> --json  # one page; keep polling with next_cursor
zenrows crawl list                              # your crawls, newest first
zenrows crawl stop <id>                         # stop it; kept URLs stay readable
```

A crawl ends `completed` (nothing left, or a cap hit: `stop_reason`
`max_items` / `max_pages`), `stopped` (you stopped it) or `failed` (`error.code`
and `error.detail` say why). Only `failed` exits non-zero (`CRAWL_FAILED`).
`stop` on a crawl that already ended prints the status it ended with.

## Limits

When the account has reached its limit of active jobs (3 by default), shared
with its Batch jobs, a start gets 429 `too_many_crawls` →
`CRAWL_TOO_MANY_CRAWLS`; nothing was created. Retry after `retry_after`
seconds (about 30), or stop one of your crawls or Batch jobs first.

## Errors

Every Crawl error carries the API's code as `server_code` (when the API sent
one), and `crawl_id` once the crawl exists.

| Code | Meaning | Retry? |
| --- | --- | --- |
| `CRAWL_NOT_ENABLED` | 403 `REQS008`: Crawl is not enabled for this account | no |
| `CRAWL_INVALID_REQUEST` | 400 or 422: fix the request. For `idempotency_key_reused`, send a new key or no key | no, not as is |
| `CRAWL_REQUEST_IN_FLIGHT` | 409: the same Idempotency-Key is still in flight | yes, once the first request ends |
| `CRAWL_NOT_FOUND` / `CRAWL_CONTENT_NOT_FOUND` | 404: wrong id, or the page has no content | no |
| `CRAWL_TOO_MANY_CRAWLS` | 429: the account's active-job limit | yes, after `retry_after` |
| `CRAWL_WAIT_TIMEOUT` | the wait ran out; the crawl keeps running | wait again |
| `CRAWL_FAILED` | the crawl ended `failed`, or another error | 5xx: yes, with backoff |

Rules: start small (`--depth 1`, low caps) and check the results before a
deep crawl. Mind the cost ([[cost-control]]). Read errors with
[[trace-debug]].
