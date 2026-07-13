import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a throwaway project root for workspace-scoped tests. */
export function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "zr-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
