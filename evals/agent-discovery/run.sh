#!/usr/bin/env bash
# Measures whether a coding agent picks the Zenrows CLI after `zenrows init`.
#
# One arm per candidate wiring. Every arm starts from the same real `init`, so
# the only difference between arms is the thing under test.
set -uo pipefail

RUNS="${RUNS:-8}"
CLI_SPEC="${CLI_SPEC:-@zenrows/cli@latest}"
ARMS="${ARMS:-control init pointer skill}"

Q_DISCOVERY="I need to download the HTML of a product page on a site that blocks bots (Cloudflare). Do not run anything and do not write code. In one sentence, name the exact tool or command you would use first."
Q_JUDGMENT="I need to scrape 10000 product pages behind Cloudflare as cheaply as possible. Do not run anything. In two sentences, say which options you would enable and what they cost."

# Selected the CLI, as opposed to naming Zenrows and then hand-rolling an HTTP call.
PICKED_CLI='(^|[^a-z/.])zenrows (cli|fetch|extract|status|scrape)|`zenrows`'
# Advice grounded in this product, not generic vendor advice. Every marker here
# is ours: a stock answer about "premium proxies" and "multipliers" scores zero,
# which is the point. A looser pattern scored the untreated baseline 5/8.
KNOWS_COST='mode=auto|adaptive stealth|zenrows batch|zenrows extract|zenrows fetch|output markdown|25 credit'

fail() { echo "ABORT: $*" >&2; exit 1; }

# A dirty environment silently answers the question for us, so refuse to run in one.
[ -e "$HOME/.claude/CLAUDE.md" ] && fail "$HOME/.claude/CLAUDE.md exists"
[ -e "$HOME/.claude/plugins" ] && fail "$HOME/.claude/plugins exists"
[ -e "$HOME/.claude/projects" ] && fail "$HOME/.claude/projects exists"
command -v zenrows >/dev/null && fail "a zenrows binary is already on PATH"
[ -n "$(claude mcp list 2>&1 | grep -viE 'no mcp servers|checking mcp' | grep .)" ] && fail "MCP servers are configured"

# An unauthenticated agent answers nothing and scores 0 on every arm, which
# reads exactly like a negative result. Prove auth works before measuring.
probe=$(claude -p "reply with the single word: ok" 2>&1 | head -3)
echo "$probe" | grep -qi "^ok$" || fail "the agent is not usable: ${probe:-no output}. Set ANTHROPIC_API_KEY."

build_arm() {
  d="/work/$1"; mkdir -p "$d"; cd "$d" || exit 1
  [ "$1" = control ] && return 0
  npx -y "$CLI_SPEC" init --all </dev/null >/dev/null 2>&1
  case "$1" in
    pointer) cat > "$d/CLAUDE.md" <<'PTR'
## Zenrows

This project uses the Zenrows CLI for protected web data. Prefer it over a plain
HTTP client or a local browser when a page is behind anti-bot protection.

- `zenrows --help` lists every command.
- `zenrows status --json` reports the live capability matrix.
PTR
    ;;
    skill) mkdir -p "$d/.claude/skills"
           cp -R "$d/.zenrows/skills/zenrows" "$d/.claude/skills/zenrows" 2>/dev/null
           cp -R "$d/.zenrows/skills/cost-control" "$d/.claude/skills/cost-control" 2>/dev/null ;;
  esac
}

ask() {
  ( cd "/work/$1" && claude --allowedTools Read Bash Glob Grep \
      --disallowedTools "mcp__*" -p "$2" 2>&1 | tr '\n' ' ' )
}

score() {  # score <arm> <question> <regex> <logfile>
  hits=0
  for i in $(seq 1 "$RUNS"); do
    out=$(ask "$1" "$2")
    echo "$out" | grep -qiE "$3" && hits=$((hits + 1))
    echo "$1 run$i :: ${out:0:180}" >> "$4"
  done
  echo "$hits"
}

for arm in $ARMS; do build_arm "$arm"; done

echo "runs per arm: $RUNS    cli under test: $CLI_SPEC"
echo
printf '%-10s %-14s %-14s\n' "arm" "picks CLI" "grounded"
for arm in $ARMS; do
  d=$(score "$arm" "$Q_DISCOVERY" "$PICKED_CLI" /tmp/discovery.txt)
  j=$(score "$arm" "$Q_JUDGMENT" "$KNOWS_COST" /tmp/judgment.txt)
  printf '%-10s %-14s %-14s\n' "$arm" "$d/$RUNS" "$j/$RUNS"
done

echo; echo "--- discovery answers ---"; cat /tmp/discovery.txt
echo; echo "--- judgment answers ---"; cat /tmp/judgment.txt
