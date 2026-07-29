/**
 * Protected Fetch adapter → Zenrows Universal Scraper API (`GET /v1/`).
 *
 * Maps toolkit options to confirmed API parameters and enforces the
 * auto/manual contract: in Adaptive Stealth Mode (mode=auto), `js_render` and
 * `premium_proxy` are managed by Zenrows, so passing them manually without
 * `--manual` is a PARAM_CONFLICT_AUTO_MANUAL error. `proxy_country` is allowed
 * alongside auto (per docs).
 */
import type { Policy, ToolkitConfig } from "../types/index.ts";
import { ToolkitError } from "../core/errors.ts";
import { assertDomainAllowed } from "../core/policy.ts";
import { scrape, type ScraperParams, type ScraperResult } from "../core/http.ts";

export type ResponseFormat = "html" | "markdown" | "plaintext" | "pdf";

export interface FetchOptions {
  url: string;
  /** Adaptive Stealth (auto) vs. manual control. Defaults to config.defaultMode. */
  manual?: boolean;
  jsRender?: boolean;
  premiumProxy?: boolean;
  proxyCountry?: string;
  wait?: number;
  waitFor?: string;
  jsInstructions?: string;
  customHeaders?: boolean;
  sessionId?: number;
  originalStatus?: boolean;
  allowedStatusCodes?: string;
  /** response_type mapping. "html" leaves it unset (raw HTML). */
  output?: ResponseFormat;
  screenshot?: boolean;
  cssExtractor?: string;
  autoparse?: boolean;
  /**
   * Comma-separated Universal Scraper API output filters (e.g. "emails,links",
   * or "*" for all available fields). Returns structured JSON. Standalone: not combined with
   * autoparse / css_extractor / response_type.
   */
  outputs?: string;
  jsonResponse?: boolean;
}

const RESPONSE_TYPE: Partial<Record<ResponseFormat, string>> = {
  markdown: "markdown",
  plaintext: "plaintext",
  pdf: "pdf",
};

/** Validate the auto/manual contract before building params. */
export function validateAutoManual(opts: FetchOptions, config: ToolkitConfig): void {
  const isAuto = opts.manual ? false : config.defaultMode === "auto";
  if (!isAuto) {
    // Manual mode: the API only geolocates the proxy when premium_proxy is on
    // (auto mode handles geo itself). Catch it here instead of round-tripping a
    // 400 (REQS004). We don't silently enable premium_proxy — it's 10x cost, so
    // the caller must opt in.
    if (opts.proxyCountry && !opts.premiumProxy) {
      throw new ToolkitError({
        code: "PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM",
        message: "--proxy-country needs premium proxies in manual mode.",
        likely_cause:
          "Proxy geolocation (proxy_country) is only supported with premium_proxy=true, or in Adaptive Stealth Mode (mode=auto).",
        next_action:
          "Add --premium-proxy (10x cost), or drop --manual to use auto mode — geo-targeting works there without the flag.",
        suggested_commands: [
          `zenrows fetch ${opts.url} --manual --premium-proxy --proxy-country ${opts.proxyCountry}`,
          `zenrows fetch ${opts.url} --proxy-country ${opts.proxyCountry}`,
        ],
      });
    }
    return;
  }
  const managed: string[] = [];
  if (opts.jsRender) managed.push("--js-render");
  if (opts.premiumProxy) managed.push("--premium-proxy");
  if (managed.length > 0) {
    throw new ToolkitError({
      code: "PARAM_CONFLICT_AUTO_MANUAL",
      message: `Cannot combine Adaptive Stealth Mode (mode=auto) with manually managed flags: ${managed.join(", ")}.`,
      likely_cause:
        "In mode=auto, Zenrows manages js_render and premium_proxy automatically and escalates only when needed.",
      next_action:
        "Either drop those flags to keep auto mode, or pass --manual to take full manual control.",
      suggested_commands: [
        `zenrows fetch ${opts.url}`,
        `zenrows fetch ${opts.url} --manual ${managed.join(" ")}`,
      ],
    });
  }
}

export function buildParams(opts: FetchOptions, config: ToolkitConfig): ScraperParams {
  const isAuto = opts.manual ? false : config.defaultMode === "auto";
  const params: ScraperParams = { url: opts.url };

  if (isAuto) {
    params.mode = "auto";
    // proxy_country is the only proxy/render knob allowed alongside auto.
    if (opts.proxyCountry) params.proxy_country = opts.proxyCountry;
  } else {
    if (opts.jsRender) params.js_render = true;
    if (opts.premiumProxy) params.premium_proxy = true;
    if (opts.proxyCountry) params.proxy_country = opts.proxyCountry;
  }

  if (opts.wait !== undefined) params.wait = opts.wait;
  if (opts.waitFor) params.wait_for = opts.waitFor;
  if (opts.jsInstructions) params.js_instructions = opts.jsInstructions;
  if (opts.customHeaders) params.custom_headers = true;
  if (opts.sessionId !== undefined) params.session_id = opts.sessionId;
  if (opts.originalStatus) params.original_status = true;
  if (opts.allowedStatusCodes) params.allowed_status_codes = opts.allowedStatusCodes;
  if (opts.autoparse) params.autoparse = true;
  if (opts.cssExtractor) params.css_extractor = opts.cssExtractor;
  if (opts.outputs) params.outputs = opts.outputs;
  if (opts.jsonResponse) params.json_response = true;
  if (opts.screenshot) params.screenshot = true;
  if (opts.output && RESPONSE_TYPE[opts.output]) params.response_type = RESPONSE_TYPE[opts.output];

  return params;
}

export interface FetchOutcome {
  result: ScraperResult;
  params: ScraperParams;
  mode: "auto" | "manual";
}

export async function runFetch(
  opts: FetchOptions,
  config: ToolkitConfig,
  policy: Policy,
  apiKey: string,
): Promise<FetchOutcome> {
  assertDomainAllowed(opts.url, policy);
  validateAutoManual(opts, config);
  const params = buildParams(opts, config);
  const mode: "auto" | "manual" = params.mode === "auto" ? "auto" : "manual";
  const result = await scrape(config.apiBase, apiKey, params);
  return { result, params, mode };
}
