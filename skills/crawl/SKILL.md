---
name: crawl
description: Collect the URLs behind one start page with Crawl — start a crawl, wait for it, read the kept URLs and optionally each page's HTML, stop it. Use when the user has a listing or section URL but not the item URLs.
version: 0.1.0
requires_backend_capabilities: [crawl]
---

# Crawl

Give Crawl one start URL; it follows the links on that page (and, with a
higher depth, on the pages behind it) and returns the URLs it keeps. Use it
when you know where the items live (a category page, a blog index, a docs
section) but not the item URLs themselves. Once you have the URLs, read pages
with `zenrows fetch` / `zenrows extract`, or ask Crawl for each page's HTML
with `--html`.

Crawl stays on the start URL's domain. An account without Crawl access gets
403 `REQS008` → `CRAWL_NOT_ENABLED` ("Crawl is not enabled for this account");
do not retry it.

## Start, wait, read

```
zenrows crawl start https://www.scrapingcourse.com/ecommerce/ --depth 1 \
  --max-items 20 --max-pages 25 --include /product/ --follow --json
zenrows crawl results <id> --json            # every kept URL (crawl must have ended)
zenrows crawl results <id> --out urls.jsonl  # same, as JSONL
```

- `--depth N` is required: link hops from the start URL. `1` = the start
  page's links; `2` = also the links on each of those pages.
- `--max-items` (kept URLs) and `--max-pages` (fetched pages) cap the crawl;
  both default to 10. `--max-pages` bounds the cost: each page is one fetch.
- `--include` / `--exclude` are substring matches on the normalized URL and
  repeat: `--include /product/ --exclude ?add-to-cart`.
- `start` returns at once. `--follow` (or `zenrows crawl wait <id>`) polls
  until the crawl ends; on `--timeout` the crawl keeps running (it is not
  stopped) and you get `CRAWL_TIMEOUT`.

## Page HTML

```
zenrows crawl start <url> --depth 1 --html --follow
zenrows crawl results <id> --json        # fetched results carry content_url
zenrows crawl content <id> <content_id>  # one page's HTML (or pass the content_url)
zenrows crawl results <id> --download --out pages.jsonl  # every URL + HTML, NDJSON
```

A result's `content_status` is `pending`, `fetched` or `failed`; only
`fetched` results have content.

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

## Limits

When the account has too many crawls running, a start gets 429
`too_many_crawls` → `CRAWL_QUOTA_EXCEEDED`; nothing was created. Retry after
`Retry-After` (about 30s), or stop one of your crawls first.

Rules: start small (`--depth 1`, low caps) and check the results before a
deep crawl. Mind the cost ([[cost-control]]). Read errors with
[[trace-debug]].
