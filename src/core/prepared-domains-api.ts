/**
 * Client for Extract's prepared-domains API.
 *
 * `extract=auto` answers REQS007 on a domain Extract has not prepared yet. Preparing
 * it is a call any key can make: `POST {apiBase}/extract/prepared-domains` with the
 * domain and 1 to 5 example URLs answers 202 at once; the preparation itself takes a
 * few minutes and costs no credits. `GET .../{domain}` reports progress and
 * `GET .../allowance` the account's monthly allowance of new domains. Auth is the
 * `X-API-Key` header; errors are problem+json and we branch on `status` + `code`.
 * `fetchImpl` / `sleepImpl` / `now` are injectable for tests.
 */
import { ToolkitError } from "./errors.ts";
import { registerSecret } from "./logger.ts";
import { CLI_USER_AGENT, loadConfig } from "./config.ts";
import { agentClientHeader } from "./agent-client.ts";

export const MAX_EXAMPLE_URLS = 5;
/** How often `--wait` polls, and for how long by default. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;

/** status: preparing | ready | failed. state adds the step (received, discovering, preparing, verifying). */
export interface PreparedDomain {
  domain: string;
  status: string;
  state?: string;
  roles?: { role: string; status: string; url?: string; detail?: string }[];
  failure?: { code: string; detail?: string; slot_consumed?: boolean };
  submitted_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface Allowance {
  used: number;
  limit: number;
  remaining: number;
  month?: string;
  [k: string]: unknown;
}

export interface PrepareRequestOpts {
  apiKey: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The domain as the API keys it: host only, no scheme, path or leading `www.`.
 * Accepts a URL.
 *
 * Deliberately not the registrable domain: Extract prepares and serves each host
 * on its own. A prepared `es.wikipedia.org` does not cover `pt.wikipedia.org`
 * (REQS007 names `pt.wikipedia.org`), and `wikipedia.org` has no record of its
 * own. The API itself folds `www.` into the bare host, so dropping it here
 * matches what it stores.
 */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim();
  let host = trimmed;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    // Left as given: the API answers invalid_argument with the reason.
  }
  return host.toLowerCase().replace(/^www\./, "");
}

/** The exact command an agent runs to prepare the domain of `url`. */
export function prepareCommand(url: string): string {
  return `zenrows extract prepare ${normalizeDomain(url)} --url ${url}`;
}

function base(opts: PrepareRequestOpts): string {
  return (opts.apiBase ?? loadConfig().apiBase).replace(/\/+$/, "");
}

async function request<T>(method: "GET" | "POST", path: string, domain: string, opts: PrepareRequestOpts & { body?: unknown }): Promise<T> {
  registerSecret(opts.apiKey);
  const headers: Record<string, string> = {
    "X-API-Key": opts.apiKey,
    Accept: "application/json",
    "User-Agent": CLI_USER_AGENT,
    ...agentClientHeader(),
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${base(opts)}/extract/prepared-domains${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new ToolkitError({
      code: "BACKEND_UNAVAILABLE",
      message: "Could not reach the Zenrows API.",
      likely_cause: err instanceof Error ? err.message : String(err),
      next_action: "Check connectivity and retry. Verify the api base in `zenrows config show`.",
      suggested_commands: ["zenrows status", "zenrows config show"],
    });
  }
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) throw prepareError(res.status, text, domain);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolkitError({
      code: "EXTRACT_PREPARE_FAILED",
      message: "The prepared-domains API returned a non-JSON answer.",
      likely_cause: text.slice(0, 200),
      next_action: "Retry in a minute.",
    });
  }
}

