import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crawl } from "../src/cli/commands/crawl.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { savePolicy, defaultPolicy } from "../src/core/policy.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { tempRoot } from "./helpers.ts";

const ctx = { json: true, yes: false };

const crawlBody = {
  crawl_id: "c_1",
  status: "running",
  url: "https://example.com/products/",
  depth: 1,
  max_items: 10,
  max_pages: 10,
  coverage: { pages_fetched: 0, pages_failed: 0, items_found: 0 },
  created_at: "2026-10-15T09:00:00Z",
};

type Handler = (url: URL, init?: RequestInit) => Response;

/**
 * Run `fn` in a fresh workspace with a saved key and the given policy; every
 * network call goes to `handler` and is recorded.
 */
function withCrawlWorkspace(
  handler: Handler,
  fn: (calls: Array<{ url: URL; init?: RequestInit }>) => Promise<void>,
  policy: Partial<ReturnType<typeof defaultPolicy>> = {},
): Promise<void> {
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  savePolicy({ ...defaultPolicy(), ...policy }, root);
  saveApiKey("0".repeat(41), root);
  process.chdir(root);
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    const url = new URL(u);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = orig;
    process.chdir(cwd);
    cleanup();
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Capture stdout (log.out) for the duration of `fn`. */
async function captureOut(fn: () => unknown): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((s: string | Uint8Array) => {
    buf += typeof s === "string" ? s : Buffer.from(s).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}

async function run(args: string[]): Promise<{ code: number; out: Record<string, any> }> {
  let code = -1;
  const raw = await captureOut(async () => {
    code = await crawl.run(args, ctx);
  });
  return { code, out: JSON.parse(raw) as Record<string, any> };
}

test("crawl create rejects flags it does not declare, before any network call", async () => {
  await withCrawlWorkspace(
    () => json(crawlBody, 202),
    async (calls) => {
      for (const flag of ["--pagination", "--discovery", "--json-output", "--wait", "--html", "--include", "--exclude"]) {
        const { code, out } = await run(["create", "https://example.com/products/", "--depth", "1", flag, "x"]);
        assert.equal(code, 1, flag);
        assert.equal(out.error.code, "UNKNOWN_FLAG", flag);
      }
      for (const args of [["results", "c_1", "--download"], ["results", "c_1", "--cursor", "p2"]]) {
        const { code, out } = await run(args);
        assert.equal(code, 1, args.join(" "));
        assert.equal(out.error.code, "UNKNOWN_FLAG", args.join(" "));
      }
      assert.equal(calls.length, 0);
    },
  );
});

test("the old start and status subcommands are gone", async () => {
  for (const sub of ["start", "status"]) {
    const { code, out } = await run([sub, "c_1"]);
    assert.equal(code, 1, sub);
    assert.equal(out.error.code, "INVALID_USAGE", sub);
  }
});

test("crawl create takes --output-format html only and --timeout in positive seconds", async () => {
  await withCrawlWorkspace(
    () => json(crawlBody, 202),
    async (calls) => {
      for (const args of [["--output-format", "json"], ["--follow", "--timeout", "0"], ["--follow", "--timeout", "x"]]) {
        const { code, out } = await run(["create", "https://example.com/products/", "--depth", "1", ...args]);
        assert.equal(code, 1, args.join(" "));
        assert.equal(out.error.code, "INVALID_USAGE", args.join(" "));
      }
      assert.equal(calls.length, 0);
    },
  );
});

test("crawl create requires --depth and a whole number in range", async () => {
  await withCrawlWorkspace(
    () => json(crawlBody, 202),
    async (calls) => {
      for (const args of [[], ["--depth", "0"], ["--depth", "1.5"], ["--depth", "100001"], ["--depth", "x"]]) {
        const { code, out } = await run(["create", "https://example.com/products/", ...args]);
        assert.equal(code, 1, args.join(" "));
        assert.equal(out.error.code, "INVALID_USAGE", args.join(" "));
      }
      assert.equal(calls.length, 0);
    },
  );
});

test("crawl create sends only the flags the caller set as the create body", async () => {
  await withCrawlWorkspace(
    () => json(crawlBody, 202, { location: "/v1/crawls/c_1" }),
    async (calls) => {
      const { code, out } = await run([
        "create",
        "https://example.com/products/",
        "--depth",
        "1",
        "--max-items",
        "3",
        "--max-pages",
        "5",
        "--include-pattern",
        "/product/",
        "--include-pattern",
        "/item/",
        "--exclude-pattern",
        "?add",
        "--output-format",
        "html",
      ]);
      assert.equal(code, 0);
      assert.equal(out.ok, true);
      assert.equal(out.crawlId, "c_1");
      assert.equal(out.status, "running");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url.pathname, "/v1/crawls");
      assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
        url: "https://example.com/products/",
        depth: 1,
        max_items: 3,
        max_pages: 5,
        include_patterns: ["/product/", "/item/"],
        exclude_patterns: ["?add"],
        output_format: "html",
      });
    },
  );
});

