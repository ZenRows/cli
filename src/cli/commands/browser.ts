/**
 * `zenrows browser` — Browser Sessions (status: available).
 *
 * Browser is an ESCALATION layer, not the default. It drives the Zenrows managed
 * REST session API (https://mcp.zenrows.com/browser/sessions/*, Bearer auth) —
 * the same backend the official @zenrows/mcp server uses — so no CDP client or
 * browser dependency is needed. On by default; opt out via policy.allow_browser=false.
 *
 * Session model: `open` creates a server-side session (short TTL + idle
 * timeout) and prints a session_id; subsequent verb subcommands take
 * `--session <id>`; `close` frees it. For multi-step flows prefer
 * `run <script.json>` (one process, auto-closes). `connect` prints the direct
 * CDP wss URL for users who want to drive it with their own Playwright/Puppeteer.
 *
 * Sessions bill by bandwidth + session time, so always close them.
 */
import { readFileSync } from "node:fs";
import { ensureApiKey } from "../../core/ensure-key.ts";
import { assertUsable } from "../../core/capabilities.ts";
import { loadPolicy, assertBrowserAllowed } from "../../core/policy.ts";
import { log, ANSI, c } from "../../core/logger.ts";
import { newRunId, writeRun } from "../../core/artifacts.ts";
import { ToolkitError } from "../../core/errors.ts";
import { parse, asString, asNumber, type Command, type RunContext } from "../command.ts";
import { printError, writeOut } from "../output.ts";
import {
  createSession,
  sessionCall,
  closeSession,
  decodeBinary,
  connectUrl,
  normalizeSelectValue,
  type SessionProxyOpts,
} from "../../core/browser-api.ts";

type ParseOpts = Record<string, { type: "string" | "boolean" }>;

/**
 * Generic session verbs: subcommand → REST verb. Each declares its extra flags,
 * required flags, a body builder, the HTTP method (default POST), and — for
 * text-returning verbs — the field to print raw in non-JSON mode.
 */
interface VerbSpec {
  verb: string;
  method?: "GET" | "POST" | "DELETE";
  opts?: ParseOpts;
  required?: string[];
  body?: (v: Record<string, unknown>) => Record<string, unknown> | undefined;
  textField?: string;
}

