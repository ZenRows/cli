/**
 * `zenrows fetch <url> [flags]` → Protected Fetch (Universal Scraper API).
 *
 * Defaults to Adaptive Stealth Mode (mode=auto). `--manual` switches to manual
 * control. Writes a secret-free run artifact under .zenrows/runs/.
 */
import { ensureApiKey } from "../../core/ensure-key.ts";
import { maybeNudgeClaim } from "../../core/nudge.ts";
import { assertUsable } from "../../core/capabilities.ts";
import { loadConfig } from "../../core/config.ts";
import { loadPolicy } from "../../core/policy.ts";
import { log } from "../../core/logger.ts";
import { newRunId, writeRun } from "../../core/artifacts.ts";
import { ToolkitError } from "../../core/errors.ts";
import { runFetch, type FetchOptions, type ResponseFormat } from "../../adapters/protected-fetch.ts";
import { parse, asString, asNumber, type Command, type RunContext } from "../command.ts";
import { printError, writeOut } from "../output.ts";

export const fetch_: Command = {
  name: "fetch",
  summary: "Retrieve a protected page (Protected Fetch / Universal Scraper API).",
  usage: "zenrows fetch <url> [--manual] [--js-render] [--premium-proxy] [--output md|text|html] [flags]",
  help: [
    "Flags:",
    "  --manual               disable Adaptive Stealth Mode, take manual control",
    "  --js-render            render JavaScript (manual mode only)",
    "  --premium-proxy        use residential IPs (manual mode only)",
    "  --proxy-country <cc>   geo-target (auto mode; in manual mode needs --premium-proxy)",
    "  --wait <ms>            fixed wait after load",
    "  --wait-for <selector>  wait for a CSS selector",
    "  --js-instructions <j>  JSON instructions to run on the page",
    "  --session-id <n>       keep the same IP across requests",
    "  --original-status      return the target's original HTTP status",
    "  --output <fmt>         html (default) | markdown | text | pdf",
    "  --screenshot           capture an above-the-fold screenshot",
    "  --out <file>           write the response body to a file",
    "  --no-signup            do not auto-create a trial account if no key exists",
    "  --json                 print a structured result",
  ].join("\n"),
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const { values, positionals } = parse(argv, {
      manual: { type: "boolean" },
      "js-render": { type: "boolean" },
      "premium-proxy": { type: "boolean" },
      "proxy-country": { type: "string" },
      wait: { type: "string" },
      "wait-for": { type: "string" },
      "js-instructions": { type: "string" },
      "session-id": { type: "string" },
      "original-status": { type: "boolean" },
      output: { type: "string" },
      screenshot: { type: "boolean" },
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
        next_action: "Usage: zenrows fetch <url> [flags]",
        suggested_commands: ["zenrows fetch https://example.com"],
      });
    }

    assertUsable("protected_fetch");
    const config = loadConfig();
    const policy = loadPolicy();
    const apiKey = await ensureApiKey(
      values["no-signup"] ? { ...policy, auto_signup: false } : policy,
      {
        onProvision: (a) => {
          log.info("No API key found — created a free ZenRows trial account for you.");
          log.dim(`Claim it anytime (keeps your usage): ${a.claimUrl}`);
        },
      },
    );

    const opts: FetchOptions = {
      url,
      manual: values.manual === true,
      jsRender: values["js-render"] === true,
      premiumProxy: values["premium-proxy"] === true,
      proxyCountry: asString(values["proxy-country"]),
      wait: asNumber(values.wait),
      waitFor: asString(values["wait-for"]),
      jsInstructions: asString(values["js-instructions"]),
      sessionId: asNumber(values["session-id"]),
      originalStatus: values["original-status"] === true,
      output: normalizeOutput(asString(values.output)),
      screenshot: values.screenshot === true,
    };

    const runId = newRunId();
    const startedAt = new Date().toISOString();
    log.step(`Protected Fetch ${url} (${opts.manual ? "manual" : config.defaultMode})…`);

    try {
      const { result, params, mode } = await runFetch(opts, config, policy, apiKey);
      const finishedAt = new Date().toISOString();

      const safeParams = { ...params };
      delete (safeParams as Record<string, unknown>).apikey;

      // For binary responses (screenshot / PDF), the true byte count and the
      // faithful payload come from `raw`; text responses use the decoded body.
      const bytes = result.raw.length;
      const artifactName = result.isBinary
        ? opts.screenshot
          ? "response.png"
          : "response.pdf"
        : "response.txt";

      const runDir = writeRun(
        {
          runId,
          command: "zenrows fetch",
          capability: "protected_fetch",
          url,
          startedAt,
          finishedAt,
          status: "ok",
          request: { ...safeParams, mode },
          result: {
            httpStatus: result.status,
            bytes,
            contentType: result.contentType,
            finalUrl: result.finalUrl,
          },
          costUsd: result.costUsd,
          requestId: result.requestId,
        },
        { [artifactName]: result.isBinary ? result.raw : result.body },
      );

      if (values.out) {
        writeOut(values.out as string, result.isBinary ? result.raw : result.body);
        log.success(`Wrote ${bytes} bytes → ${values.out}`);
      }

      log.success(`HTTP ${result.status} · ${bytes} bytes · cost $${(result.costUsd ?? 0).toFixed(4)} · run ${runId}`);
      if (runDir) log.dim(`  artifact: ${runDir}`);

      if (ctx.json || values.json) {
        log.out(JSON.stringify({ ok: true, runId, mode, httpStatus: result.status, bytes, costUsd: result.costUsd, requestId: result.requestId, finalUrl: result.finalUrl }, null, 2));
      } else if (!values.out) {
        if (result.isBinary) {
          // Never dump raw binary to the terminal — it corrupts the session and
          // is meaningless on screen. Tell the user how to capture it instead.
          log.info(`Binary ${opts.screenshot ? "screenshot" : "PDF"} response (${bytes} bytes). Re-run with --out <file> to save it.`);
        } else {
          log.out(result.body);
        }
      }
      await maybeNudgeClaim(config, {});
      return 0;
    } catch (err) {
      writeRun({
        runId,
        command: "zenrows fetch",
        capability: "protected_fetch",
        url,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "error",
        request: { url, manual: opts.manual },
        error: err instanceof ToolkitError ? err.toJSON() : { message: String(err) },
      });
      printError(err, ctx.json || values.json === true);
      return 1;
    }
  },
};

function normalizeOutput(v?: string): ResponseFormat | undefined {
  if (!v) return undefined;
  const map: Record<string, ResponseFormat> = {
    html: "html",
    md: "markdown",
    markdown: "markdown",
    text: "plaintext",
    plaintext: "plaintext",
    txt: "plaintext",
    pdf: "pdf",
  };
  return map[v.toLowerCase()];
}