test("crawl create honors the domain policy and the page cap before any network call", async () => {
  await withCrawlWorkspace(
    () => json(crawlBody, 202),
    async (calls) => {
      const blocked = await run(["create", "https://blocked.example.com/", "--depth", "1"]);
      assert.equal(blocked.code, 1);
      const overCap = await run(["create", "https://example.com/products/", "--depth", "1", "--max-pages", "50"]);
      assert.equal(overCap.code, 1);
      assert.equal(overCap.out.error.code, "POLICY_LIMIT_EXCEEDED");
      assert.equal(calls.length, 0);
    },
    { blocked_domains: ["blocked.example.com"], max_pages_per_run: 20 },
  );
});

test("crawl create --follow waits for the end and exits 1 with CRAWL_FAILED on a failed crawl", async () => {
  await withCrawlWorkspace(
    (url, init) =>
      init?.method === "POST"
        ? json(crawlBody, 202)
        : json({
            ...crawlBody,
            status: "failed",
            error: { code: "seed_unreachable", detail: "The site may be blocking it; check the URL." },
            results: [],
            next_cursor: null,
          }),
    async (calls) => {
      const { code, out } = await run(["create", "https://example.com/products/", "--depth", "1", "--follow"]);
      assert.equal(code, 1);
      assert.equal(out.ok, false);
      assert.equal(out.status, "failed");
      assert.equal(out.error.code, "CRAWL_FAILED");
      assert.match(out.error.likely_cause, /seed_unreachable/);
      assert.equal(out.error.server_code, "seed_unreachable");
      assert.equal(out.error.crawl_id, "c_1");
      assert.equal(calls[1]!.url.searchParams.get("limit"), "1");
      assert.equal(out.crawl.results, undefined, "status output carries no partial result page");
    },
  );
});

test("crawl create surfaces 403 REQS008 as CRAWL_NOT_ENABLED", async () => {
  await withCrawlWorkspace(
    () =>
      json(
        { code: "REQS008", title: "Crawl is not enabled for this account.", detail: "Contact support.", status: 403 },
        403,
        { "content-type": "application/problem+json" },
      ),
    async () => {
      const { code, out } = await run(["create", "https://example.com/products/", "--depth", "1"]);
      assert.equal(code, 1);
      assert.equal(out.error.code, "CRAWL_NOT_ENABLED");
      assert.equal(out.error.message, "Crawl is not enabled for this account.");
    },
  );
});

test("crawl get exits 0 for completed and stopped crawls", async () => {
  for (const [status, stop_reason] of [
    ["completed", "max_items"],
    ["stopped", "user"],
  ]) {
    await withCrawlWorkspace(
      () => json({ ...crawlBody, status, stop_reason, results: [{ url: "https://example.com/product/a" }], next_cursor: "c" }),
      async () => {
        const { code, out } = await run(["get", "c_1"]);
        assert.equal(code, 0, status);
        assert.equal(out.ok, true);
        assert.equal(out.stop_reason, stop_reason);
        assert.equal(out.results.length, 1);
        assert.equal(out.next_cursor, "c");
        assert.equal(out.crawl.results, undefined);
      },
    );
  }
});