const VERBS: Record<string, VerbSpec> = {
  navigate: { verb: "navigate", opts: { url: { type: "string" } }, required: ["url"], body: (v) => ({ url: asString(v.url) }) },
  "go-back": { verb: "go_back" },
  "go-forward": { verb: "go_forward" },
  reload: { verb: "reload" },
  click: { verb: "click", opts: { selector: { type: "string" } }, required: ["selector"], body: (v) => ({ selector: asString(v.selector) }) },
  hover: { verb: "hover", opts: { selector: { type: "string" } }, required: ["selector"], body: (v) => ({ selector: asString(v.selector) }) },
  check: { verb: "check", opts: { selector: { type: "string" } }, required: ["selector"], body: (v) => ({ selector: asString(v.selector) }) },
  uncheck: { verb: "uncheck", opts: { selector: { type: "string" } }, required: ["selector"], body: (v) => ({ selector: asString(v.selector) }) },
  focus: { verb: "focus", opts: { selector: { type: "string" } }, required: ["selector"], body: (v) => ({ selector: asString(v.selector) }) },
  type: {
    verb: "type",
    opts: { selector: { type: "string" }, text: { type: "string" }, "clear-first": { type: "boolean" } },
    required: ["selector", "text"],
    body: (v) => ({ selector: asString(v.selector), text: asString(v.text), clear_first: v["clear-first"] === true }),
  },
  fill: {
    verb: "fill",
    opts: { selector: { type: "string" }, value: { type: "string" } },
    required: ["selector", "value"],
    body: (v) => ({ selector: asString(v.selector), value: asString(v.value) }),
  },
  select: {
    verb: "select",
    opts: { selector: { type: "string" }, value: { type: "string" } },
    required: ["selector", "value"],
    // Backend matches() each <option> against `value` as a CSS selector.
    body: (v) => ({ selector: asString(v.selector), value: normalizeSelectValue(asString(v.value)!) }),
  },
  "press-key": { verb: "press_key", opts: { key: { type: "string" } }, required: ["key"], body: (v) => ({ key: asString(v.key) }) },
  scroll: {
    verb: "scroll",
    opts: { direction: { type: "string" }, distance: { type: "string" } },
    required: ["direction"],
    body: (v) => ({ direction: asString(v.direction), distance: asNumber(v.distance) }),
  },
  drag: {
    verb: "drag",
    opts: { "source-selector": { type: "string" }, "target-selector": { type: "string" } },
    required: ["source-selector", "target-selector"],
    body: (v) => ({ source_selector: asString(v["source-selector"]), target_selector: asString(v["target-selector"]) }),
  },
  "get-text": { verb: "get_text", opts: { selector: { type: "string" } }, body: (v) => ({ selector: asString(v.selector) }), textField: "text" },
  "get-html": { verb: "get_html", opts: { selector: { type: "string" } }, body: (v) => ({ selector: asString(v.selector) }), textField: "html" },
  "get-attribute": {
    verb: "get_attribute",
    opts: { selector: { type: "string" }, attribute: { type: "string" } },
    required: ["selector", "attribute"],
    body: (v) => ({ selector: asString(v.selector), attribute: asString(v.attribute) }),
    textField: "value",
  },
  "query-selector-all": { verb: "query_selector_all", opts: { selector: { type: "string" } }, required: ["selector"], body: (v) => ({ selector: asString(v.selector) }) },
  title: { verb: "title", method: "GET", textField: "title" },
  url: { verb: "url", method: "GET", textField: "url" },
  "accessibility-tree": { verb: "accessibility_tree", method: "GET" },
  wait: { verb: "wait", opts: { ms: { type: "string" } }, required: ["ms"], body: (v) => ({ ms: asNumber(v.ms) }) },
  "wait-for-selector": {
    verb: "wait_for_selector",
    opts: { selector: { type: "string" }, visible: { type: "boolean" } },
    required: ["selector"],
    body: (v) => ({ selector: asString(v.selector), visible: v.visible === true }),
  },
  "wait-for-navigation": { verb: "wait_for_navigation", opts: { "timeout-ms": { type: "string" } }, body: (v) => ({ timeout_ms: asNumber(v["timeout-ms"]) }) },
  evaluate: { verb: "evaluate", opts: { script: { type: "string" } }, required: ["script"], body: (v) => ({ script: asString(v.script) }) },
  "new-tab": { verb: "new_tab", opts: { url: { type: "string" } }, required: ["url"], body: (v) => ({ url: asString(v.url) }) },
  "switch-tab": { verb: "switch_tab", opts: { "tab-id": { type: "string" } }, required: ["tab-id"], body: (v) => ({ tab_id: asString(v["tab-id"]) }) },
  cookies: { verb: "cookies", method: "GET" },
};

