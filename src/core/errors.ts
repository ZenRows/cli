/**
 * Normalized, agent-actionable errors.
 *
 * Every error carries a stable `code`, a human `message`, the `likely_cause`,
 * a `next_action`, and optional `suggested_commands`. Agents (and humans) can
 * react to the code and follow the suggested command without guessing.
 */
import { DASHBOARD_URL } from "./open-url.ts";

export type ErrorCode =
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "BACKEND_UNAVAILABLE"
  | "CAPABILITY_UNAVAILABLE"
  | "PARAM_CONFLICT_AUTO_MANUAL"
  | "PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM"
  | "POLICY_BLOCKED_DOMAIN"
  | "POLICY_MAX_CREDITS_EXCEEDED"
  | "POLICY_LIMIT_EXCEEDED"
  | "POLICY_EXPERIMENTAL_DISABLED"
  | "POLICY_BROWSER_DISABLED"
  | "SIGNUP_RATE_LIMITED"
  | "DOMAIN_FORBIDDEN"
  | "FETCH_FAILED"
  | "FETCH_EMPTY_RESPONSE"
  | "EXTRACT_FAILED"
  | "EXTRACT_DOMAIN_NOT_ENABLED"
  | "EXTRACT_VALIDATION_FAILED"
  | "BROWSER_UNAVAILABLE"
  | "BATCH_ACCESS_DENIED"
  | "BATCH_QUOTA_EXCEEDED"
  | "BATCH_NOT_FOUND"
  | "BATCH_FAILED"
  | "PLUGIN_UNSUPPORTED"
  | "MCP_CLIENT_UNSUPPORTED"
  | "ASSET_NOT_FOUND"
  | "ASSET_REQUIRES_CAPABILITY"
  | "EVAL_REQUIRES_CAPABILITY"
  | "INVALID_USAGE";

export interface ToolkitErrorShape {
  code: ErrorCode;
  message: string;
  likely_cause: string;
  next_action: string;
  suggested_commands?: string[];
}

export class ToolkitError extends Error {
  readonly code: ErrorCode;
  readonly likely_cause: string;
  readonly next_action: string;
  readonly suggested_commands: string[];

  constructor(shape: ToolkitErrorShape) {
    super(shape.message);
    this.name = "ToolkitError";
    this.code = shape.code;
    this.likely_cause = shape.likely_cause;
    this.next_action = shape.next_action;
    this.suggested_commands = shape.suggested_commands ?? [];
  }

  toJSON(): ToolkitErrorShape {
    return {
      code: this.code,
      message: this.message,
      likely_cause: this.likely_cause,
      next_action: this.next_action,
      suggested_commands: this.suggested_commands,
    };
  }
}

/**
 * Build the canonical "quota / credits exhausted" error.
 *
 * For an UNCLAIMED auto-provisioned account the actionable step is to claim it
 * (so `claimUrl` is surfaced); for a real logged-in account there is nothing to
 * claim — the step is to add credits / upgrade in the dashboard. `status`/`detail`
 * let the caller record the actual upstream response (402 usage-limit, 429
 * quota, …) instead of a hardcoded status.
 */
export function quotaExhausted(
  url: string,
  claimUrl?: string,
  opts: { status?: number; detail?: string } = {},
): ToolkitError {
  const claimLine = claimUrl
    ? `You are on the Zenrows Free plan. Claim your account to keep your usage and add credits: ${claimUrl}`
    : `You are out of Zenrows credits. Add credits or upgrade your plan: ${DASHBOARD_URL}`;
  const detail = opts.detail ? `${opts.detail.replace(/\.\s*$/, "")}. ` : "";
  return new ToolkitError({
    code: "POLICY_MAX_CREDITS_EXCEEDED",
    message: "Zenrows request quota exhausted.",
    likely_cause: `${detail}HTTP ${opts.status ?? 429} for ${url}`,
    next_action: claimLine,
    suggested_commands: claimUrl ? [] : ["zenrows usage"],
  });
}

/** Build the canonical "this capability is not configured" error. */
export function capabilityUnavailable(
  capabilityLabel: string,
  command: string,
  suggested: string[],
): ToolkitError {
  return new ToolkitError({
    code: "CAPABILITY_UNAVAILABLE",
    message: `${capabilityLabel} is not configured for this backend yet.`,
    likely_cause: `The cloud primitive behind \`${command}\` is not enabled for this account or has not shipped.`,
    next_action:
      "Use a local spec / validation path, or escalate to a confirmed primitive (Protected Fetch / Extract).",
    suggested_commands: suggested,
  });
}
