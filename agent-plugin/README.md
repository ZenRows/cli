# Zenrows Agent Plugin

Agent Plugins 1.0 package for [Zenrows](https://www.zenrows.com) — MCP servers + skills that teach agents to pick the cheapest reliable primitive for protected web data.

```text
agent-plugin/
├── plugin.json
├── mcp.json
├── README.md
└── skills/
    ├── zenrows/
    ├── cost-control/
    ├── protected-fetch/
    ├── extract/
    ├── batch-jobs/
    └── interact-browser/
```

## Install

Point your Agent Plugins–compatible client at this folder (or the `agent-plugin/` path in [`zenrows/cli`](https://github.com/zenrows/cli)).

Clients discover:

- `plugin.json` — manifest
- `mcp.json` — MCP servers (no secrets)
- `skills/*/SKILL.md` — playbooks

## MCP servers (`mcp.json`)

| Server | Transport | How auth works |
| --- | --- | --- |
| `zenrows` | stdio (`npx -y @zenrows/mcp`) | No key in the plugin. On first use the MCP server auto-provisions a Free plan account (unless disabled). Surface the claim URL when quota nears. |
| `zenrows-remote` | streamable-http `https://mcp.zenrows.com/mcp` | Client OAuth (Login or Create Free). No Bearer/API key in the plugin package. |

This package never embeds API keys. Secrets stay in the client / local MCP runtime.

## Skills (MCP-native)

Use MCP tool names — not CLI `zenrows fetch`:

| Skill | Primary tools |
| --- | --- |
| `zenrows` | Decision tree across all primitives |
| `protected-fetch` | `scrape` |
| `extract` | `extract` (fallback: `scrape` + autoparse / css_extractor) |
| `batch-jobs` | `batch_create`, `batch_status`, `batch_results`, `batch_cancel` |
| `interact-browser` | `browser_*` (escalation only) |
| `cost-control` | Cost multipliers + escalate-with-evidence |

## Local MCP testing (before npm publish)

Until `@zenrows/mcp` with extract/batch/auto-signup is published, point stdio at a local build:

```bash
cd /path/to/zenrows-mcp
npm run build
# Inspector UI:
npm run inspect
# Or stdio with an existing key:
ZENROWS_API_KEY=… node dist/index.js
# Or local Streamable HTTP (Bearer still required — no anonymous remote signup):
ZENROWS_API_KEY=… npm run dev:http
```

In a client `mcp.json` / Cursor config, use:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/zenrows-mcp/dist/index.js"],
  "env": { "ZENROWS_API_KEY": "YOUR_KEY" }
}
```

Omit `ZENROWS_API_KEY` to exercise stdio auto-signup into `~/.zenrows/`.

## Related

- CLI product + installable CLI skills: repo root `skills/`
- MCP runtime: [`@zenrows/mcp`](https://www.npmjs.com/package/@zenrows/mcp)
- Spec: [Agent Plugins 1.0](https://agent-plugins.org/)
