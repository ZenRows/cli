/**
 * Capability matrix loader + guard.
 *
 * Source of truth is `registry/capabilities.json`. Every command consults the
 * matrix before attempting a cloud call so the toolkit never fakes behavior
 * for primitives the backend does not expose.
 */
import { readFileSync } from "node:fs";
import type { Capability, CapabilityStatus } from "../types/index.ts";
import { ToolkitError } from "./errors.ts";
import { pkgPath } from "./paths.ts";

let cache: Record<string, Capability> | null = null;

export function loadCapabilities(): Record<string, Capability> {
  if (cache) return cache;
  const raw = readFileSync(pkgPath("registry", "capabilities.json"), "utf8");
  const parsed = JSON.parse(raw) as { capabilities: Record<string, Capability> };
  cache = parsed.capabilities;
  return cache;
}

export function getCapability(key: string): Capability | undefined {
  return loadCapabilities()[key];
}

/** Statuses that allow a real cloud call to proceed. */
const USABLE: ReadonlySet<CapabilityStatus> = new Set<CapabilityStatus>([
  "available",
  "available-but-needs-confirmation",
  // Open beta: any key can call; product-specific limits (e.g. Extract domain
  // coverage, Batch 403) are handled by the adapters / API errors, not here.
  "beta",
]);

export function isUsable(key: string): boolean {
  const cap = getCapability(key);
  return cap ? USABLE.has(cap.status) : false;
}

/**
 * Throw CAPABILITY_UNAVAILABLE for a primitive that is planned / experimental
 * / not-implemented, with actionable guidance. `experimental` capabilities are
 * NOT thrown here — they are allowed once policy permits (see policy.ts).
 */
export function assertUsable(key: string, suggested: string[] = []): Capability {
  const cap = getCapability(key);
  if (!cap) {
    throw new ToolkitError({
      code: "CAPABILITY_UNAVAILABLE",
      message: `Unknown capability "${key}".`,
      likely_cause: "The capability key is missing from registry/capabilities.json.",
      next_action: "Check `zenrows status` for the supported capability list.",
      suggested_commands: ["zenrows status"],
    });
  }
  if (USABLE.has(cap.status) || cap.status === "experimental") return cap;
  throw new ToolkitError({
    code: "CAPABILITY_UNAVAILABLE",
    message: `${cap.label} is not configured for this backend yet.`,
    likely_cause: `${cap.backend} — status is "${cap.status}". ${cap.notes ?? ""}`.trim(),
    next_action:
      "Use the local spec / validation path for this command, or escalate to a confirmed primitive (Protected Fetch / Extract).",
    suggested_commands: suggested,
  });
}