/** Map a non-2xx prepared-domains answer to an error that names the next step. */
export function prepareError(status: number, body: string, domain: string): ToolkitError {
  let p: Record<string, unknown> = {};
  try {
    p = (JSON.parse(body) as Record<string, unknown>) ?? {};
  } catch {
    // not problem+json
  }
  const code = typeof p.code === "string" ? p.code.toLowerCase() : undefined;
  const detail = typeof p.detail === "string" ? p.detail : body.slice(0, 200) || `HTTP ${status}`;
  const cause = code ? `(${code}) ${detail}` : detail;
  if (code === "invalid_argument" || status === 400) {
    return new ToolkitError({
      code: "EXTRACT_PREPARE_INVALID",
      message: `The request to prepare ${domain} was rejected.`,
      likely_cause: p.reason ? `${cause} [reason: ${String(p.reason)}]` : cause,
      next_action: `Pass the domain without scheme or path, and 1 to ${MAX_EXAMPLE_URLS} full page URLs from that site with --url.`,
      suggested_commands: [`zenrows extract prepare ${domain} --url https://${domain}/<page>`],
      server_code: code,
    });
  }
  if (code === "not_found" || status === 404) {
    return new ToolkitError({
      code: "EXTRACT_PREPARE_NOT_FOUND",
      message: `This account has not submitted ${domain} for preparation.`,
      likely_cause: cause,
      next_action: `Prepare it first: zenrows extract prepare ${domain} --url <page url> (1 to ${MAX_EXAMPLE_URLS} --url).`,
      suggested_commands: [`zenrows extract prepare ${domain} --url https://${domain}/<page>`],
      server_code: code,
    });
  }
  if (code === "in_progress") {
    return new ToolkitError({
      code: "EXTRACT_PREPARE_IN_PROGRESS",
      message: `${domain} is already being prepared.`,
      likely_cause: cause,
      next_action: "Do not resubmit. Retry the extract in a few minutes.",
      suggested_commands: [`zenrows extract prepare status ${domain}`],
      server_code: code,
    });
  }
  if (code === "idempotency_conflict") {
    return new ToolkitError({
      code: "EXTRACT_PREPARE_INVALID",
      message: "This idempotency key was already used with a different request.",
      likely_cause: cause,
      next_action: "Retry without the key, or with a new one.",
      server_code: code,
    });
  }
  if (code === "out_of_allowance" || status === 429) {
    const used = p.used !== undefined && p.limit !== undefined ? ` (${String(p.used)} of ${String(p.limit)} used)` : "";
    return new ToolkitError({
      code: "EXTRACT_PREPARE_OUT_OF_ALLOWANCE",
      message: `This account has used its monthly allowance of new domains to prepare${used}.`,
      likely_cause: cause,
      next_action: "Do not retry this month. Meanwhile extract this domain with --css and explicit selectors.",
      suggested_commands: [`zenrows extract <url> --css '{"title":"h1"}'`],
      server_code: code,
    });
  }
  if (code === "overloaded" || code === "disabled" || status === 503) {
    return new ToolkitError({
      code: "EXTRACT_PREPARE_UNAVAILABLE",
      message: "Domain preparation is unavailable right now.",
      likely_cause: cause,
      next_action: "Retry in a few minutes; do not loop. Meanwhile extract with --css and explicit selectors.",
      server_code: code,
    });
  }
  if (status === 401 || status === 403) {
    return new ToolkitError({
      code: "AUTH_INVALID",
      message: "Zenrows rejected the API key.",
      likely_cause: cause,
      next_action: "Re-check your key and log in again.",
      suggested_commands: ["zenrows login --api-key <your-key>"],
      server_code: code,
    });
  }
  return new ToolkitError({
    code: "EXTRACT_PREPARE_FAILED",
    message: `Preparing ${domain} failed with HTTP ${status}.`,
    likely_cause: cause,
    next_action: "Retry in a few minutes.",
    server_code: code,
  });
}

export function submitPreparedDomain(
  domain: string,
  exampleUrls: string[],
  opts: PrepareRequestOpts,
): Promise<PreparedDomain> {
  return request<PreparedDomain>("POST", "", domain, { ...opts, body: { domain, example_urls: exampleUrls } });
}

export function getPreparedDomain(domain: string, opts: PrepareRequestOpts): Promise<PreparedDomain> {
  return request<PreparedDomain>("GET", `/${encodeURIComponent(domain)}`, domain, opts);
}

export function getAllowance(opts: PrepareRequestOpts): Promise<Allowance> {
  return request<Allowance>("GET", "/allowance", "", opts);
}

/**
 * Submit a domain. A 409 in_progress (already being prepared) answers with the
 * current status when this account can read it, so the caller just follows it.
 */
export async function prepareDomain(
  domain: string,
  exampleUrls: string[],
  opts: PrepareRequestOpts,
): Promise<PreparedDomain & { already_in_progress?: boolean }> {
  try {
    return await submitPreparedDomain(domain, exampleUrls, opts);
  } catch (err) {
    if (!(err instanceof ToolkitError) || err.code !== "EXTRACT_PREPARE_IN_PROGRESS") throw err;
    try {
      return { ...(await getPreparedDomain(domain, opts)), already_in_progress: true };
    } catch {
      throw err;
    }
  }
}

