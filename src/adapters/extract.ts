/**
 * Extract adapter.
 *
 * Structured extraction on the same `/v1/` Fetch and Extract API via:
 *   - extract=auto         → site-tailored Extract (any prepared domain)
 *   - autoparse=true       → general-purpose Autoparse (any domain)
 *   - css_extractor=<json> → selector-based field extraction
 *   - outputs=<filters>    → built-in output filters → JSON
 *   - response_type=markdown|plaintext
 *
 * Default method is `extract`. REQS007 (or the legacy AUTH010: Extract has not
 * prepared the domain yet) is reported with the prepare step, not retried.
 * Autoparse is deprecated and runs only when asked for: `--autoparse`, or
 * `fallbackAutoparse: true`.
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
   * When method is `extract` (default), retry once with the deprecated Autoparse
   * if Extract has not prepared the domain yet (REQS007 / AUTH010). Defaults to
   * false: the error names the prepare step instead.
   */
  fallbackAutoparse?: boolean;
}

export interface ExtractOutcome extends FetchOutcome {
  method: ExtractMethod;
  /** Parsed JSON when the method yields structured data; otherwise undefined. */
  data?: unknown;
  /** Raw HTML from `extract=auto` responses (validation aid). */
  html?: string;
  /** True when Extract fell back to Autoparse (only with `fallbackAutoparse: true`). */
  fellBackToAutoparse?: boolean;
  /**
   * True when a structured method returned no data (null / empty object / empty
   * array / non-JSON). Lets callers warn instead of reporting a silent success.
   */
  empty?: boolean;
  /**
   * True when Extract answered `no_data_extracted` (HTTP 422): it knows this kind
   * of page but no field came back filled. Always reported with `empty: true`.
   */
  noDataExtracted?: boolean;
}

/**
 * True when a parsed extraction result carries no usable structured data: null,
 * a blank string, or an array / object whose every value is itself empty. So
 * `{"title": null, "items": [], "author": {"name": ""}}` is empty. Numbers and
 * booleans are values, so `0` and `false` count as data.
 */
export function isEmptyData(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (typeof data === "string") return data.trim() === "";
  if (Array.isArray(data)) return data.every(isEmptyData);
  if (typeof data === "object") return Object.values(data as object).every(isEmptyData);
  return false;
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

  if (method === "extract" && opts.fallbackAutoparse === true) {
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
  if (outcome.result.noDataExtracted) {
    if (opts.validate) {
      throw new ToolkitError({
        code: "EXTRACT_VALIDATION_FAILED",
        message: "Extract found no data on this page.",
        likely_cause:
          "Extract knows this kind of page, but none of the fields came back filled (HTTP 422 no_data_extracted). The request was not charged.",
        next_action:
          "Check that the page rendered fully: try --manual --js-render with --wait-for <selector>. Protected sites may also need --premium-proxy.",
        suggested_commands: [`zenrows extract ${opts.url} --manual --js-render --premium-proxy`],
      });
    }
    return { ...outcome, method, empty: true, noDataExtracted: true };
  }
  const { data, html, empty } = parseExtractBody(method, outcome.result.body, opts);

  return { ...outcome, method, data, html, empty };
}

function parseExtractBody(
  method: ExtractMethod,
  body: string,
  opts: Pick<ExtractOptions, "validate" | "url">,
): { data?: unknown; html?: string; empty?: boolean } {
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
    return { empty: true };
  }

  let data: unknown = parsed;
  let html: string | undefined;
  // extract=auto shape: { parsed, html }. Prefer `parsed` for callers.
  if (method === "extract" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const envelope = parsed as { parsed?: unknown; html?: unknown };
    if ("parsed" in envelope) {
      data = envelope.parsed;
      html = typeof envelope.html === "string" ? envelope.html : undefined;
    }
  }

  const empty = isEmptyData(data);
  // An empty result must not read as a silent success. Under
  // --validate it's an error; otherwise the command surfaces a warning.
  if (opts.validate && empty) {
    throw new ToolkitError({
      code: "EXTRACT_VALIDATION_FAILED",
      message: "Extraction returned no structured data.",
      likely_cause:
        "The domain returned an empty result — the page may render content via JavaScript, or this layout isn't auto-extractable.",
      next_action: "Retry with --manual --js-render, or use --css with explicit selectors.",
      suggested_commands: [
        `zenrows extract ${opts.url} --manual --js-render`,
        `zenrows extract ${opts.url} --css '{"title":"h1"}'`,
      ],
    });
  }
  return { data, html, empty };
}
