/**
 * `zenrows extract prepare <domain> --url <u> [--url <u>...] [--wait]` and
 * `zenrows extract prepare status <domain>`.
 *
 * The way out of REQS007: prepare the domain so `extract=auto` works on it.
 * Submitting returns at once; `--wait` polls until the preparation is ready or
 * failed (a few minutes). Costs no credits; each new domain uses one slot of the
 * account's monthly allowance.
 */
import { ensureApiKey } from "../../core/ensure-key.ts";
import { loadConfig } from "../../core/config.ts";
import { loadPolicy } from "../../core/policy.ts";
import { log } from "../../core/logger.ts";
import { ToolkitError } from "../../core/errors.ts";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_EXAMPLE_URLS,
  failureNextStep,
  getAllowance,
  getPreparedDomain,
  normalizeDomain,
  prepareDomain,
  statusNextStep,
  waitForPreparedDomain,
  type Allowance,
  type PreparedDomain,
  type PrepareRequestOpts,
} from "../../core/prepared-domains-api.ts";
import { parse, asString, type RunContext } from "../command.ts";
import { printError } from "../output.ts";

export const PREPARE_USAGE =
  "zenrows extract prepare <domain> --url <page-url> [--url <page-url>...] [--wait [--timeout <seconds>]]\n" +
  "       zenrows extract prepare status <domain>";

export const PREPARE_HELP = [
  "Prepare a domain so `zenrows extract <url>` (extract=auto) works on it. Use it after",
  "an extract fails with REQS007 (Extract hasn't prepared the domain yet).",
  "",
  `  --url <page-url>       1 to ${MAX_EXAMPLE_URLS} real pages you want to extract, one per kind of page (repeat --url)`,
  "  --wait                 poll until the domain is ready or failed (a few minutes); off by default",
  `  --timeout <seconds>    give up waiting after this long (default ${DEFAULT_WAIT_TIMEOUT_MS / 1000})`,
  "  status <domain>        show progress and the account's monthly allowance",
  "  --json                 structured result",
  "",
  "Costs no credits. Each new domain uses one slot of the account's monthly allowance.",
].join("\n");

/** Injectable for tests: network, sleep and clock. */
export interface PrepareDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  apiKey?: string;
}

export async function runPrepare(argv: string[], ctx: RunContext, deps: PrepareDeps = {}): Promise<number> {
  const isStatus = argv[0] === "status";
  const { values, positionals } = parse(isStatus ? argv.slice(1) : argv, {
    url: { type: "string", multiple: true },
    wait: { type: "boolean" },
    timeout: { type: "string" },
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  try {
    const raw = positionals[0];
    if (!raw) {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: "Missing domain.",
        likely_cause: "No <domain> was given.",
        next_action: `Usage: ${PREPARE_USAGE}`,
        suggested_commands: ["zenrows extract prepare example.com --url https://example.com/products/1"],
      });
    }
    const domain = normalizeDomain(raw);
    const urls = isStatus ? [] : validateUrls(values.url, domain);
    const timeoutMs = parseTimeout(asString(values.timeout));

    const policy = loadPolicy();
    const apiKey =
      deps.apiKey ??
      (await ensureApiKey(isStatus || values["no-signup"] ? { ...policy, auto_signup: false } : policy, {
        onProvision: (a) => {
          log.info("No API key found — created a Zenrows Free plan account for you.");
          log.dim(`Claim it anytime (keeps your usage): ${a.claimUrl}`);
        },
      }));
    const opts: PrepareRequestOpts = { apiKey, apiBase: loadConfig().apiBase, fetchImpl: deps.fetchImpl };

    if (isStatus) {
      const [record, allowance] = await Promise.all([getPreparedDomain(domain, opts), getAllowance(opts).catch(() => undefined)]);
      report(record, allowance, json);
      return 0;
    }

    log.step(`Prepare ${domain} for Extract (${urls.length} example URL${urls.length === 1 ? "" : "s"})…`);
    let record: PreparedDomain = await prepareDomain(domain, urls, opts);
    if (record.already_in_progress) log.info(`${domain} was already being prepared; following that preparation.`);
    if (values.wait === true && record.status !== "ready" && record.status !== "failed") {
      record = await waitForPreparedDomain(domain, {
        ...opts,
        timeoutMs,
        intervalMs: deps.intervalMs,
        sleepImpl: deps.sleepImpl,
        now: deps.now,
        onPoll: (r) => log.dim(`  ${r.domain}: ${r.status} (${r.state ?? r.status})`),
      });
    }
    if (record.status === "failed") {
      throw new ToolkitError({
        code: "EXTRACT_PREPARE_FAILED",
        message: `Preparing ${domain} failed${record.failure?.code ? ` (${record.failure.code})` : ""}.`,
        likely_cause: record.failure?.detail ?? "The preparation did not finish.",
        next_action: failureNextStep(domain, record.failure?.code),
        server_code: record.failure?.code,
      });
    }
    report(record, undefined, json, urls[0]);
    return 0;
  } catch (err) {
    printError(err, json);
    return 1;
  }
}

function validateUrls(raw: unknown, domain: string): string[] {
  const urls = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
  if (urls.length < 1 || urls.length > MAX_EXAMPLE_URLS) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Pass 1 to ${MAX_EXAMPLE_URLS} example page URLs with --url (got ${urls.length}).`,
      likely_cause: "Preparation learns the domain from real pages you want to extract.",
      next_action: "Add one --url per kind of page, e.g. a product page and a listing page.",
      suggested_commands: [`zenrows extract prepare ${domain} --url https://${domain}/<page>`],
    });
  }
  for (const u of urls) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(u);
    } catch {
      // reported below
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: `--url ${u} is not a full http(s) URL.`,
        likely_cause: "Each --url must be a page URL including its scheme.",
        next_action: `Use full URLs, e.g. --url https://${domain}/<page>.`,
      });
    }
  }
  return urls;
}

function parseTimeout(v?: string): number {
  if (v === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `--timeout must be a positive number of seconds (got ${v}).`,
      likely_cause: "The value is not a number.",
      next_action: "Pass seconds, e.g. --timeout 600.",
    });
  }
  return n * 1000;
}

function report(record: PreparedDomain, allowance: Allowance | undefined, json: boolean, exampleUrl?: string): void {
  const next = statusNextStep(record, exampleUrl);
  if (json) {
    log.out(JSON.stringify({ ok: true, ...record, ...(allowance ? { allowance } : {}), next }, null, 2));
    return;
  }
  const line = `${record.domain}: ${record.status}${record.state && record.state !== record.status ? ` (${record.state})` : ""}`;
  if (record.status === "ready") log.success(line);
  else if (record.status === "failed") log.warn(line);
  else log.info(line);
  if (record.failure) log.dim(`  failure: ${record.failure.code}${record.failure.detail ? ` — ${record.failure.detail}` : ""}`);
  for (const role of record.roles ?? []) log.dim(`  ${role.role}: ${role.status}${role.url ? ` ${role.url}` : ""}`);
  if (allowance) log.dim(`  allowance: ${allowance.used} of ${allowance.limit} used, ${allowance.remaining} left${allowance.month ? ` (${allowance.month})` : ""}`);
  log.out(next);
}
