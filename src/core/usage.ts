/**
 * Plan-usage client for the Zenrows Universal Scraper API.
 *
 * Calls `GET {apiBase}/subscriptions/self/details` (auth via the `X-API-Key`
 * header — note: NOT the `apikey` query param the scraper uses). Per the docs,
 * this call does not count against the account's concurrency limit, so it is
 * safe to poll. The API key is registered as a secret so it is redacted in logs.
 */
import { ToolkitError, quotaExhausted } from "./errors.ts";
import { isQuotaError, zrErrorDetail } from "./http.ts";
import { readAccount } from "./agent-account.ts";
import { ENV_KEY, resolveApiKey } from "./auth.ts";
import { registerSecret } from "./logger.ts";

export interface UsageConcurrency {
  limit?: number;
  usage?: number;
}

export interface UsageProduct {
  usage?: number;
  concurrency?: UsageConcurrency;
  [k: string]: unknown;
}

export interface UsageDetails {
  status?: string;
  period_starts_at?: string;
  period_ends_at?: string;
  /** Total units consumed across all products. */
  usage?: number;
  /** Consumption as a percentage of the plan limit. */
  usage_percent?: number;
  plan?: {
    name?: string;
    price?: number;
    recurrence?: string;
    products?: {
      api?: UsageProduct;
      proxy_residential?: UsageProduct;
      scraping_browser?: UsageProduct;
      [k: string]: unknown;
    };
  };
  top_ups?: unknown[];
  [k: string]: unknown;
}

/** Build the plan-usage URL from the configured API base. */
export function usageUrl(apiBase: string): string {
  const base = apiBase.endsWith("/") ? apiBase : apiBase + "/";
  return new URL("subscriptions/self/details", base).toString();
}

/** Fetch plan usage/credits/concurrency. Throws ToolkitError on failure. */
export async function fetchUsage(
  apiBase: string,
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<UsageDetails> {
  registerSecret(apiKey);
  const url = usageUrl(apiBase);
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { "X-API-Key": apiKey, Accept: "application/json", "User-Agent": "zenrows-cli" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new ToolkitError({
      code: "BACKEND_UNAVAILABLE",
      message: "Could not reach the Zenrows usage endpoint.",
      likely_cause: err instanceof Error ? err.message : String(err),
      next_action: "Check connectivity and retry. Verify the API base with `zenrows config show`.",
      suggested_commands: ["zenrows status"],
    });
  }
  clearTimeout(timeout);

  const body = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new ToolkitError({
      code: "AUTH_INVALID",
      message: "Zenrows rejected the API key for the usage request.",
      likely_cause: `HTTP ${res.status}: ${body.slice(0, 240)}`,
      next_action:
        resolveApiKey().source === "env"
          ? `This key came from ${ENV_KEY} in your environment. Unset it (\`unset ${ENV_KEY}\`) or replace the value, then retry — or log in with a valid key.`
          : "Re-check your key and log in again.",
      suggested_commands:
        resolveApiKey().source === "env"
          ? [`unset ${ENV_KEY}`, "zenrows login --api-key <your-key>"]
          : ["zenrows login --api-key <your-key>"],
    });
  }
  if (res.status === 402 || (res.status >= 400 && isQuotaError(body))) {
    // Out of credits / over the usage limit — same "exhausted" state as the
    // scraper 402. Surface it as a credits error (claim link for an unclaimed
    // Free plan account, dashboard/upgrade otherwise) instead of a generic "retry".
    const acct = readAccount();
    throw quotaExhausted(url, acct?.unclaimed ? acct.claimUrl : undefined, {
      status: res.status,
      detail: zrErrorDetail(body) ?? undefined,
    });
  }
  if (res.status >= 400) {
    throw new ToolkitError({
      code: "FETCH_FAILED",
      message: `Usage request failed (HTTP ${res.status}).`,
      likely_cause: body.slice(0, 240) || "Unexpected error from the usage endpoint.",
      next_action: "Retry, or check your usage in the Zenrows dashboard.",
    });
  }
  try {
    return JSON.parse(body) as UsageDetails;
  } catch {
    throw new ToolkitError({
      code: "FETCH_FAILED",
      message: "The usage response was not valid JSON.",
      likely_cause: body.slice(0, 240),
      next_action: "Retry, or check your usage in the Zenrows dashboard.",
    });
  }
}
