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

### From npm (`@zenrows/cli` ≥ 1.2.1)

```bash
npm install @zenrows/cli
PLUGIN=node_modules/@zenrows/cli/agent-plugin

# Cursor local plugins (copy — prefer over symlink):
mkdir -p ~/.cursor/plugins/local
rm -rf ~/.cursor/plugins/local/zenrows
cp -R "$PLUGIN" ~/.cursor/plugins/local/zenrows
```

Or point any Agent Plugins–compatible client at that `agent-plugin` folder
(global install: `$(npm root -g)/@zenrows/cli/agent-plugin`).

### From git

Clone [`zenrows/cli`](https://github.com/zenrows/cli) and use the repo-root `agent-plugin/` folder the same way.

Clients discover:

- `plugin.json` — manifest
- `mcp.json` — MCP servers (no secrets)
- `skills/*/SKILL.md` — playbooks

**Note:** `zenrows plugin install <client>` installs **CLI registry skills** into `.zenrows/skills/` and prints an MCP snippet. That is **not** the same as copying this Agent Plugins 1.0 folder.

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

## Local MCP testing

Published `@zenrows/mcp` already includes extract / batch / auto-signup. For a local MCP build:

```bash
cd /path/to/zenrows-mcp
npm run build
ZENROWS_API_KEY=… node dist/index.js   # or omit key to exercise auto-signup
```

Do **not** commit a D2-style override into this package’s `mcp.json` — shipped defaults stay `npx @zenrows/mcp` + `https://mcp.zenrows.com/mcp`.

## Related

- CLI product + installable CLI skills: repo root `skills/`
- MCP runtime: [`@zenrows/mcp`](https://www.npmjs.com/package/@zenrows/mcp)
- Spec: [Agent Plugins 1.0](https://agent-plugins.org/)
