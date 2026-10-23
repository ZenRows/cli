/**
 * Resolve-or-provision the Zenrows API key.
 *
 * When no key is configured and `policy.auto_signup` is enabled, this creates a
 * free unclaimed Free plan account (via the public signup endpoint), persists the
 * key (0600) and the account metadata, and returns the key. Otherwise it defers
 * to `requireApiKey`, which throws AUTH_MISSING. Signup may first ask one
 * short question (SIGNUP_CHALLENGE), which the agent answers with
 * `zenrows signup --answer`.
 */
import type { AgentAccount, Policy } from "../types/index.ts";
import { requireApiKey, resolveApiKey, saveApiKey } from "./auth.ts";
import { signupAgent, writeAccount, type SignupResponse } from "./agent-account.ts";

export async function ensureApiKey(
  policy: Policy,
  opts: {
    projectRoot?: string;
    signupImpl?: typeof signupAgent;
    onProvision?: (a: AgentAccount) => void;
  } = {},
): Promise<string> {
  const existing = resolveApiKey(opts.projectRoot).key;
  if (existing) return existing;
  if (!policy.auto_signup) return requireApiKey(opts.projectRoot); // throws AUTH_MISSING

  const doSignup = opts.signupImpl ?? signupAgent;
  // May throw SIGNUP_CHALLENGE: the agent answers with `zenrows signup --answer`.
  const res = await doSignup({ projectRoot: opts.projectRoot });
  const account = storeSignup(res, opts.projectRoot);
  opts.onProvision?.(account);
  return res.apiKey;
}

/** Persist a fresh agent signup: the key (0600) and the account metadata. */
export function storeSignup(res: SignupResponse, projectRoot?: string): AgentAccount {
  saveApiKey(res.apiKey, projectRoot);
  const account: AgentAccount = {
    accountId: res.accountId,
    unclaimed: true,
    claimUrl: res.claimUrl,
    createdAt: new Date().toISOString(),
  };
  account.claimUrlIssuedAt = account.createdAt;
  writeAccount(account, projectRoot);
  return account;
}
