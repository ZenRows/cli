/**
 * Extract adapter.
 *
 * Structured extraction on the same `/v1/` Fetch and Extract API via:
 *   - extract=auto         → site-tailored Extract (open beta, domain-gated)
 *   - autoparse=true       → general-purpose Autoparse (any domain)
 *   - css_extractor=<json> → selector-based field extraction
 *   - outputs=<filters>    → built-in output filters → JSON
 *   - response_type=markdown|plaintext
 *
 * Default method is `extract`. On AUTH010 (domain not in Extract beta) we
 * automatically retry once with Autoparse unless the caller opted into
 * `--autoparse` (or another explicit method) or disabled the fallback.
 */
import type { Policy, ToolkitConfig } from "../types/index.ts";
import { ToolkitError } from "../core/errors.ts";
import { runFetch, type FetchOptions, type FetchOutcome } from "./protected-fetch.ts";

export type ExtractMethod = "extract" | "autoparse" | "css" | "outputs" | "markdown" | "plaintext";

export interface ExtractOptions extends Omit<FetchOptions, "autoparse" | "cssExtractor" | "outputs" | "output" | "extract"> {
  /** Deterministic extraction method backed by /v1/. Defaults to `extract`. */
  method?: ExtractMethod;
  cssExtractor?: string;
  /** Comma-separated output filters (e.g. "emails,links" or "*"). Used with method "outputs". */
  outputs?: string;
  /** Validate the parsed JSON shape locally (best-effort). */
  validate?: boolean;
  /**
   * When method is `extract` (default), retry once with Autoparse if the domain
   * is not enabled for Extract (AUTH010). Defaults to true.
   */
  fallbackAutoparse?: boolean;
}

export interface ExtractOutcome extends FetchOutcome {
  method: ExtractMethod;
  /** Parsed JSON when the method yields structured data; otherwise undefined. */
  data?: unknown;
  /** Raw HTML from `extract=auto` beta responses (validation aid). */
  html?: string;
  /** True when Extract fell back to Autoparse because the domain is not enabled. */
  fellBackToAutoparse?: boolean;
}

export async function runExtract(
  opts: ExtractOptions,
  config: ToolkitConfig,
  policy: Policy,
  apiKey: string,
): Promise<ExtractOutcome> {
  const method: ExtractMethod =
    opts.method ?? (opts.outputs ? "outputs" : opts.cssExtractor ? "css" : "extract");

  if (method === "css" && !opts.cssExtractor) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "CSS extraction requires a selector map.",
      likely_cause: "--css was selected but no JSON selector map was provided.",
      next_action: `Pass a JSON map, e.g. --css '{"title":"h1","price":".price"}'`,
    });
  }

  if (method === "outputs" && !opts.outputs) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Output-filter extraction requires a filter list.",
      likely_cause: "--outputs was selected but no filter list was provided.",
      next_action: `Pass one or more filters, e.g. --outputs emails,links (or --outputs '*').`,
    });
  }

  if (method === "extract" && opts.fallbackAutoparse !== false) {
    try {
      return await runExtractOnce({ ...opts, method: "extract" }, config, policy, apiKey);
    } catch (err) {
      if (err instanceof ToolkitError && err.code === "EXTRACT_DOMAIN_NOT_ENABLED") {
        const outcome = await runExtractOnce({ ...opts, method: "autoparse" }, config, policy, apiKey);
        return { ...outcome, fellBackToAutoparse: true };
      }
      throw err;
    }
  }

  return runExtractOnce({ ...opts, method }, config, policy, apiKey);
}

async function runExtractOnce(
  opts: ExtractOptions & { method: ExtractMethod },
  config: ToolkitConfig,
  policy: Policy,
  apiKey: string,
): Promise<ExtractOutcome> {
  const { method } = opts;
  const fetchOpts: FetchOptions = {
    ...opts,
    extract: method === "extract",
    autoparse: method === "autoparse",
    cssExtractor: method === "css" ? opts.cssExtractor : undefined,
    outputs: method === "outputs" ? opts.outputs : undefined,
    output: method === "markdown" ? "markdown" : method === "plaintext" ? "plaintext" : "html",
  };

  const outcome = await runFetch(fetchOpts, config, policy, apiKey);
  const { data, html } = parseExtractBody(method, outcome.result.body, opts);

  return { ...outcome, method, data, html };
}

function parseExtractBody(
  method: ExtractMethod,
  body: string,
  opts: Pick<ExtractOptions, "validate" | "url">,
): { data?: unknown; html?: string } {
  if (method !== "extract" && method !== "autoparse" && method !== "css" && method !== "outputs") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (opts.validate) {
      throw new ToolkitError({
        code: "EXTRACT_VALIDATION_FAILED",
        message: "Extraction did not return valid JSON.",
        likely_cause:
          "The page may need js_render, or structured extraction could not detect data on this layout.",
        next_action: "Retry with --manual --js-render, or switch to --css with explicit selectors.",
        suggested_commands: [`zenrows extract ${opts.url} --manual --js-render`],
      });
    }
    return {};
  }

  // extract=auto beta shape: { parsed, html }. Prefer `parsed` for callers.
  if (method === "extract" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const envelope = parsed as { parsed?: unknown; html?: unknown };
    if ("parsed" in envelope) {
      return {
        data: envelope.parsed,
        html: typeof envelope.html === "string" ? envelope.html : undefined,
      };
    }
  }

  return { data: parsed };
}
