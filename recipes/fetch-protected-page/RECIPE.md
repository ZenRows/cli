---
name: fetch-protected-page
description: Fetch a single anti-bot-protected page in Adaptive Stealth Mode.
requires_backend_capabilities: [protected_fetch]
status: available
---

# Recipe: fetch a protected page

Fetches one page through Protected Fetch (`mode=auto`) and checks that content
came back.

## Run
```
zenrows recipe run fetch-protected-page
```

## Equivalent CLI
```
zenrows fetch https://httpbin.io/html
```

Swap the URL in `spec.json` for your real target. If the page is JS-heavy or
hard-protected, add `--manual --js-render --premium-proxy` (see [[protected-fetch]]).
