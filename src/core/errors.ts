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
  | "EXTRACT_DOMAIN_NOT_PREPARED"
  | "EXTRACT_PAGE_NOT_RECOGNISED"
  | "EXTRACT_DOMAIN_NOT_ENABLED"
  | "EXTRACT_VALIDATION_FAILED"
  | "EXTRACT_PREPARE_INVALID"
  | "EXTRACT_PREPARE_NOT_FOUND"
  | "EXTRACT_PREPARE_IN_PROGRESS"
  | "EXTRACT_PREPARE_OUT_OF_ALLOWANCE"
  | "EXTRACT_PREPARE_UNAVAILABLE"
  | "EXTRACT_PREPARE_FAILED"
  | "EXTRACT_PREPARE_TIMEOUT"
  | "BROWSER_UNAVAILABLE"
  | "BATCH_ACCESS_DENIED"
  | "BATCH_QUOTA_EXCEEDED"
  | "BATCH_NOT_FOUND"
  | "BATCH_FAILED"
  | "BATCH_RUN_IN_PROGRESS"
  | "BATCH_RUN_ENDED"
  | "BATCH_NO_MATCHING_TASKS"
  | "BATCH_RERUN_WINDOW_EXPIRED"
  | "BATCH_REQUEST_IN_FLIGHT"
  | "BATCH_CONFLICT"
  | "BATCH_TASK_NOT_READY"
  | "BATCH_TASK_FAILED"
  | "BATCH_RESULT_EXPIRED"
  | "CRAWL_NOT_ENABLED"
  | "CRAWL_INSUFFICIENT_CREDITS"
  | "CRAWL_KEY_CAP_REACHED"
  | "CRAWL_TOO_MANY_CRAWLS"
  | "CRAWL_RATE_LIMITED"
  | "CRAWL_NOT_FOUND"
  | "CRAWL_CONTENT_NOT_FOUND"
  | "CRAWL_INVALID_REQUEST"
  | "CRAWL_REQUEST_IN_FLIGHT"
  | "CRAWL_BUSY"
  | "CRAWL_FAILED"
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
  /** The API's own `code`, when the error came from an API answer that had one. */
  server_code?: string;
  /** The crawl the error is about, once it exists. */
  crawl_id?: string;
  /** The Batch job the error is about, once it exists. */
  job_id?: string;
  /**
   * The Idempotency-Key a Batch write was sent with, when its outcome is
   * unknown. Repeating the same request with this key cannot create a duplicate.
   */
  idempotency_key?: string;
  /** Seconds to wait before a retry (the `Retry-After` header). */
  retry_after?: number;
}

export class ToolkitError extends Error {
  readonly code: ErrorCode;
  readonly likely_cause: string;
  readonly next_action: string;
  readonly suggested_commands: string[];
  readonly server_code?: string;
  readonly crawl_id?: string;
  readonly job_id?: string;
  readonly idempotency_key?: string;
  readonly retry_after?: number;

  constructor(shape: ToolkitErrorShape) {
    super(shape.message);
    this.name = "ToolkitError";
    this.code = shape.code;
    this.likely_cause = shape.likely_cause;
    this.next_action = shape.next_action;
    this.suggested_commands = shape.suggested_commands ?? [];
    this.server_code = shape.server_code;
    this.crawl_id = shape.crawl_id;
    this.job_id = shape.job_id;
    this.idempotency_key = shape.idempotency_key;
    this.retry_after = shape.retry_after;
  }

  toJSON(): ToolkitErrorShape {
    return {
      code: this.code,
      message: this.message,
      likely_cause: this.likely_cause,
      next_action: this.next_action,
      suggested_commands: this.suggested_commands,
      ...(this.server_code ? { server_code: this.server_code } : {}),
      ...(this.crawl_id ? { crawl_id: this.crawl_id } : {}),
      ...(this.job_id ? { job_id: this.job_id } : {}),
      ...(this.idempotency_key ? { idempotency_key: this.idempotency_key } : {}),
      ...(this.retry_after !== undefined ? { retry_after: this.retry_after } : {}),
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
 * quota, …) instead of a hardcoded status. `status: null` is for a crawl the
 * credits stopped: its status call succeeded, so there is no HTTP error to cite,
 * only `url` (the crawl).
 */
export function quotaExhausted(
  url: string,
  claim?: ClaimHint,
  opts: { status?: number | null; detail?: string } = {},
): ToolkitError {
  const detail = opts.detail ? `${opts.detail.replace(/\.\s*$/, "")}. ` : "";
  const where = opts.status === null ? `Stopped ${url}` : `HTTP ${opts.status ?? 429} for ${url}`;
  return new ToolkitError({
    code: "POLICY_MAX_CREDITS_EXCEEDED",
    message: "Zenrows request quota exhausted.",
    likely_cause: `${detail}${where}`,
    next_action: quotaNextAction(claim),
    suggested_commands: ["zenrows usage"],
  });
}

/**
 * What the CLI knows about claiming, for an error that has to say it:
 * a claim URL that is still valid; `CLAIM_LINK_REFRESH` when the account is
 * unclaimed but no usable link is held (missing or expired); or `undefined`
 * when there is nothing to claim (claimed, or not an agent-created account).
 */
export type ClaimHint = string | typeof CLAIM_LINK_REFRESH | undefined;
export const CLAIM_LINK_REFRESH = Symbol("claim-link-refresh");

/** Start of `next_action` on a quota error for an unclaimed account. */
export const CLAIM_NEXT_ACTION_PREFIX = "You are on the Zenrows Free plan.";

/** The `next_action` of a quota error for the given claim state. */
export function quotaNextAction(claim: ClaimHint): string {
  // Say that the allowance comes back. Without it this reads as a permanent paywall,
  // which is how the API's own AUTH004 text reads ("Purchase a new subscription to
  // continue") and why exhausted clients retry-loop instead of waiting or upgrading.
  // `zenrows usage` prints the exact `period_ends_at`, so the date is one command away
  // rather than guessed here.
  const renewLine = "Credits renew at the end of the billing period — run `zenrows usage` for the date.";
  if (claim === CLAIM_LINK_REFRESH) {
    return `${CLAIM_NEXT_ACTION_PREFIX} Claim your account to keep your usage and add credits: run \`zenrows account claim\` for a fresh claim link. ${renewLine}`;
  }
  if (claim) {
    return `${CLAIM_NEXT_ACTION_PREFIX} Claim your account to keep your usage and add credits: ${claim}. ${renewLine}`;
  }
  return `You are out of Zenrows credits. ${renewLine} To carry on now, add a credit pack (${BILLING_TOPUP_URL} opens the purchase directly) or upgrade your plan: ${PLANS_URL}`;
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
