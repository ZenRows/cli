---
name: interact-browser
description: Escalate to Zenrows MCP browser_* sessions only when scrape/extract cannot do the job.
version: 0.1.0
---

# Interact / Browser Sessions (MCP `browser_*`)

Operate protected browser workflows (logins, clicks, forms, multi-step flows,
persistent cookies) on JS-heavy or interactive pages that `scrape` / `extract`
cannot handle. **Escalation only.**

> Browser Sessions bill by **bandwidth + session time** and auto-terminate
> after ~15 minutes. Same backend as CLI Browser Sessions / hosted MCP.

## Core flow

1. `browser_navigate` → get `session_id`
2. Inspect with `browser_get_accessibility_tree` / `browser_get_text` /
   `browser_screenshot`
3. Act: `browser_click`, `browser_fill`, `browser_type`, `browser_select_option`,
   `browser_check` / `browser_uncheck`, `browser_press_key`, `browser_scroll`,
   `browser_drag`, …
4. Wait: `browser_wait_for_selector`, `browser_wait_for_navigation`, `browser_wait`
5. Multi-step known sequences: `browser_batch` (actions against an existing
   session — **not** URL Batch / `batch_create`)
6. Always `browser_close` when done

Other useful tools: `browser_evaluate`, cookies (`browser_get_cookies` /
`browser_set_cookies` / `browser_clear_cookies`), `browser_local_storage`,
tabs (`browser_new_tab` / `browser_switch_tab`), `browser_generate_pdf`.

## Rules

- Try [[protected-fetch]] (`scrape`) / [[extract]] first; escalate only with
  evidence — they cost less.
- Pass `session_id` on every call after navigate.
- Prefer `browser_batch` when you already know the full action sequence
  (fewer round trips).
- Always `browser_close` interactive sessions.
- `browser_select_option` matches the option's `value` attribute (bare value
  or a CSS selector like `option[value="2"]`). Label text / index are not
  supported.
- Do not use CLI `zenrows browser` as the primary path when MCP `browser_*`
  tools are available.
