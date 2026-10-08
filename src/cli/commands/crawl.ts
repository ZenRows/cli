/**
 * `zenrows crawl` — Crawl API.
 *
 * Give Crawl one start URL and read back the URLs it finds behind it, optionally
 * with each page's HTML. A crawl is an async job: `start` returns at once
 * (or polls with `--follow`), then `status` / `wait` / `results` / `content`
 * read it and `stop` ends it. An account without Crawl access gets 403 REQS008
 * → CRAWL_NOT_ENABLED.
 */
import { log } from "../../core/logger.ts";
import { requireApiKey } from "../../core/auth.ts";
import { ensureApiKey } from "../../core/ensure-key.ts";
import { assertUsable } from "../../core/capabilities.ts";
import { assertDomainAllowed, assertWithinLimits, loadPolicy } from "../../core/policy.ts";
import { newRunId, writeRun } from "../../core/artifacts.ts";
import {
  contentIdOf,
  createCrawl,
  downloadCrawl,
  getCrawl,
  getCrawlContent,
  listAllResults,
  listCrawls,
  stopCrawl,
  waitForCrawl,
  type Crawl,
  type CrawlStop,
  type CreateCrawlParams,
} from "../../core/crawl-api.ts";
import { asNumber, asString, parse, type Command, type RunContext } from "../command.ts";
import { ToolkitError } from "../../core/errors.ts";
import { printError, writeOut } from "../output.ts";
import { normalizeTimeout } from "./fetch.ts";

/** The API's default for `max_pages` (and `max_items`) when the flag is unset. */
const DEFAULT_MAX_PAGES = 10;
/** Largest `depth` / `max_items` / `max_pages` the API takes. */
const MAX_LIMIT = 100_000;

export const crawl: Command = {
  name: "crawl",
  summary: "Crawl a site from one start URL and collect the URLs behind it.",
  usage:
    "zenrows crawl <start <url> --depth N|status <id>|results <id>|content <id> <content_id>|list|stop <id>|wait <id>>",
  help: [
    "Cloud (needs a key with Crawl access):",
    "  start <url> --depth <n> [flags]  start a crawl from one URL (returns at once)",
    "    --depth <n>                    link hops to follow from the start URL (1-100000, required)",
    "    --max-items <n>                stop after keeping n URLs (API default 10)",
    "    --max-pages <n>                stop after fetching n pages (API default 10; bounds cost)",
    "    --include <pattern>            keep only URLs containing this substring (repeatable)",
    "    --exclude <pattern>            drop URLs containing this substring (repeatable)",
    "    --html                         also fetch each kept URL's page HTML (read with `content`)",
    "    --follow                       poll until the crawl ends (alias: --wait)",
    "    --timeout <ms>                 with --follow: give up waiting after ms (default 600000)",
    "    --idempotency-key <key>        make a retried start create no second crawl",
    "    --no-signup                    do not auto-create a Free plan account if no key exists",
    "  status <id>                      show status, coverage, stop reason / error",
    "  wait <id> [--timeout <ms>]       poll until the crawl ends (it is not stopped on timeout)",
    "  results <id>                     all kept URLs (crawl must have ended); paginated",
    "    --out <file>                   write results as JSONL instead of printing",
    "    --cursor <c> [--limit <n>]     read one page only (works while running; prints next_cursor)",
    "    --download                     fetch the NDJSON export (with page HTML for --html crawls)",
    "                                   into --out, or <id>.jsonl",
    "  content <id> <content_id>        print one kept URL's page (content_id or content_url)",
    "    --out <file>                   write it to a file instead",
    "  list [--limit <n>] [--cursor c]  list your crawls, newest first",
    "  stop <id>                        stop a running crawl (idempotent)",
    "  --json                           print structured output",
  ].join("\n"),
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const [sub, ...rest] = argv;
    try {
      switch (sub) {
        case "start":
          return await startCmd(rest, ctx);
        case "status":
          return await statusCmd(rest, ctx);
        case "wait":
          return await waitCmd(rest, ctx);
        case "results":
          return await resultsCmd(rest, ctx);
        case "content":
          return await contentCmd(rest, ctx);
        case "list":
          return await listCmd(rest, ctx);
        case "stop":
          return await stopCmd(rest, ctx);
        default:
          throw new ToolkitError({
            code: "INVALID_USAGE",
            message: `Unknown crawl subcommand: ${sub ?? "(none)"}`,
            likely_cause: "Subcommand not recognized.",
            next_action:
              "Use start <url> --depth N | status <id> | wait <id> | results <id> | content <id> <content_id> | list | stop <id>.",
            suggested_commands: ["zenrows crawl --help"],
          });
      }
    } catch (err) {
      printError(err, ctx.json);
      return 1;
    }
  },
};

