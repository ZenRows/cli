/**
 * Governance policy (`.zenrows/policy.json`). Enforced before any cloud call.
 */
import type { Policy } from "../types/index.ts";
import { ToolkitError } from "./errors.ts";
import { findWorkspace, readJson, workspacePaths, writeJson } from "./workspace.ts";

export function defaultPolicy(): Policy {
  return {
    max_credits_per_run: 10000,
    max_pages_per_run: 1000,
    max_concurrency: 20,
    allow_browser: true,
    allow_experimental: false,
    allowed_domains: [],
    blocked_domains: [],
    redact_secrets: true,
    telemetry: "anonymous",
    auto_signup: true,
  };
}

export function loadPolicy(projectRoot?: string): Policy {
  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  const stored = readJson<Partial<Policy>>(ws.policy);
  return { ...defaultPolicy(), ...(stored ?? {}) };
}

export function savePolicy(policy: Policy, projectRoot?: string): void {
  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  writeJson(ws.policy, policy);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function domainMatches(host: string, rule: string): boolean {
  const r = rule.trim().toLowerCase().replace(/^\*\./, "");
  if (!r) return false;
  return host === r || host.endsWith(`.${r}`);
}

/** Throw if the target URL violates the allow/deny domain policy. */
export function assertDomainAllowed(url: string, policy: Policy): void {
  const host = hostOf(url);
  if (!host) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Invalid URL: ${url}`,
      likely_cause: "The URL is malformed or missing a scheme (https://).",
      next_action: "Pass a fully-qualified URL, e.g. https://example.com/page.",
    });
  }
  if (policy.blocked_domains.some((d) => domainMatches(host, d))) {
    throw new ToolkitError({
      code: "POLICY_BLOCKED_DOMAIN",
      message: `Domain "${host}" is blocked by policy.`,
      likely_cause: "The host matches an entry in policy.blocked_domains.",
      next_action: "Remove the domain from blocked_domains or target a different host.",
      suggested_commands: ["zenrows policy show"],
    });
  }
  if (
    policy.allowed_domains.length > 0 &&
    !policy.allowed_domains.some((d) => domainMatches(host, d))
  ) {
    throw new ToolkitError({
      code: "POLICY_BLOCKED_DOMAIN",
      message: `Domain "${host}" is not in the allow-list.`,
      likely_cause:
        "policy.allowed_domains is non-empty, which switches the toolkit to allow-list mode.",
      next_action: `Add "${host}" to allowed_domains, or clear the allow-list to permit all hosts.`,
      suggested_commands: ["zenrows policy show"],
    });
  }
}

/** Throw if experimental commands are disabled by policy. */
export function assertExperimentalAllowed(policy: Policy, command: string): void {
  if (!policy.allow_experimental) {
    throw new ToolkitError({
      code: "POLICY_EXPERIMENTAL_DISABLED",
      message: `\`${command}\` is experimental and disabled by policy.`,
      likely_cause: "policy.allow_experimental is false (the safe default).",
      next_action: "Re-run with --experimental, or set allow_experimental=true in policy.json.",
      suggested_commands: [`${command} --experimental`],
    });
  }
}

/**
 * Throw if a run exceeds the policy's numeric caps.
 *
 * These caps are meaningful for *multi-request* runs (batch): a single `fetch`
 * or `extract` is one request, so its adapters do not call this. `pages` is the
 * task count; `credits` is the locally-estimated credit cost. Either may be
 * omitted when not applicable.
 */
export function assertWithinLimits(
  requested: { pages?: number; credits?: number },
  policy: Policy,
  context = "run",
): void {
  if (requested.pages !== undefined && requested.pages > policy.max_pages_per_run) {
    throw new ToolkitError({
      code: "POLICY_LIMIT_EXCEEDED",
      message: `This ${context} submits ${requested.pages} page(s), over the policy cap of ${policy.max_pages_per_run}.`,
      likely_cause: "policy.max_pages_per_run bounds how many URLs a single run may submit.",
      next_action: `Split the job into runs of ≤${policy.max_pages_per_run} page(s), or raise max_pages_per_run in policy.json.`,
      suggested_commands: ["zenrows policy show"],
    });
  }
  if (requested.credits !== undefined && requested.credits > policy.max_credits_per_run) {
    throw new ToolkitError({
      code: "POLICY_LIMIT_EXCEEDED",
      message: `This ${context} is estimated at ${requested.credits} credit(s), over the policy cap of ${policy.max_credits_per_run}.`,
      likely_cause: "policy.max_credits_per_run bounds the estimated credit cost of a single run.",
      next_action: "Reduce the job size or per-task cost (e.g. drop premium_proxy/js_render), or raise max_credits_per_run in policy.json.",
      suggested_commands: ["zenrows policy show"],
    });
  }
}

/** Throw if browser sessions have been disabled by policy (they are on by default). */
export function assertBrowserAllowed(policy: Policy): void {
  if (!policy.allow_browser) {
    throw new ToolkitError({
      code: "POLICY_BROWSER_DISABLED",
      message: "Browser sessions are disabled by policy.",
      likely_cause: "policy.allow_browser is false — browser was opted out in this workspace.",
      next_action:
        "Re-enable with `zenrows policy set allow_browser true`. Note: browser is escalation-only — prefer fetch/extract, which cost less, for most cases.",
      suggested_commands: ["zenrows policy set allow_browser true"],
    });
  }
}
