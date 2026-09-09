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

# Reached for this product at all. Match the product and the skill names, not
# just `zenrows <subcommand>`: agents name the primitive ("Zenrows Protected
# Fetch, via the protected-fetch skill") far more often than the exact command,
# and a narrower pattern scored a working build 0/8.
PICKED_CLI='zenrows|protected-fetch|interact-browser'
# Advice grounded in this product, not generic vendor advice. Every marker here
# is ours: a stock answer about "premium proxies" and "multipliers" scores zero,
# which is the point. A looser pattern scored the untreated baseline 5/8.
KNOWS_COST='mode=auto|adaptive stealth|zenrows batch|zenrows extract|zenrows fetch|output markdown|cost-control'
# Reached for the expensive configuration when nobody asked about cost.
# js_render plus premium_proxy is the costliest pair, and mode=auto exists so
# the agent never has to make that call itself. Lower is better, and this is the
# one metric where a rise is a regression.
#
# Scored as costly only when the answer never mentions auto mode: the good
# answers name premium proxies to rule them out ("no JS rendering or premium
# proxies on the first attempt"), and counting that as a hit punishes exactly
# the behaviour we want.
COSTLY_ESCALATION='premium.prox|--premium-proxy|js.render|--js-render'
CHOSE_AUTO='auto mode|mode=auto|adaptive stealth'

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

# Install the CLI under test after the gate, never before: the gate must see a
# machine with no zenrows on it. A tarball path cannot be run through npx, so
# install for real and let the arms call the binary.
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
npm install -g "$CLI_SPEC" >/tmp/install.log 2>&1 \
  || fail "could not install $CLI_SPEC: $(tail -3 /tmp/install.log)"
command -v zenrows >/dev/null || fail "$CLI_SPEC installed but left no zenrows binary"

build_arm() {
  d="/work/$1"; mkdir -p "$d"; cd "$d" || exit 1
  [ "$1" = control ] && return 0
  zenrows init --all </dev/null >"/tmp/init-$1.log" 2>&1
  # A silent setup failure scores 0 on every metric and reads as a real result.
  [ -d "$d/.zenrows" ] || fail "init produced no .zenrows in arm $1: $(tail -3 "/tmp/init-$1.log")"
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
printf '%-10s %-12s %-12s %s\n' "arm" "picks CLI" "grounded" "costly default (lower is better)"
for arm in $ARMS; do
  d=$(score "$arm" "$Q_DISCOVERY" "$PICKED_CLI" /tmp/discovery.txt)
  j=$(score "$arm" "$Q_JUDGMENT" "$KNOWS_COST" /tmp/judgment.txt)
  # Re-read the discovery answers already on disk rather than paying for the
  # same 8 runs twice: this asks a different question of the same evidence.
  c=$(grep "^$arm run" /tmp/discovery.txt | grep -iE "$COSTLY_ESCALATION" | grep -ivcE "$CHOSE_AUTO")
  printf '%-10s %-12s %-12s %s\n' "$arm" "$d/$RUNS" "$j/$RUNS" "$c/$RUNS"
done

echo; echo "--- discovery answers ---"; cat /tmp/discovery.txt
echo; echo "--- judgment answers ---"; cat /tmp/judgment.txt