export function isTerminal(record: PreparedDomain): boolean {
  return record.status === "ready" || record.status === "failed";
}

/** Poll until ready or failed. Throws EXTRACT_PREPARE_TIMEOUT when the wait runs out. */
export async function waitForPreparedDomain(
  domain: string,
  opts: PrepareRequestOpts & {
    intervalMs?: number;
    timeoutMs?: number;
    sleepImpl?: (ms: number) => Promise<void>;
    now?: () => number;
    onPoll?: (record: PreparedDomain) => void;
  },
): Promise<PreparedDomain> {
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = now() + (opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  for (;;) {
    const record = await getPreparedDomain(domain, opts);
    opts.onPoll?.(record);
    if (isTerminal(record)) return record;
    if (now() + interval > deadline) {
      throw new ToolkitError({
        code: "EXTRACT_PREPARE_TIMEOUT",
        message: `${domain} is still being prepared (state: ${record.state ?? record.status}).`,
        likely_cause: "Preparation usually takes a few minutes; this one is taking longer than the wait.",
        next_action: "Check again later; it keeps running on the server.",
        suggested_commands: [`zenrows extract prepare status ${domain}`],
      });
    }
    await sleep(interval);
  }
}

/** Whether a failed preparation used an allowance slot, from the record's failure.slot_consumed. */
function slotSentence(slotConsumed: boolean | undefined): string {
  if (slotConsumed === true) return " This attempt used an allowance slot.";
  if (slotConsumed === false) return " This attempt did not use an allowance slot.";
  return "";
}

/** What to do after a failed preparation, by failure.code (docs.zenrows.com extract/endpoints). */
export function failureNextStep(domain: string, failure: PreparedDomain["failure"]): string {
  let step: string;
  switch (failure?.code) {
    case "interrupted":
    case "preparation_exhausted":
      step = `Run the same zenrows extract prepare ${domain} command again.`;
      break;
    case "discovery_failed":
      step = `Run zenrows extract prepare ${domain} again with 1 to ${MAX_EXAMPLE_URLS} --url page URLs.`;
      break;
    case "unpreparable":
      step = `Run zenrows extract prepare ${domain} again with different --url pages from the same site; the same URLs fail again.`;
      break;
    case "preparation_failed":
      step = "Try other --url pages, or contact Zenrows support.";
      break;
    default:
      step = "Contact Zenrows support before preparing this domain again. Meanwhile extract with --css.";
  }
  return step + slotSentence(failure?.slot_consumed);
}

/**
 * What to do when a page on a prepared domain answers REQS007 with reason
 * page_not_recognised, in the gateway's own order. On a prepared domain Extract
 * learns a new kind of page on its first request, so that answer means this page
 * is not one Extract extracts (a page with nothing to extract, such as a home page) or a
 * transient failure kept it from trying, never that the domain needs preparing
 * again: resubmitting returns the existing ready record, so pointing there would
 * loop.
 */
export const PAGE_NOT_RECOGNISED_STEPS =
  "Try a product, article or listing page on the same site instead. If this page should work, retry it once in a few minutes; do not retry in a loop. Otherwise use --css with explicit selectors. Preparing the domain again does not change this.";

/** Said once a domain is ready, so a user who then meets EXTRACT_PAGE_NOT_RECOGNISED does not resubmit. */
const IF_PAGE_NOT_RECOGNISED = `If the extract then fails with EXTRACT_PAGE_NOT_RECOGNISED, Extract did not recognise that page. ${PAGE_NOT_RECOGNISED_STEPS}`;

/**
 * The next step for a status record. `alreadyReady` is set when a submit answered
 * ready at once: the domain was prepared before this call.
 */
export function statusNextStep(record: PreparedDomain, opts: { exampleUrl?: string; alreadyReady?: boolean } = {}): string {
  if (record.status === "ready") {
    const extract = opts.exampleUrl ? ` (\`zenrows extract ${opts.exampleUrl}\`)` : "";
    if (opts.alreadyReady) return `${record.domain} is already prepared, so nothing new was submitted: run the extract${extract}. ${IF_PAGE_NOT_RECOGNISED}`;
    return `${record.domain} is ready: run the extract again${extract}. ${IF_PAGE_NOT_RECOGNISED}`;
  }
  if (record.status === "failed") return failureNextStep(record.domain, record.failure);
  return `Preparing; it takes a few minutes. Check about every 30 seconds with: zenrows extract prepare status ${record.domain}`;
}
