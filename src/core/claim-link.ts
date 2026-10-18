/**
 * Keeping the stored claim link usable.
 *
 * A claim link expires 30 days after it is issued, and a human may claim the
 * account in the browser at any time without the CLI knowing. This module
 * decides, from `account.json` plus the claim-status and claim-link endpoints,
 * what the CLI should tell the user: a link that still works, "run
 * `zenrows account claim`", or nothing because the account is already claimed.
 */
import type { AgentAccount } from "../types/index.ts";
import { fetchAccountStatus, readAccount, requestClaimLink, writeAccount } from "./agent-account.ts";
import { resolveApiKey } from "./auth.ts";
import { CLAIM_LINK_REFRESH, CLAIM_NEXT_ACTION_PREFIX, ToolkitError, quotaNextAction, type ClaimHint } from "./errors.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The backend's claim-link lifetime. A link this old no longer works. */
export const CLAIM_LINK_TTL_MS = 30 * DAY_MS;
/** Ask for a fresh link once the held one is this old, before it lapses. */
export const CLAIM_LINK_REFRESH_AGE_MS = 25 * DAY_MS;
/** On error paths, check claim status at most this often. */
export const CLAIM_CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;
/** Each claim request gives up after this long, so an error is never held up for long. */
const CLAIM_REQUEST_TIMEOUT_MS = 5000;

/** Only an https link on zenrows.com (or a subdomain) is shown or opened. */
export function isTrustedClaimUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && (host === "zenrows.com" || host.endsWith(".zenrows.com"));
  } catch {
    return false;
  }
}

/** Age of the held link in ms, or Infinity when its issue time is unknown. */
function linkAgeMs(acct: AgentAccount, now: Date): number {
  const issued = new Date(acct.claimUrlIssuedAt ?? acct.createdAt).getTime();
  return Number.isNaN(issued) ? Infinity : now.getTime() - issued;
}

/** The held link if it is trusted and not yet expired, else undefined. No network. */
export function usableClaimUrl(acct: AgentAccount, now: Date = new Date()): string | undefined {
  if (!isTrustedClaimUrl(acct.claimUrl)) return undefined;
  return linkAgeMs(acct, now) < CLAIM_LINK_TTL_MS ? acct.claimUrl : undefined;
}

/** The claim hint for an error from local state alone. No network. */
export function storedClaimHint(acct: AgentAccount | null, now: Date = new Date()): ClaimHint {
  if (!acct?.unclaimed) return undefined;
  return usableClaimUrl(acct, now) ?? CLAIM_LINK_REFRESH;
}

export type ClaimState =
  | { status: "none" }
  | { status: "claimed" }
  | { status: "unclaimed"; claimUrl?: string; refreshed: boolean };

export interface RefreshOptions {
  projectRoot?: string;
  apiKey?: string;
  /** Skip the error-path throttle (an explicit `zenrows account claim`). */
  force?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Endpoint overrides (tests). Default: derived from the signup URL. */
  accountUrl?: string;
  claimUrl?: string;
}

/**
 * Bring the stored claim state up to date, as far as the network allows, and
 * report it. Steps: ask whether the account was claimed; if not, and the held
 * link is missing, untrusted or 25+ days old, mint a fresh one and store it.
 * Network failures are swallowed: the held link is still offered while it is
 * under 30 days old. Unless `force` is set, the network is skipped entirely
 * when the last check was under 6 hours ago. Throws only for a forced call
 * whose fresh-link request failed with no usable link to fall back on.
 */
