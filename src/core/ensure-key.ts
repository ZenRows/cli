/**
 * Resolve-or-provision the Zenrows API key.
 *
 * When no key is configured and `policy.auto_signup` is enabled, this creates a
 * free unclaimed Free plan account (via the public signup endpoint), persists the
 * key (0600) and the account metadata, and returns the key. Otherwise it defers
 * to `requireApiKey`, which throws AUTH_MISSING.
 */
import type { AgentAccount, Policy } from "../types/index.ts";
import { requireApiKey, resolveApiKey, saveApiKey } from "./auth.ts";
import { signupAgent, writeAccount } from "./agent-account.ts";

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
  const res = await doSignup();
  saveApiKey(res.apiKey, opts.projectRoot);
  const account: AgentAccount = {
    accountId: res.accountId,
    unclaimed: true,
    claimUrl: res.claimUrl,
    createdAt: new Date().toISOString(),
  };
  writeAccount(account, opts.projectRoot);
  opts.onProvision?.(account);
  return res.apiKey;
}
