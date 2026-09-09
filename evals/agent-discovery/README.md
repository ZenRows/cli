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
| `picks CLI` | how would you fetch a Cloudflare-protected page | reaches for this product, by name or by skill name |
| `grounded` | how would you scrape 10000 pages cheaply | cites something only this product has: `mode=auto`, `zenrows batch`, `zenrows extract`, payload trimming |
| `costly default` | the discovery answer, re-read | reaches for premium proxies or JS rendering **and** never mentions auto mode. **Lower is better** |

`grounded` matters because an agent that finds the CLI and then enables both
`--js-render` and `--premium-proxy` puts the caller on 25 credits per request.
Discovery without cost awareness is not a win.

The marker set is deliberately narrow. An earlier version matched generic words
like "multiplier" and scored the untreated baseline 5/8, while those answers all
began "assuming a commercial scraping API, you didn't say which". Generic advice
that happens to mention cost is not knowledge of this product.

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
- its arm scores **6/8 or better** on `grounded`, and
- its arm scores **no worse than 6/8** on `costly default`.

An arm that wins on discovery and loses on cost awareness does not pass. A
measured example: a four-line pointer in `CLAUDE.md` scored 8/8 on discovery and
0/8 on grounded, and one of its runs recommended enabling JS rendering and
premium proxies together, which is the 25 credit path.

`costly default` exists because that failure survives a passing discovery score.
`js_render` plus `premium_proxy` is 25 credits per request, and `mode=auto` bills
only for the configuration that succeeds, so an agent should never pick that pair
itself. Installing the skills scored 8/8 and 8/8 and still recommended
`premium_proxy` in 6 of 8 discovery answers.

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

The harness aborts rather than reporting a score when the agent cannot
authenticate, when the CLI will not install, or when an arm's `init` produces no
`.zenrows/`. Each of those otherwise scores 0 on every metric and reads exactly
like a real negative result. All three have happened.

`RUNS` sets the sample size per arm, `ARMS` selects which arms to run.

## Reading the result

Agent answers vary between runs, so a single run of an arm proves nothing. The
harness prints every raw answer under the table. Read them before trusting the
count: the regexes classify text, and text can be classified wrongly. This has
already happened three times, in both directions. A loose cost pattern scored an
untreated baseline 5/8. A narrow discovery pattern scored a working build 0/8
because the agent wrote "Zenrows Protected Fetch" instead of the command. And
counting any mention of premium proxies scored a correct answer as costly, when
what it actually said was "no JS rendering or premium proxies on the first
attempt".

This eval is not part of `zenrows eval run`. That runner executes API steps and
needs no model. This one drives a coding agent and needs an Anthropic API key.
