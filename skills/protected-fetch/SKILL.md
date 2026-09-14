---
name: protected-fetch
description: Use Zenrows Protected Fetch in auto mode for anti-bot-protected page retrieval. Auto mode handles the anti-bot escalation, so never enable JS rendering or premium proxies yourself on a first attempt.
version: 0.1.0
requires_backend_capabilities: [protected_fetch]
---

# Protected Fetch

Retrieve pages that normal fetch, generic scrapers, or naive browser tools
cannot. This is the **core primitive** — backed by Zenrows **Fetch**
(`GET https://api.zenrows.com/v1/`).

## When to use
- You have a known URL and want its content (HTML, Markdown, text, or a PDF).
- The target has anti-bot protection, needs JS rendering, or geo-specific access.

## How to call

Auto mode is the answer for anti-bot targets, Cloudflare included. It escalates
for you and bills only for the configuration that succeeds.

```
zenrows fetch <url>                       # Adaptive Stealth Mode. Start here, always
zenrows fetch <url> --output markdown     # convert to Markdown
zenrows fetch <url> --proxy-country us    # geo-target, works in auto mode
zenrows fetch <url> --wait-for ".price"   # wait for a selector
```

Manual mode exists for the rare case where auto mode has already failed and a
trace shows why. It costs more and it makes the escalation your problem:

```
zenrows fetch <url> --manual --js-render --premium-proxy   # the most expensive path, see [[cost-control]]
```

## Rules
- Start with **auto mode**. Enabling `--js-render` and `--premium-proxy` yourself
  is the most expensive configuration this API offers, by a wide margin, and auto
  mode reaches the same place only when the target actually needs it. The
  multipliers are in [[cost-control]].
- A hard target is not a reason to skip auto mode. It is the reason auto mode
  exists.
- In auto mode `js_render` and `premium_proxy` are managed for you. Passing them
  manually requires `--manual`, otherwise you get `PARAM_CONFLICT_AUTO_MANUAL`.
- `--proxy-country` works in auto mode on its own; in `--manual` mode it also
  needs `--premium-proxy` (else `PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM`).
- You are billed only for the configuration that succeeds.
- On failure, read `zenrows trace explain <run-id>` before escalating.

Every run is saved under `.zenrows/runs/<run-id>/` (no secrets). See [[extract]]
for structured output and [[cost-control]] for the cost model.