export const browser: Command = {
  name: "browser",
  summary: "Drive a Browser Session — escalation-only; bills by bandwidth + session time (15-min max).",
  usage: "zenrows browser <open|close|run|connect|navigate|click|type|get-text|screenshot|…> [flags]",
  help: [
    "Escalation layer for logins / multi-step JS flows. Prefer fetch/extract first (they cost less).",
    "On by default. Sessions bill by bandwidth + session time (auto-terminate after 15 min).",
    "Disable with: zenrows policy set allow_browser false",
    "",
    "Session lifecycle:",
    "  open <url> [--proxy-country cc] [--proxy-region r]   create a session + navigate (prints --session id)",
    "  close --session <id>                                 free the session (always do this)",
    "  run <script.json> [--out <file>]                     run a step sequence in one process, auto-closes",
    "  connect [--proxy-country cc]                         print the direct CDP wss URL (bring your own Playwright)",
    "",
    "Verbs (all take --session <id>):",
    "  navigate --url · go-back · go-forward · reload",
    "  click/hover/check/uncheck/focus --selector · type --selector --text [--clear-first]",
    "  fill/select --selector --value · press-key --key · scroll --direction [--distance] · drag --source-selector --target-selector",
    "    (select --value matches the option's value attr — bare \"2\" or a selector; not label/index)",
    "  get-text/get-html [--selector] · get-attribute --selector --attribute · query-selector-all --selector · title · url · accessibility-tree",
    "  screenshot [--full-page] [--selector] --out f.png · pdf [--landscape] [--print-background] [--scale n] --out f.pdf",
    "  wait --ms · wait-for-selector --selector [--visible] · wait-for-navigation [--timeout-ms]",
    "  evaluate --script · cookies · set-cookies --cookies '[…]' · clear-cookies · local-storage --action <get|set|clear> [--key] [--value] · new-tab --url · switch-tab --tab-id",
    "",
    "Shared: --json (structured output). Sessions bill by bandwidth + time — always close them.",
  ].join("\n"),

  async run(argv: string[], ctx: RunContext): Promise<number> {
    const [sub, ...rest] = argv;
    try {
      switch (sub) {
        case undefined:
        case "info":
          return infoCmd(ctx);
        case "connect":
          return await connectCmd(rest, ctx);
        case "open":
          return await openCmd(rest, ctx);
        case "close":
          return await closeCmd(rest, ctx);
        case "run":
          return await runScriptCmd(rest, ctx);
        case "screenshot":
          return await captureCmd(rest, ctx, "screenshot");
        case "pdf":
          return await captureCmd(rest, ctx, "generate_pdf");
        case "set-cookies":
          return await setCookiesCmd(rest, ctx);
        case "clear-cookies":
          return await simpleSessionCmd(rest, ctx, "cookies", "DELETE");
        case "local-storage":
          return await localStorageCmd(rest, ctx);
        default:
          if (VERBS[sub]) return await verbCmd(sub, rest, ctx);
          throw new ToolkitError({
            code: "INVALID_USAGE",
            message: `Unknown browser subcommand: ${sub}`,
            likely_cause: "That is not a recognized browser verb.",
            next_action: "Run `zenrows browser --help` to see the available subcommands.",
          });
      }
    } catch (err) {
      printError(err, ctx.json);
      return err instanceof ToolkitError && err.code === "POLICY_BROWSER_DISABLED" ? 2 : 1;
    }
  },
};

/** Shared preflight: capability + policy gate, then resolve/provision the key. */
async function gate(rest: string[]): Promise<string> {
  assertUsable("browser");
  const policy = loadPolicy();
  assertBrowserAllowed(policy);
  const noSignup = rest.includes("--no-signup");
  return ensureApiKey(noSignup ? { ...policy, auto_signup: false } : policy, {
    onProvision: (a) => {
      log.info("No API key found — created a Zenrows Free plan account for you.");
      log.dim(`Claim it anytime (keeps your usage): ${a.claimUrl}`);
    },
  });
}

function requireSession(v: Record<string, unknown>): string {
  const s = asString(v.session);
  if (!s) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Missing --session <id>.",
      likely_cause: "This verb operates on an existing session; none was provided.",
      next_action: "Open one first: `zenrows browser open <url>` prints a session id.",
    });
  }
  return s;
}