async function startCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    depth: { type: "string" },
    "max-items": { type: "string" },
    "max-pages": { type: "string" },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    html: { type: "boolean" },
    follow: { type: "boolean" },
    wait: { type: "boolean" }, // alias for --follow
    timeout: { type: "string" },
    "idempotency-key": { type: "string" },
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  const follow = values.follow === true || values.wait === true;
  const url = positionals[0];
  if (!url) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Provide the start URL.",
      likely_cause: "No <url> positional was given.",
      next_action: "Usage: zenrows crawl start <url> --depth 1",
      suggested_commands: ["zenrows crawl start https://example.com/ --depth 1"],
    });
  }
  const depth = limitFlag("depth", values.depth);
  if (depth === undefined) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "--depth is required.",
      likely_cause: "Crawl has no default depth yet; every crawl states how many link hops to follow.",
      next_action: "Pass --depth 1 to collect the start page's links, --depth 2 to also open each of those.",
      suggested_commands: [`zenrows crawl start ${url} --depth 1`],
    });
  }
  const params: CreateCrawlParams = { url, depth };
  const maxItems = limitFlag("max-items", values["max-items"]);
  if (maxItems !== undefined) params.max_items = maxItems;
  const maxPages = limitFlag("max-pages", values["max-pages"]);
  if (maxPages !== undefined) params.max_pages = maxPages;
  const include = patterns(values.include);
  if (include.length) params.include_patterns = include;
  const exclude = patterns(values.exclude);
  if (exclude.length) params.exclude_patterns = exclude;
  if (values.html === true) params.output_format = "html";
  const timeoutMs = normalizeTimeout(values.timeout);
  const idempotencyKey = asString(values["idempotency-key"]);

  assertUsable("crawl");

  // Pre-flight governance, all local: the start URL must pass the domain policy,
  // and max_pages (each page is one fetch) must fit the per-run page cap.
  const policy = loadPolicy();
  assertDomainAllowed(url, policy);
  assertWithinLimits({ pages: maxPages ?? DEFAULT_MAX_PAGES }, policy, "crawl");

  const apiKey = await ensureApiKey(values["no-signup"] ? { ...policy, auto_signup: false } : policy, {
    onProvision: (a) => {
      log.info("No API key found — created a Zenrows Free plan account for you.");
      log.dim(`Claim it anytime (keeps your usage): ${a.claimUrl}`);
    },
  });

  const runId = newRunId();
  const startedAt = new Date().toISOString();
  log.step(`Starting crawl of ${url} (depth ${depth})…`);
  try {
    const created = await createCrawl(params, { apiKey, idempotencyKey });
    const finished: Crawl = follow ? await waitForCrawl(created.crawl_id, { apiKey, timeoutMs }) : created;
    const failure = crawlFailure(finished);
    const runDir = writeRun({
      runId,
      command: "zenrows crawl start",
      capability: "crawl",
      url,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: failure ? "error" : "ok",
      request: { ...params },
      result: { crawlId: created.crawl_id, status: finished.status, coverage: finished.coverage },
      ...(failure ? { error: failure.toJSON() } : {}),
    });
    const code = printCrawl(finished, json, `Started crawl ${created.crawl_id}`);
    if (!json) {
      if (runDir) log.dim(`  artifact: ${runDir}`);
      if (!follow) log.dim(`  next: zenrows crawl wait ${created.crawl_id}`);
    }
    return code;
  } catch (err) {
    writeRun({
      runId,
      command: "zenrows crawl start",
      capability: "crawl",
      url,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "error",
      request: { ...params },
      error: err instanceof ToolkitError ? err.toJSON() : { message: String(err) },
    });
    throw err;
  }
}

async function statusCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { json: { type: "boolean" } });
  const id = requireId(positionals[0], "status");
  assertUsable("crawl");
  const apiKey = requireApiKey();
  const c = await getCrawl(id, { apiKey, limit: 1 });
  return printCrawl(c, ctx.json || values.json === true, `Crawl ${id}`);
}

async function waitCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { timeout: { type: "string" }, json: { type: "boolean" } });
  const id = requireId(positionals[0], "wait");
  const timeoutMs = normalizeTimeout(values.timeout);
  assertUsable("crawl");
  const apiKey = requireApiKey();
  const c = await waitForCrawl(id, { apiKey, timeoutMs });
  return printCrawl(c, ctx.json || values.json === true, `Crawl ${id} finished`);
}

