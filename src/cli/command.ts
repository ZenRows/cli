/**
 * Command contract + shared helpers for the CLI.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";
import { ToolkitError } from "../core/errors.ts";

/** Global flags stripped by the top-level router before a command parses. */
const GLOBAL_FLAGS = new Set(["json", "yes", "help", "version"]);

export interface Command {
  name: string;
  summary: string;
  /** One-line usage, e.g. "zenrows fetch <url> [flags]". */
  usage: string;
  /** Long help body (printed under usage). */
  help?: string;
  /** Run the command. argv excludes the command name. Returns an exit code. */
  run(argv: string[], ctx: RunContext): Promise<number> | number;
}

export interface RunContext {
  /** Global --json flag (machine-readable output). */
  json: boolean;
  /** Global --yes flag (skip confirmations). */
  yes: boolean;
}

/**
 * Thin wrapper around parseArgs that keeps positionals + options typed-ish.
 *
 * Rejects unrecognized flags loudly (UNKNOWN_FLAG) instead of silently swallowing
 * them: an agent that mistypes or hallucinates a flag must fail here, not get a
 * green result on a request the CLI never actually honored. We parse non-strict
 * with tokens so we can name the exact offending flag and suggest a correction,
 * rather than surface node's raw parseArgs throw.
 */
export function parse(
  argv: string[],
  options: ParseArgsConfig["options"],
): { values: Record<string, unknown>; positionals: string[] } {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const declared = new Set(Object.keys(options ?? {}));
  const unknown = tokens.filter(
    (t): t is Extract<typeof t, { kind: "option" }> =>
      t.kind === "option" && !declared.has(t.name) && !GLOBAL_FLAGS.has(t.name),
  );
  if (unknown.length > 0) {
    const flag = unknown[0]!.rawName;
    const guess = suggestFlag(unknown[0]!.name, [...declared]);
    throw new ToolkitError({
      code: "UNKNOWN_FLAG",
      message: `Unknown flag: ${flag}`,
      likely_cause: "This flag is not recognized by this command.",
      next_action: guess
        ? `Did you mean --${guess}? Run the command with --help for the full flag list.`
        : "Run the command with --help for the full flag list.",
    });
  }
  return { values: values as Record<string, unknown>, positionals };
}

/** Closest declared flag within edit distance 2, for a "did you mean" hint. */
function suggestFlag(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 3;
  for (const c of candidates) {
    const d = editDistance(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
export function asNumber(v: unknown): number | undefined {
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === "number") return v;
  return undefined;
}
export function asBool(v: unknown): boolean {
  return v === true;
}
