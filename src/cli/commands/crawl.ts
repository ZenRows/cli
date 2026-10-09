/**
 * `zenrows crawl` — Crawl API (status: beta).
 *
 * Give Crawl one start URL and read back the URLs it finds behind it, optionally
 * with each page's HTML. A crawl is an async job: `create` returns at once
 * (or waits with `--follow`), then `get` / `wait` / `results` / `content` /
 * `download` read it and `stop` ends it. An account without Crawl access gets
 * 403 REQS008 → CRAWL_NOT_ENABLED.
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
  isTerminal,
  listAllResults,
  listCrawls,
  stopCrawl,
  waitForCrawl,
  type Crawl,
  type CrawlResult,
  type CrawlStop,
  type CreateCrawlParams,
} from "../../core/crawl-api.ts";
import { asNumber, asString, parse, type Command, type RunContext } from "../command.ts";
import { ToolkitError } from "../../core/errors.ts";
import { printError, writeOut } from "../output.ts";

/** The API's default for `max_pages` (and `max_items`) when the flag is unset. */
const DEFAULT_MAX_PAGES = 10;
/** Largest `depth` / `max_items` / `max_pages` the API takes. */
const MAX_LIMIT = 100_000;

export const crawl: Command = {
  name: "crawl",
  summary: "Crawl a site from one start URL and collect the URLs behind it (beta).",
  usage:
    "zenrows crawl <create <url> --depth N|get <id>|list|results <id>|content <id> <content_id>|download <id>|stop <id>|wait <id>>",
  help: [
    "Crawl is in beta. Cloud (needs a key with Crawl access):",
    "  create <url> --depth <n> [flags]  start a crawl from one URL (returns at once)",
    "    --depth <n>                     link hops to follow from the start URL (1-100000, required)",
    "    --max-items <n>                 stop after keeping n URLs (API default 10)",
    "    --max-pages <n>                 stop after fetching n pages (API default 10; bounds cost);",
    "                                    the local policy max_pages_per_run caps it (default 1000)",
    "    --include-pattern <p>           keep only URLs containing this substring (repeatable)",
    "    --exclude-pattern <p>           drop URLs containing this substring (repeatable)",
    "    --output-format html            also fetch each kept URL's page HTML (read with content/download);",
    "                                    each kept page is one more fetch counted by --max-pages",
    "    --follow                        wait until the crawl ends (Ctrl-C stops the wait, not the crawl)",
    "    --timeout <s>                   with --follow: stop waiting after s seconds (default 600)",
    "    --idempotency-key <key>         so a retried create starts no second crawl",
    "    --no-signup                     do not auto-create a Free plan account if no key exists",
    "  get <id> [--cursor <c>] [--limit <n>]",
    "                                    the crawl and one page of its results (limit up to 10000)",
    "  list [--cursor <c>] [--limit <n>] your crawls, newest first (limit up to 100)",
    "  results <id> [--limit <n>]        every kept URL as JSONL; on a running crawl, those kept so far",
    "                                    (partial). --limit is the page size per request",
    "    --out <file>                    write the results to a file instead of printing",
    "  content <id> <content_id>         print one kept URL's page (content_id or content_url)",
    "    --out <file>                    write it to a file instead",
    "  download <id> [--out <file>]      save the NDJSON export (with page HTML for html crawls),",
    "                                    default <id>.jsonl; partial while the crawl runs",
    "  stop <id>                         stop a running crawl (an ended crawl answers as it ended)",
    "  wait <id> [--timeout <s>]         poll until the crawl ends or s seconds (default 600) run out;",
    "                                    a crawl still running then is printed, not stopped",
    "  --json                            print structured output",
  ].join("\n"),
  async run(argv: string[], ctx: RunContext): Promise<number> {
    const [sub, ...rest] = argv;
    try {
      switch (sub) {
        case "create":
          return await createCmd(rest, ctx);
        case "get":
          return await getCmd(rest, ctx);
        case "list":
          return await listCmd(rest, ctx);
        case "results":
          return await resultsCmd(rest, ctx);
        case "content":
          return await contentCmd(rest, ctx);
        case "download":
          return await downloadCmd(rest, ctx);
        case "stop":
          return await stopCmd(rest, ctx);
        case "wait":
          return await waitCmd(rest, ctx);
        default:
          throw new ToolkitError({
            code: "INVALID_USAGE",
            message: `Unknown crawl subcommand: ${sub ?? "(none)"}`,
            likely_cause: "Subcommand not recognized.",
            next_action:
              "Use create <url> --depth N | get <id> | list | results <id> | content <id> <content_id> | download <id> | stop <id> | wait <id>.",
            suggested_commands: ["zenrows crawl --help"],
          });
      }
    } catch (err) {
      printError(err, ctx.json);
      return 1;
    }
  },
};