async function resultsCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    out: { type: "string" },
    cursor: { type: "string" },
    limit: { type: "string" },
    download: { type: "boolean" },
    json: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "results");
  const outFile = asString(values.out);
  const cursor = asString(values.cursor);
  const limit = pageLimit(values.limit, 10_000);
  assertUsable("crawl");
  const apiKey = requireApiKey();

  if (values.download === true) {
    const file = outFile ?? `${id.replace(/[^A-Za-z0-9._-]+/g, "_")}.jsonl`;
    const { crawlStatus, ndjson } = await downloadCrawl(id, { apiKey });
    writeOut(file, ndjson);
    const lines = ndjson.split("\n").filter((l) => l.trim()).length;
    const partial = crawlStatus === "running";
    if (json) {
      log.out(JSON.stringify({ ok: true, crawlId: id, crawlStatus, partial, count: lines, file }, null, 2));
    } else {
      log.success(`Downloaded ${lines} result(s) → ${file}`);
      if (partial) log.warn("  The crawl is still running: this file is partial. Download again once it ends.");
    }
    return 0;
  }

  // One page, as the API returns it — the way to follow a crawl while it runs.
  if (cursor !== undefined || limit !== undefined) {
    const page = await getCrawl(id, { apiKey, cursor, limit });
    const body = { ok: true, crawlId: id, status: page.status, count: page.results.length, results: page.results, next_cursor: page.next_cursor };
    if (outFile) {
      writeOut(outFile, toJsonl(page.results));
      log.success(`Wrote ${page.results.length} result(s) → ${outFile}`);
      log.info(`next_cursor: ${page.next_cursor ?? "null (last page)"}`);
    } else if (json) {
      log.out(JSON.stringify(body, null, 2));
    } else {
      log.info(`${page.results.length} result(s) for crawl ${id} (status: ${page.status}):`);
      log.out(toJsonl(page.results).trimEnd());
      log.info(`next_cursor: ${page.next_cursor ?? "null (last page)"}`);
    }
    return 0;
  }

  const { crawl: c, results } = await listAllResults(id, { apiKey });
  if (outFile) {
    writeOut(outFile, toJsonl(results));
    log.success(`Wrote ${results.length} result(s) → ${outFile}`);
  } else if (json) {
    log.out(JSON.stringify({ ok: true, crawlId: id, status: c.status, count: results.length, results }, null, 2));
  } else {
    log.info(`${results.length} result(s) for crawl ${id} (status: ${c.status}):`);
    log.out(toJsonl(results).trimEnd());
  }
  return 0;
}

async function contentCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { out: { type: "string" }, json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "content");
  const ref = positionals[1];
  // Accept the content id or the result's whole content_url.
  const contentId = ref ? (contentIdOf({ url: "", content_url: ref }) ?? ref) : undefined;
  if (!contentId) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Missing content id.",
      likely_cause: "No <content_id> positional was provided.",
      next_action:
        "Pass the id from a fetched result's content_url (the last path segment), e.g. `zenrows crawl content <id> ct_…`. Only crawls started with --html have content.",
      suggested_commands: [`zenrows crawl results ${id}`],
    });
  }
  assertUsable("crawl");
  const apiKey = requireApiKey();
  const { contentType, body } = await getCrawlContent(id, contentId, { apiKey });
  const outFile = asString(values.out);
  if (outFile) {
    writeOut(outFile, body);
    if (json) {
      log.out(JSON.stringify({ ok: true, crawlId: id, contentId, contentType, bytes: Buffer.byteLength(body), file: outFile }, null, 2));
    } else {
      log.success(`Wrote ${Buffer.byteLength(body)} bytes (${contentType || "unknown type"}) → ${outFile}`);
    }
  } else if (json) {
    log.out(JSON.stringify({ ok: true, crawlId: id, contentId, contentType, bytes: Buffer.byteLength(body), content: body }, null, 2));
  } else {
    log.out(body);
  }
  return 0;
}

async function listCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values } = parse(rest, { limit: { type: "string" }, cursor: { type: "string" }, json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const limit = pageLimit(values.limit, 100);
  const cursor = asString(values.cursor);
  assertUsable("crawl");
  const apiKey = requireApiKey();
  const page = await listCrawls({ apiKey, limit, cursor });
  const crawls = page.crawls ?? [];
  if (json) {
    log.out(JSON.stringify({ ok: true, count: crawls.length, crawls, next_cursor: page.next_cursor ?? null }, null, 2));
    return 0;
  }
  if (!crawls.length) log.info("No crawls.");
  for (const c of crawls) {
    const cov = c.coverage;
    log.out(
      `${c.crawl_id}  ${c.status.padEnd(9)}  ${c.created_at}  ${cov ? `${cov.items_found} items/${cov.pages_fetched} pages` : ""}  ${c.url}`,
    );
  }
  if (page.next_cursor) log.dim(`  more: zenrows crawl list --cursor ${page.next_cursor}`);
  return 0;
}

async function stopCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { json: { type: "boolean" } });
  const id = requireId(positionals[0], "stop");
  assertUsable("crawl");
  const apiKey = requireApiKey();
  const s = await stopCrawl(id, { apiKey });
  return printCrawl(s, ctx.json || values.json === true, `Stopped crawl ${id}`);
}

