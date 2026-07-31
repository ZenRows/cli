/**
 * `zenrows extract <url> [flags]` → Extract (structured extraction on `/v1/`).
 *
 * Default: `extract=auto` (site-tailored Extract, open beta). If the domain is
 * not enabled (AUTH010), falls back once to Autoparse. Opt into Autoparse
 * directly with `--autoparse`. Other methods: `--css`, `--outputs`, `--output`.
 */
import { ensureApiKey } from "../../core/ensure-key.ts";
import { maybeNudgeClaim } from "../../core/nudge.ts";
import { assertUsable } from "../../core/capabilities.ts";
import { loadConfig } from "../../core/config.ts";
import { loadPolicy } from "../../core/policy.ts";
import { log } from "../../core/logger.ts";
import { newRunId, writeRun } from "../../core/artifacts.ts";
import { ToolkitError } from "../../core/errors.ts";
import { runExtract, type ExtractMethod, type ExtractOptions } from "../../adapters/extract.ts";
import { formatRequestCost } from "../../core/http.ts";
import { parse, asString, asNumber, type Command, type RunContext } from "../command.ts";
import { printError, writeOut } from "../output.ts";

export const extract: Command = {
  name: "extract",
  summary: "Turn a protected page into structured data (Extract / Autoparse / CSS / Markdown).",
  usage: "zenrows extract <url> [--autoparse | --css <json> | --outputs <filters> | --output md|text] [flags]",
  help: [
    "Methods:",
    "  (default)              extract=auto — site-tailored Extract (open beta); falls back to Autoparse if the domain is not enabled",
    "  --autoparse            general-purpose Autoparse (any domain, no Extract fallback)",
    "  --css <json>           CSS selector map, e.g. '{\"title\":\"h1\",\"price\":\".price\"}'",
    "  --outputs <list>       built-in output filters → JSON: emails, phone_numbers, headings,",
    "                         images, audios, videos, links, menus, hashtags, metadata, tables,",
    "                         favicon (comma-separated, or '*' for all available fields)",
    "  --output md|text       Markdown / plaintext conversion",
    "Shared:",
    "  --manual --js-render --premium-proxy   manual fetch controls",
    "  --validate             fail if the result is not valid JSON",
    "  --out <file>           write output to a file",
    "  --no-signup            do not auto-create a Free plan account if no key exists",
    "  --json                 structured result",
  ].join("\n"),
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const { values, positionals } = parse(argv, {
      autoparse: { type: "boolean" },
      css: { type: "string" },
      outputs: { type: "string" },
      output: { type: "string" },
      manual: { type: "boolean" },
      "js-render": { type: "boolean" },
      "premium-proxy": { type: "boolean" },
      "proxy-country": { type: "string" },
      wait: { type: "string" },
      "wait-for": { type: "string" },
      validate: { type: "boolean" },
      out: { type: "string" },
      "no-signup": { type: "boolean" },
      json: { type: "boolean" },
    });

    const url = positionals[0];
    if (!url) {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: "Missing URL.",
        likely_cause: "No positional <url> was provided.",
        next_action: "Usage: zenrows extract <url> [flags]",
        suggested_commands: ["zenrows extract https://example.com", "zenrows extract https://example.com --autoparse"],
      });
    }

    const output = asString(values.output);
    const outputs = normalizeOutputs(asString(values.outputs));
    if (outputs && (values.css || values.autoparse || output)) {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: "--outputs cannot be combined with --css, --autoparse, or --output.",
        likely_cause: "Those are alternative extraction methods — choose exactly one.",
        next_action: "Run --outputs on its own, e.g. zenrows extract <url> --outputs emails,links.",
      });
    }
    const method: ExtractMethod | undefined = outputs
      ? "outputs"
      : values.css
        ? "css"
        : output === "md" || output === "markdown"
          ? "markdown"
          : output === "text" || output === "plaintext"
            ? "plaintext"
            : values.autoparse
              ? "autoparse"
              : undefined;

    const opts: ExtractOptions = {
      url,
      method,
      cssExtractor: asString(values.css),
      outputs,
      manual: values.manual === true,
      jsRender: values["js-render"] === true,
      premiumProxy: values["premium-proxy"] === true,
      proxyCountry: asString(values["proxy-country"]),
      wait: asNumber(values.wait),
      waitFor: asString(values["wait-for"]),
      validate: values.validate === true,
    };

    assertUsable("extract");
    const config = loadConfig();
    const policy = loadPolicy();
    const apiKey = await ensureApiKey(
      values["no-signup"] ? { ...policy, auto_signup: false } : policy,
      {
        onProvision: (a) => {
          log.info("No API key found — created a Zenrows Free plan account for you.");
          log.dim(`Claim it anytime (keeps your usage): ${a.claimUrl}`);
        },
      },
    );

    const runId = newRunId();
    const startedAt = new Date().toISOString();
    log.step(`Extract ${url} (method=${opts.method ?? "extract"})…`);

    try {
      const outcome = await runExtract(opts, config, policy, apiKey);
      const finishedAt = new Date().toISOString();
      const safeParams = { ...outcome.params };
      delete (safeParams as Record<string, unknown>).apikey;

      if (outcome.fellBackToAutoparse) {
        log.info("Extract not enabled for this domain — fell back to Autoparse.");
      }

      const runDir = writeRun(
        {
          runId,
          command: "zenrows extract",
          capability: "extract",
          url,
          startedAt,
          finishedAt,
          status: "ok",
          request: {
            ...safeParams,
            method: outcome.method,
            fellBackToAutoparse: outcome.fellBackToAutoparse ?? false,
          },
          result: { httpStatus: outcome.result.status, bytes: outcome.result.body.length, parsed: outcome.data !== undefined },
          costUsd: outcome.result.costUsd,
          costCredits: outcome.result.costCredits,
          requestId: outcome.result.requestId,
        },
        { "output.txt": outcome.result.body },
      );

      const payload = outcome.data !== undefined ? JSON.stringify(outcome.data, null, 2) : outcome.result.body;
      if (values.out) {
        writeOut(values.out as string, payload);
        log.success(`Wrote output → ${values.out}`);
      }
      const via = outcome.fellBackToAutoparse ? `${outcome.method} (fallback)` : outcome.method;
      log.success(
        `Extracted via ${via} · ${outcome.result.body.length} bytes · ${formatRequestCost(outcome.result.costUsd, outcome.result.costCredits)} · run ${runId}`,
      );
      if (runDir) log.dim(`  artifact: ${runDir}`);

      if (ctx.json || values.json) {
        log.out(
          JSON.stringify(
            {
              ok: true,
              runId,
              method: outcome.method,
              fellBackToAutoparse: outcome.fellBackToAutoparse ?? false,
              httpStatus: outcome.result.status,
              data: outcome.data ?? null,
              bytes: outcome.result.body.length,
              costUsd: outcome.result.costUsd,
              costCredits: outcome.result.costCredits,
            },
            null,
            2,
          ),
        );
      } else if (!values.out) {
        log.out(payload);
      }
      await maybeNudgeClaim(config, {});
      return 0;
    } catch (err) {
      writeRun({
        runId,
        command: "zenrows extract",
        capability: "extract",
        url,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "error",
        request: { url, method: method ?? "extract" },
        error: err instanceof ToolkitError ? err.toJSON() : { message: String(err) },
      });
      printError(err, ctx.json || values.json === true);
      return 1;
    }
  },
};

