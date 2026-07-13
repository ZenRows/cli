# protected-fetch-node

Minimal Node.js project that calls the ZenRows Universal Scraper API
(Protected Fetch) directly.

```bash
cp .env.example .env   # add your ZENROWS_API_KEY
node index.mjs https://httpbin.io/html
```

Requires `protected_fetch` (available). Uses the global `fetch` (Node 18+) — no
dependencies. For Adaptive Stealth Mode, set `mode=auto` (default below).
