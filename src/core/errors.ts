/**
 * Normalized, agent-actionable errors.
 *
 * Every error carries a stable `code`, a human `message`, the `likely_cause`,
 * a `next_action`, and optional `suggested_commands`. Agents (and humans) can
 * react to the code and follow the suggested command without guessing.
 */
import { BILLING_TOPUP_URL, PLANS_URL } from "./open-url.ts";

export type ErrorCode =
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "BACKEND_UNAVAILABLE"
  | "REQUEST_TIMEOUT"
  | "CAPABILITY_UNAVAILABLE"
  | "PARAM_CONFLICT_AUTO_MANUAL"
  | "PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM"
  | "POLICY_BLOCKED_DOMAIN"
  | "POLICY_MAX_CREDITS_EXCEEDED"
  | "KEY_CREDIT_CAP_REACHED"
  | "POLICY_LIMIT_EXCEEDED"
  | "POLICY_EXPERIMENTAL_DISABLED"
  | "POLICY_BROWSER_DISABLED"
  | "SIGNUP_RATE_LIMITED"
  | "SIGNUP_FAILED"
  | "UNKNOWN_FLAG"
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
  // Say that the allowance comes back. Without it this reads as a permanent paywall,
  // which is how the API's own AUTH004 text reads ("Purchase a new subscription to
  // continue") and why exhausted clients retry-loop instead of waiting or upgrading —
  // one account spent seven days at ~3 req/s against this wall. `zenrows usage` prints
  // the exact `period_ends_at`, so the date is one command away rather than guessed here.
  const renewLine = "Credits renew at the end of the billing period — run `zenrows usage` for the date.";
  const claimLine = claimUrl
    ? `You are on the Zenrows Free plan. Claim your account to keep your usage and add credits: ${claimUrl}. ${renewLine}`
    : `You are out of Zenrows credits. ${renewLine} To carry on now, add a credit pack (${BILLING_TOPUP_URL} opens the purchase directly) or upgrade your plan: ${PLANS_URL}`;
  const detail = opts.detail ? `${opts.detail.replace(/\.\s*$/, "")}. ` : "";
  return new ToolkitError({
    code: "POLICY_MAX_CREDITS_EXCEEDED",
    message: "Zenrows request quota exhausted.",
    likely_cause: `${detail}HTTP ${opts.status ?? 429} for ${url}`,
    next_action: claimLine,
    suggested_commands: ["zenrows usage"],
  });
}

/** Where an account manages its API keys and their credit caps. */
export const API_KEYS_SETTINGS_URL = "https://app.zenrows.com/settings/api-keys";

/**
 * True when a 402 is a per-key credit cap (gateway AUTH014, Batch
 * `api_key_cap_reached`), not an account out of credits. The account still has
 * credits, so the out-of-credits advice (top up, upgrade, claim) is wrong here.
 */
export function isKeyCapReached(code?: string, body?: string): boolean {
  if (code === "AUTH014" || code === "api_key_cap_reached") return true;
  return !!body && /\b(AUTH014|api_key_cap_reached)\b/.test(body);
}

/**
 * The error for a request refused because this API key reached one of its credit
 * caps. `opts.status: null` is for a Batch run the cap stopped: the run's status
 * call succeeded, so there is no HTTP 402 to cite, only `url` (the job).
 */
export function keyCapReached(url: string, opts: { status?: number | null; detail?: string } = {}): ToolkitError {
  const detail = opts.detail ? `${opts.detail.replace(/\.\s*$/, "")}. ` : "";
  const where = opts.status === null ? `Stopped ${url}` : `HTTP ${opts.status ?? 402} for ${url}`;
  return new ToolkitError({
    code: "KEY_CREDIT_CAP_REACHED",
    message: "This API key reached one of its credit caps.",
    likely_cause: `${detail}${where}`,
    next_action: `The account still has credits and its other API keys keep working. Wait for the cap to reset (\`zenrows usage\` shows when), or raise or remove this key's cap at ${API_KEYS_SETTINGS_URL}.`,
    suggested_commands: ["zenrows usage"],
  });
}