test("crawl get on an unknown id exits 1 with CRAWL_NOT_FOUND", async () => {
  await withCrawlWorkspace(
    () => json({ code: "crawl_not_found", title: "Crawl not found", detail: "No crawl c_x.", status: 404 }, 404),
    async () => {
      const { code, out } = await run(["get", "c_x"]);
      assert.equal(code, 1);
      assert.equal(out.error.code, "CRAWL_NOT_FOUND");
    },
  );
});

test("crawl results reads every page of an ended crawl and writes JSONL with --out", async () => {
  const pages: Record<string, unknown> = {
    "": { ...crawlBody, status: "completed", results: [{ url: "https://example.com/product/1" }], next_cursor: "p2" },
    p2: { ...crawlBody, status: "completed", results: [{ url: "https://example.com/product/2" }], next_cursor: null },
  };
  await withCrawlWorkspace(
    (url) => json(pages[url.searchParams.get("cursor") ?? ""]),
    async (calls) => {
      const { code, out } = await run(["results", "c_1", "--limit", "500"]);
      assert.ok(calls.every((c) => c.url.searchParams.get("limit") === "500"), "--limit is the page size");
      assert.equal(code, 0);
      assert.equal(out.count, 2);
      assert.deepEqual(out.results.map((r: { url: string }) => r.url), ["https://example.com/product/1", "https://example.com/product/2"]);

      assert.equal(out.partial, false);

      const file = join(process.cwd(), "urls.jsonl");
      const written = await run(["results", "c_1", "--out", file]);
      assert.deepEqual(written.out, { ok: true, crawlId: "c_1", status: "completed", count: 2, file, partial: false });
      assert.equal(readFileSync(file, "utf8"), '{"url":"https://example.com/product/1"}\n{"url":"https://example.com/product/2"}\n');
    },
  );
});

test("crawl results on a running crawl returns what is kept with partial: true", async () => {
  const pages: Record<string, unknown> = {
    "": { ...crawlBody, results: [{ url: "https://example.com/product/1" }], next_cursor: "p2" },
    p2: { ...crawlBody, results: [], next_cursor: "p2" },
  };
  await withCrawlWorkspace(
    (url) => json(pages[url.searchParams.get("cursor") ?? ""]),
    async () => {
      const { code, out } = await run(["results", "c_1"]);
      assert.equal(code, 0);
      assert.equal(out.status, "running");
      assert.equal(out.partial, true);
      assert.equal(out.count, 1);
    },
  );
});

test("crawl get --cursor reads one page and returns next_cursor while running", async () => {
  await withCrawlWorkspace(
    () => json({ ...crawlBody, results: [{ url: "https://example.com/product/3" }], next_cursor: "p4" }),
    async (calls) => {
      const { code, out } = await run(["get", "c_1", "--cursor", "p3", "--limit", "500"]);
      assert.equal(code, 0);
      assert.equal(out.next_cursor, "p4");
      assert.equal(calls[0]!.url.searchParams.get("cursor"), "p3");
      assert.equal(calls[0]!.url.searchParams.get("limit"), "500");
    },
  );
});

test("crawl download writes the NDJSON export to <id>.jsonl", async () => {
  await withCrawlWorkspace(
    () =>
      new Response('{"url":"https://example.com/product/1","content_status":"fetched","content":"<html></html>"}\n', {
        status: 200,
        headers: { "content-type": "application/x-ndjson", "x-crawl-status": "completed" },
      }),
    async (calls) => {
      const { code, out } = await run(["download", "c_1"]);
      assert.equal(code, 0);
      assert.equal(out.count, 1);
      assert.equal(out.status, "completed");
      assert.equal(out.partial, false);
      assert.equal(calls[0]!.url.pathname, "/v1/crawls/c_1/download");
      assert.ok(existsSync(join(process.cwd(), "c_1.jsonl")));
    },
  );
});

