# Skill behaviour check

A manual pre-release check for changes under `skills/`.

Skills are prose we ship into other people's agents. No unit test can tell you
that prose still steers an agent the way you meant, and a skill that reads well
can still cost customers money: one version scored 8/8 on being chosen and still
told the agent to enable JS rendering and premium proxies in 7 of 8 answers,
which is the most expensive configuration the API offers.

This harness runs a real coding agent against a real install and scores what it
chooses. Run it when you change a skill, and compare against the previous build.

**It is not a CI gate.** It needs an API key, a container, and about ten minutes,
and eight runs of a language model is a smoke test with opinions, not a
statistical result. Treat a difference of one or two runs as noise. Treat 7/8
against 0/8 as real.

It also answers a second question, once: whether a given wiring makes an agent
aware of the CLI at all. That is what the `control` and `init` arms are for.

## Metrics

| Metric | Question asked | Counted as a hit when the answer |
| --- | --- | --- |
| `picks CLI` | how would you fetch a Cloudflare-protected page | reaches for this product, by name or by skill name |
| `grounded` | how would you scrape 10000 pages cheaply | cites something only this product has: `mode=auto`, `zenrows batch`, `zenrows extract`, payload trimming |
| `costly default` | the discovery answer, re-read | reaches for premium proxies or JS rendering **and** never mentions auto mode. **Lower is better** |

`grounded` matters because an agent that finds the CLI and then enables both
`--js-render` and `--premium-proxy` puts the caller on the most expensive
configuration available.
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
| `skill` | plus the shipped skills copied to `.claude/skills/` |

## Pass criterion

A change ships when, over at least 8 runs per arm:

- its arm scores **6/8 or better** on `picks CLI`, and
- the `init` baseline stays at **2/8 or worse**, which proves the arm caused it, and
- its arm scores **6/8 or better** on `grounded`, and
- its arm scores **no worse than 6/8** on `costly default`.

An arm that wins on discovery and loses on cost awareness does not pass. A
rejected candidate makes the point: a four-line note in `CLAUDE.md` naming the
CLI scored 8/8 on discovery and 0/8 on grounded, and one of its runs recommended
enabling JS rendering and premium proxies together, the most expensive path. It
found the tool and then used it badly.

`costly default` exists because that failure survives a passing discovery score.
`js_render` plus `premium_proxy` is the costliest pair, and `mode=auto` bills
only for the configuration that succeeds, so an agent should never pick that pair
itself. Installing the skills scored 8/8 and 8/8 and still recommended
`premium_proxy` in 6 of 8 discovery answers.

## Running it

Run it before releasing a skill change, against the build you are about to ship,
and compare with the build you shipped last.

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
