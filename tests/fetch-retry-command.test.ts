/**
 * Retry behaviour seen from the `fetch` and `extract` commands: what an agent
 * reads on stdout under --json, and which command it is told to run again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetch_ } from "../src/cli/commands/fetch.ts";
import { extract } from "../src/cli/commands/extract.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { savePolicy, defaultPolicy } from "../src/core/policy.ts";
import { saveApiKey } from "../src/core/auth.ts";
import type { Command } from "../src/cli/command.ts";
import { tempRoot } from "./helpers.ts";

const URL_ = "https://x.com/p";

const RESP009 = JSON.stringify({
  code: "RESP009",
  status: 503,
  title: "Service temporarily at capacity (RESP009)",
  type: "https://docs.zenrows.com/api-error-codes#RESP009",
});

const AUTH010 = JSON.stringify({
  code: "AUTH010",
  status: 402,
  title: "Feature is not included in plan (AUTH010)",
  type: "https://docs.zenrows.com/api-error-codes#AUTH010",
});

type Handler = (url: URL) => Response;

/** Run `fn` in a fresh workspace with a saved key; every request goes to `handler`. */
async function inWorkspace(handler: Handler, fn: (calls: URL[]) => Promise<void>): Promise<void> {
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  savePolicy(defaultPolicy(), root);
  saveApiKey("0".repeat(41), root);
  process.chdir(root);
  const calls: URL[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    const url = new URL(u);
    calls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = orig;
    process.chdir(cwd);
    cleanup();
  }
}

/** Run a command with the global --json flag; returns its exit code and parsed stdout. */
async function run(cmd: Command, args: string[]): Promise<{ code: number; out: Record<string, any> }> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((s: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof s !== "string") return (orig as (...a: unknown[]) => boolean)(s, ...rest);
    buf += s;
    return true;
  }) as typeof process.stdout.write;
  let code = -1;
  try {
    code = await cmd.run(args, { json: true, yes: false });
  } finally {
    process.stdout.write = orig;
  }
  return { code, out: JSON.parse(buf) };
}

const json = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

// SERVICE_BUSY says "run the same command again": the suggested command must
// be that command, with its extract method and flags, not `zenrows fetch <url>`.
const BUSY_CASES: Array<{ name: string; cmd: Command; args: string[]; expected: string; param?: [string, string] }> = [
  {
    name: "extract (extract=auto)",
    cmd: extract,
    args: [URL_, "--retries", "0"],
    expected: `zenrows extract ${URL_} --retries 0 --json`,
    param: ["extract", "auto"],
  },
  {
    name: "extract --css",
    cmd: extract,
    args: [URL_, "--css", '{"t":"h1"}', "--retries", "0"],
    expected: `zenrows extract ${URL_} --css '{"t":"h1"}' --retries 0 --json`,
    param: ["css_extractor", '{"t":"h1"}'],
  },
  {
    name: "extract --autoparse",
    cmd: extract,
    args: [URL_, "--autoparse", "--retries", "0"],
    expected: `zenrows extract ${URL_} --autoparse --retries 0 --json`,
    param: ["autoparse", "true"],
  },
  {
    name: "extract --outputs",
    cmd: extract,
    args: [URL_, "--outputs", "emails,links", "--retries", "0"],
    expected: `zenrows extract ${URL_} --outputs emails,links --retries 0 --json`,
    param: ["outputs", "emails,links"],
  },
  {
    name: "extract --output md",
    cmd: extract,
    args: [URL_, "--output", "md", "--retries", "0"],
    expected: `zenrows extract ${URL_} --output md --retries 0 --json`,
    param: ["response_type", "markdown"],
  },
  {
    name: "fetch --manual --js-render --premium-proxy",
    cmd: fetch_,
    args: [URL_, "--manual", "--js-render", "--premium-proxy", "--retries", "0"],
    expected: `zenrows fetch ${URL_} --manual --js-render --premium-proxy --retries 0 --json`,
    param: ["premium_proxy", "true"],
  },
  {
    name: "fetch with a URL that needs shell quoting",
    cmd: fetch_,
    args: ["https://x.com/p?a=1&b=it's", "--retries", "0"],
    expected: `zenrows fetch 'https://x.com/p?a=1&b=it'\\''s' --retries 0 --json`,
  },
];

for (const c of BUSY_CASES) {
  test(`SERVICE_BUSY suggests the command that ran: ${c.name}`, async () => {
    await inWorkspace(
      () => json(RESP009, 503),
      async (calls) => {
        const { code, out } = await run(c.cmd, c.args);
        assert.equal(code, 1);
        assert.equal(out.error.code, "SERVICE_BUSY");
        assert.deepEqual(out.error.suggested_commands, [c.expected]);
        assert.equal(calls.length, 1);
        if (c.param) assert.equal(calls[0]!.searchParams.get(c.param[0]), c.param[1]);
      },
    );
  });
}

test("SERVICE_BUSY after the Autoparse fallback suggests the extract command that ran", async () => {
  await inWorkspace(
    (url) => (url.searchParams.get("extract") ? json(AUTH010, 402) : json(RESP009, 503)),
    async (calls) => {
      const { code, out } = await run(extract, [URL_, "--retries", "0"]);
      assert.equal(code, 1);
      assert.equal(out.error.code, "SERVICE_BUSY");
      assert.deepEqual(out.error.suggested_commands, [`zenrows extract ${URL_} --retries 0 --json`]);
      assert.deepEqual(
        calls.map((u) => (u.searchParams.get("extract") ? "extract" : u.searchParams.get("autoparse") ? "autoparse" : "?")),
        ["extract", "autoparse"],
      );
    },
  );
});

test("extract --retries 0 sends the request once", async () => {
  await inWorkspace(
    () => new Response("busy", { status: 503 }),
    async (calls) => {
      const { code } = await run(extract, [URL_, "--css", '{"t":"h1"}', "--retries", "0"]);
      assert.equal(code, 1);
      assert.equal(calls.length, 1);
    },
  );
});

test("fetch --retries 0 sends the request once", async () => {
  await inWorkspace(
    () => new Response("busy", { status: 503 }),
    async (calls) => {
      const { code } = await run(fetch_, [URL_, "--retries", "0"]);
      assert.equal(code, 1);
      assert.equal(calls.length, 1);
    },
  );
});

test("--json reports how many HTTP requests the command sent", async () => {
  let n = 0;
  await inWorkspace(
    () => (++n === 1 ? new Response("", { status: 503, headers: { "retry-after": "0" } }) : new Response("<html>ok</html>", { status: 200 })),
    async (calls) => {
      const { code, out } = await run(fetch_, [URL_]);
      assert.equal(code, 0);
      assert.equal(out.ok, true);
      assert.equal(out.attempts, 2);
      assert.equal(calls.length, 2);
    },
  );
  await inWorkspace(
    (url) => (url.searchParams.get("extract") ? json(AUTH010, 402) : json(JSON.stringify({ title: "ok" }), 200)),
    async () => {
      const { code, out } = await run(extract, [URL_]);
      assert.equal(code, 0);
      assert.equal(out.fellBackToAutoparse, true);
      assert.equal(out.attempts, 2);
    },
  );
});