test("crawl content accepts a content_url and prints the page", async () => {
  await withCrawlWorkspace(
    () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }),
    async (calls) => {
      const { code, out } = await run(["content", "c_1", "/v1/crawls/c_1/contents/ct_9"]);
      assert.equal(code, 0);
      assert.equal(out.content, "<html>ok</html>");
      assert.equal(calls[0]!.url.pathname, "/v1/crawls/c_1/contents/ct_9");
    },
  );
});

test("crawl list and stop call the right endpoints", async () => {
  await withCrawlWorkspace(
    (url, init) =>
      init?.method === "POST"
        ? json({ crawl_id: "c_1", status: "stopped", stop_reason: "user" })
        : json({ crawls: [{ ...crawlBody, status: "completed" }], next_cursor: "n2" }),
    async (calls) => {
      const list = await run(["list", "--limit", "5"]);
      assert.equal(list.code, 0);
      assert.equal(list.out.count, 1);
      assert.equal(list.out.next_cursor, "n2");
      assert.equal(calls[0]!.url.searchParams.get("limit"), "5");

      const stop = await run(["stop", "c_1"]);
      assert.equal(stop.code, 0);
      assert.equal(stop.out.status, "stopped");
      assert.equal(calls[1]!.url.pathname, "/v1/crawls/c_1/stop");
    },
  );
});

/** Capture stderr (human output) for the duration of `fn`. */
async function captureErr(fn: () => unknown): Promise<string> {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = ((s: string | Uint8Array) => {
    buf += typeof s === "string" ? s : Buffer.from(s).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return buf;
}

test("crawl stop on an ended crawl prints its real status, not Stopped", async () => {
  await withCrawlWorkspace(
    () => json({ crawl_id: "c_1", status: "completed", stop_reason: "max_items" }),
    async () => {
      let code = -1;
      const err = await captureErr(async () => {
        code = await crawl.run(["stop", "c_1"], { json: false, yes: false });
      });
      assert.equal(code, 0);
      assert.match(err, /already ended · status: completed/);
      assert.doesNotMatch(err, /Stopped crawl/);
    },
  );
});

test("Ctrl-C during crawl wait says the crawl keeps running and exits 130", async () => {
  let interrupted = false;
  const exit = mock.method(process, "exit", () => {
    interrupted = true;
  });
  try {
    await withCrawlWorkspace(
      () => {
        if (!interrupted) setImmediate(() => process.emit("SIGINT"));
        return json({ ...crawlBody, status: interrupted ? "completed" : "running", results: [], next_cursor: null });
      },
      async () => {
        const err = await captureErr(() => crawl.run(["wait", "c_1"], { json: false, yes: false }));
        assert.deepEqual(exit.mock.calls[0]?.arguments, [130]);
        assert.match(err, /c_1 is still running/);
        assert.match(err, /zenrows crawl wait c_1/);
        assert.equal(process.listenerCount("SIGINT"), 0, "the wait removes its SIGINT handler");
      },
    );
  } finally {
    exit.mock.restore();
  }
});

test("crawl wait that runs out exits 0 and prints the running crawl with the resume hint", async () => {
  await withCrawlWorkspace(
    () => json({ ...crawlBody, results: [], next_cursor: "c" }),
    async (calls) => {
      const { code, out } = await run(["wait", "c_1", "--timeout", "0.001"]);
      assert.equal(code, 0);
      assert.equal(out.ok, true);
      assert.equal(out.status, "running");
      assert.equal(out.crawlId, "c_1");
      assert.ok(calls.every((c) => c.init?.method === "GET"), "the crawl is not stopped");

      let human = -1;
      const err = await captureErr(async () => {
        human = await crawl.run(["wait", "c_1", "--timeout", "0.001"], { json: false, yes: false });
      });
      assert.equal(human, 0);
      assert.match(err, /still running/);
      assert.match(err, /next: zenrows crawl wait c_1/);
    },
  );
});

test("unknown crawl subcommand is INVALID_USAGE", async () => {
  const { code, out } = await run(["discover"]);
  assert.equal(code, 1);
  assert.equal(out.error.code, "INVALID_USAGE");
});
