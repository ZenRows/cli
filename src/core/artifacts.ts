/**
 * Run artifacts: every `fetch`/`extract` invocation writes a normalized,
 * secret-free record under `.zenrows/runs/<run-id>/` plus a trace under
 * `.zenrows/traces/<run-id>/` so `zenrows trace` can explain it later.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { redactObject } from "./redact.ts";
import { findWorkspace, workspacePaths } from "./workspace.ts";

export interface RunMeta {
  runId: string;
  command: string;
  capability: string;
  url?: string;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "error";
  /** Sanitized request parameters (never includes apikey). */
  request: Record<string, unknown>;
  /** Summary of the result or the normalized error. */
  result?: Record<string, unknown>;
  error?: unknown;
  costUsd?: number | null;
  requestId?: string | null;
}

export function newRunId(): string {
  // Sortable-ish, human-recognizable: r-<short uuid>.
  return `r-${randomUUID().slice(0, 8)}`;
}

function runsDir(projectRoot?: string): { runs: string; traces: string } | null {
  const ws = projectRoot ? workspacePaths(projectRoot) : findWorkspace();
  if (!ws) return null;
  return { runs: join(ws.dir, "runs"), traces: join(ws.dir, "traces") };
}

/**
 * Persist a run record + trace. Returns the run directory, or null if there is
 * no workspace (e.g. a one-off `fetch` outside an initialized project).
 */
export function writeRun(meta: RunMeta, rawArtifacts: Record<string, string> = {}, projectRoot?: string): string | null {
  const dirs = runsDir(projectRoot);
  if (!dirs) return null;
  const runDir = join(dirs.runs, meta.runId);
  const traceDir = join(dirs.traces, meta.runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(traceDir, { recursive: true });

  // Redact defensively — meta should already be secret-free.
  const safeMeta = redactObject(meta);
  writeFileSync(join(runDir, "run.json"), JSON.stringify(safeMeta, null, 2) + "\n");
  writeFileSync(join(traceDir, "trace.json"), JSON.stringify(safeMeta, null, 2) + "\n");

  for (const [name, content] of Object.entries(rawArtifacts)) {
    writeFileSync(join(runDir, name), content);
  }
  return runDir;
}