/** Fetch and Extract `outputs` filters (docs.zenrows.com output-filters). */
const OUTPUT_FILTERS = [
  "emails",
  "phone_numbers",
  "headings",
  "images",
  "audios",
  "videos",
  "links",
  "menus",
  "hashtags",
  "metadata",
  "tables",
  "favicon",
];

/**
 * Parse/validate the `--outputs` value into the API's comma-separated form.
 * Returns undefined when absent; throws INVALID_USAGE on any unrecognized filter
 * (so a typo fails loudly rather than being silently dropped). `*` selects all.
 */
export function normalizeOutputs(v?: string): string | undefined {
  if (!v) return undefined;
  const tokens = v
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return undefined;
  if (tokens.includes("*")) return "*";
  const known = new Set(OUTPUT_FILTERS);
  const invalid = tokens.filter((t) => !known.has(t));
  if (invalid.length > 0) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Unknown --outputs filter(s): ${invalid.join(", ")}.`,
      likely_cause: "One or more output-filter names are not recognized.",
      next_action: `Use a comma-separated list of: ${OUTPUT_FILTERS.join(", ")} (or '*' for all available fields).`,
      suggested_commands: ["zenrows extract <url> --outputs emails,links"],
    });
  }
  // De-duplicate while preserving order.
  return [...new Set(tokens)].join(",");
}
