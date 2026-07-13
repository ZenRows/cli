/**
 * Tiny logger with secret redaction. No dependencies.
 *
 * Human output goes to stderr so that stdout can carry machine-readable
 * payloads (e.g. `--json`) cleanly.
 */
import { redact } from "./redact.ts";

let knownSecrets: string[] = [];

export function registerSecret(secret: string | undefined): void {
  if (secret && !knownSecrets.includes(secret)) knownSecrets.push(secret);
}

function clean(msg: string): string {
  return redact(msg, knownSecrets);
}

const ANSI = {
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

const useColor = process.stderr.isTTY && process.env.NO_COLOR === undefined;
function c(code: string, s: string): string {
  return useColor ? `${code}${s}${ANSI.reset}` : s;
}

export const log = {
  info(msg: string): void {
    process.stderr.write(clean(msg) + "\n");
  },
  step(msg: string): void {
    process.stderr.write(c(ANSI.cyan, "→ ") + clean(msg) + "\n");
  },
  success(msg: string): void {
    process.stderr.write(c(ANSI.green, "✓ ") + clean(msg) + "\n");
  },
  warn(msg: string): void {
    process.stderr.write(c(ANSI.yellow, "! ") + clean(msg) + "\n");
  },
  error(msg: string): void {
    process.stderr.write(c(ANSI.red, "✗ ") + clean(msg) + "\n");
  },
  dim(msg: string): void {
    process.stderr.write(c(ANSI.dim, clean(msg)) + "\n");
  },
  /** Machine-readable payload to stdout. */
  out(text: string): void {
    process.stdout.write(text + "\n");
  },
};

export { ANSI, c };