async function createCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    depth: { type: "string" },
    "max-items": { type: "string" },
    "max-pages": { type: "string" },
    "include-pattern": { type: "string", multiple: true },
    "exclude-pattern": { type: "string", multiple: true },
    "output-format": { type: "string" },
    follow: { type: "boolean" },
    timeout: { type: "string" },
    "idempotency-key": { type: "string" },
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  const url = positionals[0];
  if (!url) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Provide the start URL.",
      likely_cause: "No <url> positional was given.",
      next_action: "Usage: zenrows crawl create <url> --depth 1",
      suggested_commands: ["zenrows crawl create https://example.com/ --depth 1"],
    });
  }
  const depth = limitFlag("depth", values.depth);
  if (depth === undefined) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "--depth is required.",
      likely_cause: "Crawl has no default depth yet; every crawl states how many link hops to follow.",
      next_action: "Pass --depth 1 to collect the start page's links, --depth 2 to also open each of those.",
      suggested_commands: [`zenrows crawl create ${url} --depth 1`],
    });
  }
  const params: CreateCrawlParams = { url, depth };
  const maxItems = limitFlag("max-items", values["max-items"]);
  if (maxItems !== undefined) params.max_items = maxItems;
  const maxPages = limitFlag("max-pages", values["max-pages"]);
  if (maxPages !== undefined) params.max_pages = maxPages;
  const include = patterns(values["include-pattern"]);
  if (include.length) params.include_patterns = include;
  const exclude = patterns(values["exclude-pattern"]);
  if (exclude.length) params.exclude_patterns = exclude;
  const outputFormat = asString(values["output-format"]);
  if (outputFormat !== undefined) {
    if (outputFormat !== "html") {
      throw new ToolkitError({
        code: "INVALID_USAGE",
        message: `Invalid --output-format value '${outputFormat}'.`,
        likely_cause: "--output-format takes html only. Without it, a crawl returns URLs only.",
        next_action: "Pass --output-format html, or leave it out.",
      });
    }
    params.output_format = outputFormat;
  }
  const timeoutMs = timeoutFlag(values.timeout);
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
    const follow = values.follow === true;
    const finished: Crawl = follow ? await waitUntilEnd(created.crawl_id, { apiKey, timeoutMs }) : created;
    const failure = crawlFailure(finished);
    const runDir = writeRun({
      runId,
      command: "zenrows crawl create",
      capability: "crawl",
      url,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: failure ? "error" : "ok",
      request: { ...params },
      result: { crawlId: created.crawl_id, status: finished.status, coverage: finished.coverage },
      ...(failure ? { error: failure.toJSON() } : {}),
    });
    const code = printCrawl(finished, json, follow ? waitHeadline(finished) : `Started crawl ${created.crawl_id}`);
    if (!json && runDir) log.dim(`  artifact: ${runDir}`);
    printWaitHint(finished, json);
    return code;
  } catch (err) {
    writeRun({
      runId,
      command: "zenrows crawl create",
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

async function getCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    cursor: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "get");
  const cursor = asString(values.cursor);
  const limit = pageLimit(values.limit, 10_000);
  assertUsable("crawl");
  const apiKey = requireApiKey();
  const page = await getCrawl(id, { apiKey, cursor, limit });
  const results = page.results ?? [];
  const nextCursor = page.next_cursor ?? null;
  const code = printCrawl(page, json, `Crawl ${id}`, { results, next_cursor: nextCursor });
  if (!json) {
    log.info(`${results.length} result(s) on this page:`);
    if (results.length) log.out(toJsonl(results).trimEnd());
    log.info(`next_cursor: ${nextCursor ?? "null (last page)"}`);
  }
  return code;
}

async function waitCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { timeout: { type: "string" }, json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "wait");
  const timeoutMs = timeoutFlag(values.timeout);
  assertUsable("crawl");
  const apiKey = requireApiKey();
  const c = await waitUntilEnd(id, { apiKey, timeoutMs });
  const code = printCrawl(c, json, waitHeadline(c));
  printWaitHint(c, json);
  return code;
}

function waitHeadline(c: Crawl): string {
  return isTerminal(c.status) ? `Crawl ${c.crawl_id} finished` : `Stopped waiting: crawl ${c.crawl_id} is still running`;
}

function printWaitHint(c: Crawl, json: boolean): void {
  if (!json && !isTerminal(c.status)) log.dim(`  next: zenrows crawl wait ${c.crawl_id}`);
}

