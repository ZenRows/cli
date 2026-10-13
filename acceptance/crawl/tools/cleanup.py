"""Clean-up: stop every crawl this run started, then record each one's final state.

Reads out/results/crawls.jsonl, the ledger the checks write. A crawl still running is
stopped; then each crawl is read for its final status and coverage.pages_fetched, which the
report uses for the cost table. Writes out/cleanup.json. A crawl the API cannot be reached
for is recorded with its error, not stopped, and the clean-up goes on with the next one.
"""
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.request

OUT = sys.argv[1]
BASE = os.environ.get("CRAWL_API_BASE", "https://api.zenrows.com/v1").rstrip("/")
KEY = os.environ["ZENROWS_API_KEY"]
BUSY_RETRIES = 3
MAX_RETRY_AFTER = 30


def call(method, path):
    """(status, body, Retry-After). A network error or timeout raises."""
    req = urllib.request.Request(BASE + path, method=method, headers={"X-API-Key": KEY})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"null"), None
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read() or b"null")
        except ValueError:
            body = None
        return e.code, body, e.headers.get("Retry-After")


def stop(crawl_id):
    # 503 crawl_busy: the stop was not saved and the crawl still runs.
    for attempt in range(BUSY_RETRIES + 1):
        status, body, retry_after = call("POST", f"/crawls/{crawl_id}/stop")
        busy = status == 503 and isinstance(body, dict) and body.get("code") == "crawl_busy"
        if not busy or attempt == BUSY_RETRIES:
            return
        wait = retry_after.strip() if retry_after else ""
        time.sleep(min(int(wait), MAX_RETRY_AFTER) if wait.isdigit() else 1)


crawls = {}
ledger = os.path.join(OUT, "results", "crawls.jsonl")
if os.path.exists(ledger):
    with open(ledger) as f:
        for line in f:
            if line.strip():
                row = json.loads(line)
                entry = crawls.setdefault(row["crawl_id"], {"purposes": []})
                if row["purpose"] not in entry["purposes"]:
                    entry["purposes"].append(row["purpose"])

rows = []
for crawl_id, entry in crawls.items():
    stopped, status, body, error = False, None, None, None
    try:
        status, body, _ = call("GET", f"/crawls/{crawl_id}?limit=1")
        if status == 200 and body and body.get("status") == "running":
            stop(crawl_id)
            stopped = True
            time.sleep(2)
            status, body, _ = call("GET", f"/crawls/{crawl_id}?limit=1")
    except (OSError, http.client.HTTPException) as e:
        stopped, status, body, error = False, None, None, f"{type(e).__name__}: {e}"
    row = {"crawl_id": crawl_id, **entry, "stopped_by_cleanup": stopped, "http": status}
    if error:
        row["error"] = error
    if status == 200 and body:
        row.update(status=body.get("status"), stop_reason=body.get("stop_reason"),
                   pages_fetched=body.get("coverage", {}).get("pages_fetched"),
                   output_format=body.get("output_format"))
    rows.append(row)
    print(f"{crawl_id} {row.get('status')} pages_fetched={row.get('pages_fetched')}"
          f"{' (stopped by clean-up)' if stopped else ''}{f' ({error})' if error else ''}")

still = [r["crawl_id"] for r in rows if r.get("status") == "running"]
with open(os.path.join(OUT, "cleanup.json"), "w") as f:
    json.dump({"crawls": rows, "still_running": still,
               "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f, indent=2)
print(f"clean-up: {len(rows)} crawls, {len(still)} still running")
