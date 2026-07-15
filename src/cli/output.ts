/**
 * Output helpers: render normalized errors for humans and machines, and a tiny
 * key/value printer used by `status`, `config`, `policy`.
 */
import { statSync, writeFileSync } from "node:fs";
import { ToolkitError, type ToolkitErrorShape } from "../core/errors.ts";
import { ANSI, c, log } from "../core/logger.ts";

/**
 * Write a `--out` file, turning the cryptic fs errors for the two common
 * mistakes into actionable ones: passing a directory (EISDIR) or a path whose
 * parent directory doesn't exist (ENOENT). Everything else propagates.
 */
export function writeOut(filePath: string, data: string | Buffer): void {
  if (statSync(filePath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `--out expects a file path, but '${filePath}' is a directory.`,
      likely_cause: "A directory was passed to --out, which writes to a single file.",
      next_action: "Pass a file path, e.g. --out results.jsonl.",
    });
  }
  try {
    writeFileSync(filePath, data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: `Cannot write --out '${filePath}': the parent directory does not exist.`,
        likely_cause: "A directory in the output path is missing.",
        next_action: "Create the directory first, or choose an existing one.",
      });
    }
    throw err;
  }
}

/** Print a ToolkitError. In --json mode emits the structured shape to stdout. */
export function printError(err: unknown, json = false): void {
  const shape = toShape(err);
  if (json) {
    log.out(JSON.stringify({ ok: false, error: shape }, null, 2));
    return;
  }
  log.error(`[${shape.code}] ${shape.message}`);
  log.dim(`  cause: ${shape.likely_cause}`);
  log.dim(`  next:  ${shape.next_action}`);
  for (const cmd of shape.suggested_commands ?? []) {
    process.stderr.write("  " + c(ANSI.cyan, "$ " + cmd) + "\n");
  }
}

export function toShape(err: unknown): ToolkitErrorShape {
  if (err instanceof ToolkitError) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: "INVALID_USAGE",
    message,
    likely_cause: "Unexpected error.",
    next_action: "Re-run with corrected input; if it persists, report it.",
  };
}

export function kv(label: string, value: string, width = 20): void {
  const pad = label.length >= width ? label : label + " ".repeat(width - label.length);
  log.info(`${c(ANSI.bold, pad)} ${value}`);
}

export function section(title: string): void {
  log.info("");
  log.info(c(ANSI.bold, title));
}
