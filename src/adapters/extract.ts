/**
 * Extract adapter.
 *
 * IMPORTANT (honest mapping): there is no separate `/extract` endpoint.
 * Structured extraction runs on the same `/v1/` Universal Scraper API via:
 *   - autoparse=true        → automatic structured JSON          (available)
 *   - css_extractor=<json>  → selector-based field extraction     (available)
 *   - response_type=markdown|plaintext                            (available)
 */
import type { Policy, ToolkitConfig } from "../types/index.ts";
import { ToolkitError } from "../core/errors.ts";
import { runFetch, type FetchOptions, type FetchOutcome } from "./protected-fetch.ts";

export type ExtractMethod = "autoparse" | "css" | "markdown" | "plaintext";

export interface ExtractOptions extends Omit<FetchOptions, "autoparse" | "cssExtractor" | "output"> {
  /** Deterministic extraction method backed by /v1/. */
  method?: ExtractMethod;
  cssExtractor?: string;
  /** Validate the parsed JSON shape locally (best-effort). */
  validate?: boolean;
}

export interface ExtractOutcome extends FetchOutcome {
  method: ExtractMethod;
  /** Parsed JSON when the method yields structured data; otherwise undefined. */
  data?: unknown;
}

export async function runExtract(
  opts: ExtractOptions,
  config: ToolkitConfig,
  policy: Policy,
  apiKey: string,
): Promise<ExtractOutcome> {
  const method: ExtractMethod = opts.method ?? (opts.cssExtractor ? "css" : "autoparse");

  const fetchOpts: FetchOptions = {
    ...opts,
    autoparse: method === "autoparse",
    cssExtractor: method === "css" ? opts.cssExtractor : undefined,
    output: method === "markdown" ? "markdown" : method === "plaintext" ? "plaintext" : "html",
  };

  if (method === "css" && !opts.cssExtractor) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "CSS extraction requires a selector map.",
      likely_cause: "--css was selected but no JSON selector map was provided.",
      next_action: `Pass a JSON map, e.g. --css '{"title":"h1","price":".price"}'`,
    });
  }

  const outcome = await runFetch(fetchOpts, config, policy, apiKey);

  let data: unknown;
  if (method === "autoparse" || method === "css") {
    try {
      data = JSON.parse(outcome.result.body);
    } catch {
      if (opts.validate) {
        throw new ToolkitError({
          code: "EXTRACT_VALIDATION_FAILED",
          message: "Extraction did not return valid JSON.",
          likely_cause:
            "The page may need js_render, or autoparse could not detect structured data on this layout.",
          next_action: "Retry with --manual --js-render, or switch to --css with explicit selectors.",
          suggested_commands: [`zenrows extract ${opts.url} --manual --js-render`],
        });
      }
    }
  }

  return { ...outcome, method, data };
}