async function resultsCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    out: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean" },
  });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "results");
  const outFile = asString(values.out);
  const pageSize = pageLimit(values.limit, 10_000);
  assertUsable("crawl");
  const apiKey = requireApiKey();
  const { crawl: c, results, partial } = await listAllResults(id, { apiKey, pageSize });
  return printResults(id, c.status, results, { outFile, json, partial });
}

async function downloadCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, { out: { type: "string" }, json: { type: "boolean" } });
  const json = ctx.json || values.json === true;
  const id = requireId(positionals[0], "download");
  const file = asString(values.out) ?? `${id.replace(/[^A-Za-z0-9._-]+/g, "_")}.jsonl`;
  assertUsable("crawl");
  const apiKey = requireApiKey();
  const { status, ndjson } = await downloadCrawl(id, { apiKey });
  writeOut(file, ndjson);
  const count = ndjson.split("\n").filter((l) => l.trim()).length;
  const partial = status === "running";
  if (json) {
    log.out(JSON.stringify({ ok: true, crawlId: id, status, partial, count, file }, null, 2));
  } else {
    log.success(`Downloaded ${count} result(s) → ${file}`);
    if (partial) log.warn("  The crawl is still running: this file is partial. Download again once it ends.");
  }
  return 0;
}

/** Write or print results. Under --json, always print the envelope (`file` replaces `results` with --out). */
function printResults(
  id: string,
  status: string,
  results: CrawlResult[],
  o: { outFile?: string; json: boolean; partial: boolean },
): number {
  if (o.outFile) writeOut(o.outFile, toJsonl(results));
  if (o.json) {
    const rows = o.outFile ? { file: o.outFile } : { results };
    log.out(JSON.stringify({ ok: true, crawlId: id, status, count: results.length, ...rows, partial: o.partial }, null, 2));
    return 0;
  }
  if (o.outFile) {
    log.success(`Wrote ${results.length} result(s) → ${o.outFile}`);
  } else {
    log.info(`${results.length} result(s) for crawl ${id} (status: ${status}):`);
    log.out(toJsonl(results).trimEnd());
  }
  if (o.partial) log.warn("  The crawl is still running: these results are partial. Read them again once it ends.");
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
        "Pass the id from a fetched result's content_url (the last path segment), e.g. `zenrows crawl content <id> ct_…`. Only crawls created with --output-format html have content.",
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
  const headline = s.status === "stopped" ? `Stopped crawl ${id}` : `Nothing to stop: crawl ${id} had already ended`;
  return printCrawl(s, ctx.json || values.json === true, headline);
}

/**
 * Wait for a crawl to end. Ctrl-C ends the wait, not the crawl: say so, give
 * the command that resumes the wait, and exit 130 as shells do on SIGINT.
 */
async function waitUntilEnd(id: string, opts: { apiKey: string; timeoutMs?: number }): Promise<Crawl> {
  const onSigint = () => {
    log.warn(`Stopped waiting. Crawl ${id} is still running; it was not stopped.`);
    log.dim(`  resume: zenrows crawl wait ${id}`);
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  try {
    return await waitForCrawl(id, opts);
  } finally {
    process.off("SIGINT", onSigint);
  }
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
      "Nothing matched. Loosen --include-pattern / --exclude-pattern, raise --depth, or check the start page with `zenrows fetch <url>`.",
  };
  return new ToolkitError({
    code: "CRAWL_FAILED",
    message: `Crawl ${c.crawl_id} failed.`,
    likely_cause: why || "The crawl ended in status failed without a reason.",
    next_action: (code && next[code]) || "Read the error, fix the cause, then start a new crawl.",
    suggested_commands: [`zenrows crawl get ${c.crawl_id}`],
    server_code: code,
    crawl_id: c.crawl_id,
  });
}

/**
 * Print a crawl (or a stop answer), structured under --json, and return the exit
 * code: 1 when it ended `failed`, else 0. `stopped` is a deliberate outcome, so
 * it exits 0 but prints as a warning. `page` carries the results a `get` read.
 */
function printCrawl(
  c: Crawl | CrawlStop,
  json: boolean,
  headline: string,
  page?: { results: CrawlResult[]; next_cursor: string | null },
): number {
  const err = crawlFailure(c);
  const crawlFields = { ...c } as Record<string, unknown>;
  // A wait polls with one result to stay cheap; that page is not "the results".
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
          ...page,
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

/** `--timeout` in seconds, returned in milliseconds; undefined when unset. */
function timeoutFlag(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const seconds = asNumber(v);
  if (seconds === undefined || seconds <= 0) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Invalid --timeout value '${String(v)}'.`,
      likely_cause: "--timeout takes a positive number of seconds.",
      next_action: "Pass seconds, e.g. --timeout 600 for ten minutes.",
    });
  }
  return seconds * 1000;
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