/**
 * The error for a crawl that ended `failed`, or null for any other state. The
 * crawl's own `error.code` picks the next action.
 */
export function crawlFailure(c: Crawl | CrawlStop): ToolkitError | null {
  if (c.status !== "failed") return null;
  const code = c.error?.code;
  const why = [code, c.error?.detail].filter(Boolean).join(": ");
  const next: Record<string, string> = {
    insufficient_credits: "The account ran out of credits. Check `zenrows usage`, add credits, then start a new crawl.",
    seed_unreachable: "The start URL could not be fetched (the site may be blocking it). Check it with `zenrows fetch <url>`.",
    no_items_found:
      "Nothing matched. Loosen --include / --exclude, raise --depth, or check the start page with `zenrows fetch <url>`.",
  };
  return new ToolkitError({
    code: "CRAWL_FAILED",
    message: `Crawl ${c.crawl_id} failed.`,
    likely_cause: why || "The crawl ended in status failed without a reason.",
    next_action: (code && next[code]) || "Read the error, fix the cause, then start a new crawl.",
    suggested_commands: [`zenrows crawl status ${c.crawl_id}`],
  });
}

/**
 * Print a crawl (or a stop answer), structured under --json, and return the exit
 * code: 1 when it ended `failed`, else 0. `stopped` is a deliberate outcome, so
 * it exits 0 but prints as a warning.
 */
function printCrawl(c: Crawl | CrawlStop, json: boolean, headline: string): number {
  const err = crawlFailure(c);
  const crawlFields = { ...c } as Record<string, unknown>;
  // A status read asks for one result to keep polls cheap; that page is not "the results".
  delete crawlFields.results;
  delete crawlFields.next_cursor;
  if (json) {
    log.out(
      JSON.stringify(
        {
          ok: !err,
          crawlId: c.crawl_id,
          status: c.status,
          ...(c.stop_reason ? { stop_reason: c.stop_reason } : {}),
          crawl: crawlFields,
          ...(err ? { error: err.toJSON() } : {}),
        },
        null,
        2,
      ),
    );
    return err ? 1 : 0;
  }
  const line = `${headline} · status: ${c.status ?? "unknown"}${c.stop_reason ? ` (${c.stop_reason})` : ""}`;
  if (err) log.error(line);
  else if (c.status === "stopped") log.warn(line);
  else log.success(line);
  const cov = (c as Crawl).coverage;
  if (cov) {
    log.info(`  ${cov.items_found} item(s) found · ${cov.pages_fetched} page(s) fetched · ${cov.pages_failed} failed`);
  }
  if (err) printError(err, false);
  return err ? 1 : 0;
}

/** A positive integer flag up to the API's 100,000 ceiling; undefined when unset. */
function limitFlag(name: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = asNumber(v);
  if (n === undefined || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Invalid --${name} value '${String(v)}'.`,
      likely_cause: `--${name} takes a whole number from 1 to ${MAX_LIMIT}.`,
      next_action: `Pass e.g. --${name} ${name === "depth" ? 1 : 10}.`,
    });
  }
  return n;
}

/** `--limit` for a paged read: a whole number from 1 to `max`. */
function pageLimit(v: unknown, max: number): number | undefined {
  if (v === undefined) return undefined;
  const n = asNumber(v);
  if (n === undefined || !Number.isInteger(n) || n < 1 || n > max) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Invalid --limit value '${String(v)}'.`,
      likely_cause: `--limit takes a whole number from 1 to ${max}.`,
      next_action: `Pass e.g. --limit ${Math.min(max, 100)}.`,
    });
  }
  return n;
}

function patterns(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return list.filter((p): p is string => typeof p === "string" && p.length > 0);
}

function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

function requireId(id: string | undefined, sub: string): string {
  if (id) return id;
  throw new ToolkitError({
    code: "INVALID_USAGE",
    message: "Missing crawl id.",
    likely_cause: "No <id> positional was provided.",
    next_action: `Usage: zenrows crawl ${sub} <id>. List your crawls with \`zenrows crawl list\`.`,
    suggested_commands: ["zenrows crawl list"],
  });
}
