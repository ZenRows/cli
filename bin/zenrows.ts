#!/usr/bin/env node
/**
 * `zenrows` executable. Thin shell around the CLI router so the heavy logic
 * stays testable in src/.
 */
import { main } from "../src/cli/index.ts";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
