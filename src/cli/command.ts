/**
 * Command contract + shared helpers for the CLI.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";

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

/** Thin wrapper around parseArgs that keeps positionals + options typed-ish. */
export function parse(
  argv: string[],
  options: ParseArgsConfig["options"],
): { values: Record<string, unknown>; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: false,
  });
  return { values: values as Record<string, unknown>, positionals };
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
