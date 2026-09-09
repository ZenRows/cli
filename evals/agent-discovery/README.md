# Agent discovery eval

Does a coding agent pick the Zenrows CLI after `zenrows init`?

`init` sets up `.zenrows/`, but an agent only reads what its own harness loads.
This eval measures whether a candidate change makes the agent choose the CLI,
and whether it also gives the agent the cost rules it needs to choose well.

The criterion below is fixed **before** any implementation lands, so a change
either clears the bar or does not.

## Metrics

| Metric | Question asked | Counted as a hit when the answer |
| --- | --- | --- |
| `picks CLI` | how would you fetch a Cloudflare-protected page | names the `zenrows` CLI as the first tool |
| `knows cost` | how would you scrape 10000 pages cheaply | cites a real cost rule (the credit multipliers, or `mode=auto`) |

`knows cost` matters because an agent that finds the CLI and then enables both
`--js-render` and `--premium-proxy` puts the caller on 25 credits per request.
Discovery without cost awareness is not a win.

## Arms

Every arm except `control` runs a real `zenrows init --all` first, so the arms
differ only in the wiring under test.

| Arm | Contents |
| --- | --- |
| `control` | empty directory. What the agent reaches for with no Zenrows at all |
| `init` | `init` as it ships today. The baseline |
| `pointer` | plus a Zenrows block in `CLAUDE.md` |
| `skill` | plus the shipped skills copied to `.claude/skills/` |

## Pass criterion

A change ships when, over at least 8 runs per arm:

- its arm scores **6/8 or better** on `picks CLI`, and
- the `init` baseline stays at **2/8 or worse**, which proves the arm caused it, and
- its arm scores **no worse than the baseline** on `knows cost`.

An arm that wins on discovery and loses on cost awareness does not pass.

## Running it

The result is only meaningful in a clean environment, so the harness aborts if
it finds agent config, plugins, MCP servers, or a `zenrows` binary already
present. Never run it on a workstation.

```bash
docker build -t zenrows-agent-discovery evals/agent-discovery
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" zenrows-agent-discovery
```

An org-scoped key also needs the workspace named, or every call returns 400:

```bash
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e ANTHROPIC_CUSTOM_HEADERS="anthropic-workspace-id: wrkspc_..." \
  zenrows-agent-discovery
```

Test an unreleased build by pointing at a local tarball:

```bash
npm pack && docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e CLI_SPEC=/w/zenrows-cli-x.y.z.tgz -v "$PWD:/w:ro" zenrows-agent-discovery
```

`RUNS` sets the sample size per arm, `ARMS` selects which arms to run.

## Reading the result

Agent answers vary between runs, so a single run of an arm proves nothing. The
harness prints every raw answer under the table. Read them before trusting the
count: the regexes classify text, and text can be classified wrongly.

This eval is not part of `zenrows eval run`. That runner executes API steps and
needs no model. This one drives a coding agent and needs an Anthropic API key.