function requireFlags(v: Record<string, unknown>, names: string[]): void {
  const missing = names.filter((n) => asString(v[n]) === undefined && v[n] !== true);
  if (missing.length) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Missing required flag(s): ${missing.map((n) => `--${n}`).join(", ")}.`,
      likely_cause: "A required argument for this verb was not provided.",
      next_action: "Run `zenrows browser --help` for the verb's flags.",
    });
  }
}

/** Print a verb/session result: raw string for text verbs, else pretty JSON. */
function emit(ctx: RunContext, jsonFlag: boolean, result: unknown, textField?: string): void {
  if (ctx.json || jsonFlag) {
    log.out(JSON.stringify({ ok: true, result }, null, 2));
    return;
  }
  if (textField && result && typeof result === "object" && textField in (result as Record<string, unknown>)) {
    log.out(String((result as Record<string, unknown>)[textField]));
    return;
  }
  log.out(JSON.stringify(result, null, 2));
}

function infoCmd(ctx: RunContext): number {
  const policy = loadPolicy();
  assertBrowserAllowed(policy); // throws POLICY_BROWSER_DISABLED (→ exit 2) only if opted out
  if (ctx.json) {
    log.out(JSON.stringify({ capability: "browser", escalationOnly: true, backend: "REST session API (mcp.zenrows.com/browser/sessions)" }, null, 2));
    return 0;
  }
  log.info(c(ANSI.bold, "Browser sessions (escalation-only)"));
  log.info("Prefer fetch / extract first. Use the browser for logins, clicks, forms, and persistent state.");
  log.info("");
  log.info("  zenrows browser open <url>          start a session");
  log.info("  zenrows browser run <script.json>   run a multi-step flow (auto-closes)");
  log.info("  zenrows browser connect             print a CDP wss URL for Playwright/Puppeteer");
  log.dim("Run `zenrows browser --help` for the full verb list. Sessions bill by bandwidth + time (15-min max) — close when done.");
  return 0;
}

function proxyFrom(v: Record<string, unknown>): SessionProxyOpts {
  return { proxy_country: asString(v["proxy-country"]), proxy_region: asString(v["proxy-region"]) };
}

async function openCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    "proxy-country": { type: "string" },
    "proxy-region": { type: "string" },
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
  });
  const url = positionals[0];
  if (!url) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Missing URL.",
      likely_cause: "No positional <url> was provided to `browser open`.",
      next_action: "Usage: zenrows browser open <url> [--proxy-country cc]",
      suggested_commands: ["zenrows browser open https://example.com"],
    });
  }
  const apiKey = await gate(rest);
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  log.step(`Browser open ${url}…`);
  const session = await createSession(apiKey, proxyFrom(values), undefined);
  let nav: { url?: string; title?: string };
  try {
    nav = await sessionCall<{ url?: string; title?: string }>(apiKey, session.session_id, "navigate", { body: { url } });
  } catch (err) {
    // Mirror @zenrows/mcp: free the slot if navigate fails after create.
    await closeSession(apiKey, session.session_id).catch(() => undefined);
    throw err;
  }
  const finishedAt = new Date().toISOString();
  const runDir = writeRun({
    runId,
    command: "zenrows browser open",
    capability: "browser",
    url,
    startedAt,
    finishedAt,
    status: "ok",
    request: { url, ...proxyFrom(values) },
    result: { session_id: session.session_id, title: nav.title, finalUrl: nav.url, expires_at: session.expires_at },
  });
  log.success(`Session ${session.session_id} · "${nav.title ?? ""}" · expires ${session.expires_at} · run ${runId}`);
  if (runDir) log.dim(`  artifact: ${runDir}`);
  log.dim(`  next: zenrows browser get-text --session ${session.session_id}   |   zenrows browser close --session ${session.session_id}`);
  log.dim("  sessions bill by bandwidth + time and auto-terminate after 15 min — close when done.");
  if (ctx.json || values.json) {
    log.out(JSON.stringify({ ok: true, runId, session_id: session.session_id, title: nav.title ?? null, finalUrl: nav.url ?? null, expires_at: session.expires_at }, null, 2));
  }
  return 0;
}

async function closeCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values } = parse(rest, { session: { type: "string" }, "no-signup": { type: "boolean" }, json: { type: "boolean" } });
  const sessionId = requireSession(values);
  const apiKey = await gate(rest);
  await closeSession(apiKey, sessionId);
  if (ctx.json || values.json) log.out(JSON.stringify({ ok: true, closed: sessionId }, null, 2));
  else log.success(`Closed session ${sessionId}.`);
  return 0;
}

async function connectCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values } = parse(rest, {
    "proxy-country": { type: "string" },
    "proxy-region": { type: "string" },
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
  });
  const apiKey = await gate(rest);
  const wss = connectUrl(apiKey, proxyFrom(values));
  if (ctx.json || values.json) {
    log.out(JSON.stringify({ ok: true, cdpUrl: wss, note: "Contains your API key — do not share or commit." }, null, 2));
    return 0;
  }
  log.info(c(ANSI.bold, "Zenrows Browser Sessions — direct CDP endpoint"));
  log.warn("This URL contains your API key. Do not share it or commit it.");
  log.out(wss);
  log.info("");
  log.info("Drive it with your own client, e.g. Playwright:");
  log.dim("  import { chromium } from 'playwright';");
  log.dim(`  const browser = await chromium.connectOverCDP('${wss.replace(apiKey, "YOUR_ZENROWS_API_KEY")}');`);
  return 0;
}

/** Generic session verb (from the VERBS table). */
async function verbCmd(sub: string, rest: string[], ctx: RunContext): Promise<number> {
  const spec = VERBS[sub]!;
  const { values } = parse(rest, {
    session: { type: "string" },
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
    ...(spec.opts ?? {}),
  });
  const sessionId = requireSession(values);
  if (spec.required) requireFlags(values, spec.required);
  const apiKey = await gate(rest);
  const result = await sessionCall(apiKey, sessionId, spec.verb, {
    method: spec.method ?? "POST",
    body: spec.body ? spec.body(values) : undefined,
  });
  emit(ctx, values.json === true, result, spec.textField);
  return 0;
}

async function simpleSessionCmd(rest: string[], ctx: RunContext, verb: string, method: "GET" | "POST" | "DELETE"): Promise<number> {
  const { values } = parse(rest, { session: { type: "string" }, "no-signup": { type: "boolean" }, json: { type: "boolean" } });
  const sessionId = requireSession(values);
  const apiKey = await gate(rest);
  const result = await sessionCall(apiKey, sessionId, verb, { method });
  emit(ctx, values.json === true, result ?? { ok: true });
  return 0;
}

async function captureCmd(rest: string[], ctx: RunContext, verb: "screenshot" | "generate_pdf"): Promise<number> {
  const { values } = parse(rest, {
    session: { type: "string" },
    "full-page": { type: "boolean" },
    selector: { type: "string" },
    landscape: { type: "boolean" },
    "print-background": { type: "boolean" },
    scale: { type: "string" },
    out: { type: "string" },
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
  });
  const sessionId = requireSession(values);
  const apiKey = await gate(rest);
  const body: Record<string, unknown> =
    verb === "screenshot"
      ? { full_page: values["full-page"] === true, selector: asString(values.selector) }
      : { print_background: values["print-background"] === true, landscape: values.landscape === true, scale: asNumber(values.scale) };
  const data = await sessionCall<{ data: string; mime_type: string }>(apiKey, sessionId, verb, { body });
  const { buf, ext } = decodeBinary(data);
  if (values.out) {
    writeOut(values.out as string, buf);
    log.success(`Wrote ${buf.length} bytes → ${values.out}`);
    if (ctx.json || values.json) log.out(JSON.stringify({ ok: true, bytes: buf.length, mime_type: data.mime_type, out: values.out }, null, 2));
    return 0;
  }
  // No --out: never dump binary to the terminal.
  if (ctx.json || values.json) log.out(JSON.stringify({ ok: true, bytes: buf.length, mime_type: data.mime_type }, null, 2));
  else log.info(`Captured ${data.mime_type} (${buf.length} bytes). Re-run with --out <file.${ext}> to save it.`);
  return 0;
}

async function setCookiesCmd(rest: string[], ctx: RunContext): Promise<number> {
  // NOTE: the payload flag is `--cookies` (not `--json`) — `--json` is the global
  // output-format flag and is stripped before the command sees it.
  const { values } = parse(rest, { session: { type: "string" }, cookies: { type: "string" }, "no-signup": { type: "boolean" } });
  const sessionId = requireSession(values);
  const raw = asString(values.cookies);
  if (!raw) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "set-cookies requires --cookies '<cookie array>'.",
      likely_cause: "No cookie payload was provided.",
      next_action: `Pass a JSON array, e.g. --cookies '[{"name":"a","value":"1","domain":".example.com"}]'`,
    });
  }
  let cookies: unknown;
  try {
    cookies = JSON.parse(raw);
  } catch {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "--cookies for set-cookies is not valid JSON.",
      likely_cause: "The cookie payload could not be parsed.",
      next_action: `Pass a valid JSON array, e.g. --cookies '[{"name":"a","value":"1"}]'`,
    });
  }
  const apiKey = await gate(rest);
  const result = await sessionCall(apiKey, sessionId, "cookies", { method: "POST", body: { cookies } });
  emit(ctx, false, result ?? { ok: true });
  return 0;
}

async function localStorageCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values } = parse(rest, {
    session: { type: "string" },
    action: { type: "string" },
    key: { type: "string" },
    value: { type: "string" },
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
  });
  const sessionId = requireSession(values);
  const action = asString(values.action);
  const key = asString(values.key);
  const value = asString(values.value);
  if (!action || !["get", "set", "clear"].includes(action)) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "local-storage requires --action <get|set|clear>.",
      likely_cause: "A valid action was not provided.",
      next_action: "e.g. zenrows browser local-storage --session <id> --action get --key token",
    });
  }
  if ((action === "get" || action === "set") && !key) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `local-storage --action ${action} requires --key.`,
      likely_cause: "get/set operate on a specific storage key.",
      next_action: `e.g. zenrows browser local-storage --session <id> --action ${action} --key token${action === "set" ? " --value abc" : ""}`,
    });
  }
  if (action === "set" && !value) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "local-storage --action set requires --value.",
      likely_cause: "set needs the value to store.",
      next_action: "e.g. zenrows browser local-storage --session <id> --action set --key token --value abc",
    });
  }
  const apiKey = await gate(rest);
  const result = await sessionCall(apiKey, sessionId, "local_storage", {
    method: "POST",
    body: { action, key, value },
  });
  emit(ctx, values.json === true, result);
  return 0;
}

/**
 * Step in a `run` script. The REST verb (snake_case) is given as `action` (or
 * `verb`); all other keys form the request body. Use `verb` when the body itself
 * needs an `action` field — i.e. `local_storage`:
 *   {"verb":"local_storage","action":"get","key":"token"}
 */
interface ScriptStep {
  action?: string;
  verb?: string;
  [k: string]: unknown;
}

const GET_ACTIONS = new Set(["title", "url", "accessibility_tree", "cookies"]);
const CAPTURE_ACTIONS = new Set(["screenshot", "generate_pdf"]);
/** MCP batch / docs aliases → REST verb used by this CLI. */
const ACTION_ALIASES: Record<string, string> = {
  get_title: "title",
  get_url: "url",
  get_accessibility_tree: "accessibility_tree",
  select_option: "select",
  generate_pdf: "generate_pdf",
};

async function runScriptCmd(rest: string[], ctx: RunContext): Promise<number> {
  const { values, positionals } = parse(rest, {
    "proxy-country": { type: "string" },
    "proxy-region": { type: "string" },
    out: { type: "string" },
    "no-signup": { type: "boolean" },
    json: { type: "boolean" },
  });
  const scriptPath = positionals[0];
  if (!scriptPath) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: "Missing <script.json>.",
      likely_cause: "No script file was provided to `browser run`.",
      next_action: `Usage: zenrows browser run steps.json  (a JSON array of {"action": "...", ...} steps)`,
    });
  }
  let steps: ScriptStep[];
  try {
    const parsed = JSON.parse(readFileSync(scriptPath, "utf8"));
    steps = Array.isArray(parsed) ? parsed : (parsed.steps as ScriptStep[]);
    if (!Array.isArray(steps)) throw new Error("not an array");
  } catch (e) {
    throw new ToolkitError({
      code: "INVALID_USAGE",
      message: `Could not read a step array from ${scriptPath}.`,
      likely_cause: e instanceof Error ? e.message : String(e),
      next_action: `The file must be a JSON array of steps, e.g. [{"action":"navigate","url":"…"},{"action":"get_text"}].`,
    });
  }

  const apiKey = await gate(rest);
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  log.step(`Browser run ${scriptPath} (${steps.length} step(s))…`);
  const session = await createSession(apiKey, proxyFrom(values));
  const results: Array<{ step: number; action: string; ok: boolean; result?: unknown; error?: string }> = [];
  let lastCapture: { buf: Buffer; ext: string; mime: string } | undefined;
  let failed = false;
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      // The verb is `verb` (preferred) or `action`; the rest is the body. Using
      // `verb` keeps a body field named `action` intact (needed by local_storage).
      let action: string | undefined;
      let body: Record<string, unknown>;
      if (typeof step.verb === "string") {
        const { verb: _v, ...rest } = step;
        action = _v;
        body = rest;
      } else {
        const { action: _a, ...rest } = step;
        action = typeof _a === "string" ? _a : undefined;
        body = rest;
      }
      if (!action) throw new ToolkitError({ code: "INVALID_USAGE", message: `Step ${i + 1} is missing "action" (or "verb").`, likely_cause: "Each step needs a verb.", next_action: 'Add an "action" (or "verb") field, e.g. {"action":"navigate","url":"…"}.' });
      action = ACTION_ALIASES[action] ?? action;
      if (action === "select" && typeof body.value === "string") {
        body = { ...body, value: normalizeSelectValue(body.value) };
      }
      const method = GET_ACTIONS.has(action) ? "GET" : "POST";
      try {
        const result = await sessionCall<Record<string, unknown>>(apiKey, session.session_id, action, {
          method,
          body: Object.keys(body).length ? body : undefined,
        });
        if (CAPTURE_ACTIONS.has(action) && result && typeof result === "object" && "data" in result) {
          const dec = decodeBinary(result as { data: string; mime_type: string });
          lastCapture = { buf: dec.buf, ext: dec.ext, mime: (result as { mime_type: string }).mime_type };
          results.push({ step: i + 1, action, ok: true, result: { mime_type: lastCapture.mime, bytes: lastCapture.buf.length } });
        } else {
          results.push({ step: i + 1, action, ok: true, result });
        }
        log.info(`  ✓ ${i + 1}. ${action}`);
      } catch (stepErr) {
        failed = true;
        const msg = stepErr instanceof ToolkitError ? `[${stepErr.code}] ${stepErr.message}` : String(stepErr);
        results.push({ step: i + 1, action, ok: false, error: msg });
        log.warn(`  ✗ ${i + 1}. ${action} — ${msg}`);
        break;
      }
    }
  } finally {
    await closeSession(apiKey, session.session_id).catch(() => undefined);
    log.dim(`  session ${session.session_id} closed`);
  }

  if (values.out && lastCapture) {
    writeOut(values.out as string, lastCapture.buf);
    log.success(`Wrote ${lastCapture.buf.length} bytes → ${values.out}`);
  }
  const finishedAt = new Date().toISOString();
  const runDir = writeRun(
    {
      runId,
      command: "zenrows browser run",
      capability: "browser",
      startedAt,
      finishedAt,
      status: failed ? "error" : "ok",
      request: { script: scriptPath, steps: steps.length, ...proxyFrom(values) },
      result: { ran: results.length, ok: results.filter((r) => r.ok).length },
    },
    { "steps.json": JSON.stringify(results, null, 2) },
  );
  log.success(`Ran ${results.filter((r) => r.ok).length}/${steps.length} step(s) · run ${runId}`);
  if (runDir) log.dim(`  artifact: ${runDir}`);
  if (ctx.json || values.json) log.out(JSON.stringify({ ok: !failed, runId, steps: results }, null, 2));
  return failed ? 1 : 0;
}