export async function refreshClaimState(opts: RefreshOptions = {}): Promise<ClaimState> {
  const { projectRoot } = opts;
  const now = opts.now ?? new Date();
  let acct = readAccount(projectRoot);
  if (!acct) return { status: "none" };
  if (!acct.unclaimed) return { status: "claimed" };

  const offline = (): ClaimState => ({ status: "unclaimed", claimUrl: usableClaimUrl(acct!, now), refreshed: false });

  if (!opts.force && acct.lastClaimCheckAt) {
    const last = new Date(acct.lastClaimCheckAt).getTime();
    if (!Number.isNaN(last) && now.getTime() - last < CLAIM_CHECK_THROTTLE_MS) return offline();
  }

  const key = opts.apiKey ?? resolveApiKey(projectRoot).key;
  if (!key) return offline();

  const base = opts.fetchImpl ?? fetch;
  const fetchImpl = ((url: string, init?: RequestInit) =>
    base(url, { ...init, signal: AbortSignal.timeout(CLAIM_REQUEST_TIMEOUT_MS) })) as typeof fetch;

  // Record the attempt first, so a run of failing calls does not retry each time.
  acct = { ...acct, lastClaimCheckAt: now.toISOString() };
  writeAccount(acct, projectRoot);

  try {
    const remote = await fetchAccountStatus(key, { url: opts.accountUrl, fetchImpl });
    if (remote.claimed === true) return markClaimed(acct, projectRoot);
  } catch {
    // Status unknown: carry on and judge the held link on its own.
  }

  const needsNew = !isTrustedClaimUrl(acct.claimUrl) || linkAgeMs(acct, now) >= CLAIM_LINK_REFRESH_AGE_MS;
  if (!needsNew) return offline();

  let fresh;
  try {
    fresh = await requestClaimLink(key, { url: opts.claimUrl, fetchImpl });
  } catch (err) {
    if (opts.force && !usableClaimUrl(acct, now)) {
      if (err instanceof ToolkitError) throw err;
      throw new ToolkitError({
        code: "BACKEND_UNAVAILABLE",
        message: "Could not reach Zenrows to get a fresh claim link.",
        likely_cause: err instanceof Error ? err.message : String(err),
        next_action: "The stored claim link has expired. Check connectivity and run `zenrows account claim` again.",
        suggested_commands: ["zenrows account claim"],
      });
    }
    return offline();
  }
  if (fresh.status === "claimed") return markClaimed(acct, projectRoot);
  if (!isTrustedClaimUrl(fresh.claimUrl)) {
    if (opts.force && !usableClaimUrl(acct, now)) {
      throw new ToolkitError({
        code: "FETCH_FAILED",
        message: "The claim-link endpoint returned a URL outside zenrows.com; it was not used.",
        likely_cause: "The signup/claim endpoint override points at an unexpected server.",
        next_action: "Check ZENROWS_AGENT_SIGNUP_URL / `signupUrl` in the zenrows config, then retry.",
      });
    }
    return offline();
  }
  acct = { ...acct, claimUrl: fresh.claimUrl, claimUrlIssuedAt: now.toISOString() };
  writeAccount(acct, projectRoot);
  return { status: "unclaimed", claimUrl: fresh.claimUrl, refreshed: true };
}

function markClaimed(acct: AgentAccount, projectRoot?: string): ClaimState {
  writeAccount({ ...acct, unclaimed: false }, projectRoot);
  return { status: "claimed" };
}

/** The error hint for a refreshed state. */
export function claimHintFor(state: ClaimState): ClaimHint {
  if (state.status !== "unclaimed") return undefined;
  return state.claimUrl ?? CLAIM_LINK_REFRESH;
}

/**
 * Bring a quota error's claim advice up to date before it is shown. Errors are
 * built synchronously from `account.json`; this runs the throttled refresh and
 * rewrites `next_action` if the account was claimed or the link changed. Never
 * throws: on any failure the error is returned as it was.
 */
export async function refreshClaimAdvice(err: unknown, opts: RefreshOptions = {}): Promise<unknown> {
  try {
    if (!(err instanceof ToolkitError) || !err.next_action.startsWith(CLAIM_NEXT_ACTION_PREFIX)) return err;
    const state = await refreshClaimState({ ...opts, force: false });
    const next = quotaNextAction(claimHintFor(state));
    if (next === err.next_action) return err;
    return new ToolkitError({ ...err.toJSON(), next_action: next });
  } catch {
    return err;
  }
}
