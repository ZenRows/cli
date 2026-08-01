import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser } from "../src/cli/commands/browser.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { savePolicy, defaultPolicy } from "../src/core/policy.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { tempRoot } from "./helpers.ts";

const ctx = { json: true, yes: false };

// --- Pure validation (no workspace / no network needed) ---------------------

test("unknown subcommand → INVALID_USAGE, exit 1", async () => {
  assert.equal(await browser.run(["frobnicate"], ctx), 1);
});

test("open with no URL → exit 1 (before any network)", async () => {
  assert.equal(await browser.run(["open"], ctx), 1);
});

test("a verb without --session → exit 1 (before gate/network)", async () => {
  assert.equal(await browser.run(["click", "--selector", "#x"], ctx), 1);
});

test("run with no script path → exit 1", async () => {
  assert.equal(await browser.run(["run"], ctx), 1);
});

test("local-storage rejects an invalid action (before gate/network)", async () => {
  assert.equal(await browser.run(["local-storage", "--session", "x", "--action", "bogus"], ctx), 1);
});

test("local-storage get without --key → exit 1 (before gate/network)", async () => {
  assert.equal(await browser.run(["local-storage", "--session", "x", "--action", "get"], ctx), 1);
});

test("set-cookies without --cookies → exit 1 (payload flag is --cookies, not --json)", async () => {
  assert.equal(await browser.run(["set-cookies", "--session", "x"], ctx), 1);
});

test("set-cookies with invalid JSON → exit 1", async () => {
  assert.equal(await browser.run(["set-cookies", "--session", "x", "--cookies", "not-json"], ctx), 1);
});

// --- run: sequencing + always-close (finally), with a stubbed backend -------

/** Route a fake Browser API by method+path. Records the call sequence. */
function browserStub(handler: (method: string, path: string) => { status: number; body: unknown }) {
  const calls: Array<{ method: string; path: string }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    calls.push({ method, path });
    const { status, body } = handler(method, path);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

function withBrowserWorkspace(fn: () => Promise<void>): Promise<void> {
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  savePolicy({ ...defaultPolicy(), allow_browser: true }, root);
  saveApiKey("0".repeat(41), root);
  process.chdir(root);
  return fn().finally(() => {
    process.chdir(cwd);
    cleanup();
  });
}

test("run executes steps in order and always closes the session", async () => {
  await withBrowserWorkspace(async () => {
    const stub = browserStub((method, path) => {
      if (method === "POST" && path === "/browser/sessions") return { status: 200, body: { session_id: "s1", expires_at: "z" } };
      if (method === "DELETE") return { status: 204, body: undefined };
      if (path.endsWith("/get_text")) return { status: 200, body: { text: "hello" } };
      return { status: 200, body: { ok: true } };
    });
    try {
      writeFileSync(join(process.cwd(), "steps.json"), JSON.stringify([
        { action: "navigate", url: "https://example.com" },
        { action: "wait", ms: 100 },
        { action: "get_text" },
      ]));
      const code = await browser.run(["run", "steps.json"], ctx);
      assert.equal(code, 0);
      const seq = stub.calls.map((c) => `${c.method} ${c.path}`);
      assert.deepEqual(seq, [
        "POST /browser/sessions",
        "POST /browser/sessions/s1/navigate",
        "POST /browser/sessions/s1/wait",
        "POST /browser/sessions/s1/get_text",
        "DELETE /browser/sessions/s1",
      ]);
    } finally {
      stub.restore();
    }
  });
});

test("run supports `verb` discriminator so local_storage's `action` body field survives", async () => {
  await withBrowserWorkspace(async () => {
    const bodies: Array<{ path: string; body: unknown }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      bodies.push({ path, body });
      if (method === "POST" && path === "/browser/sessions") return new Response(JSON.stringify({ session_id: "s3", expires_at: "z" }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ value: "tok-val" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      writeFileSync(join(process.cwd(), "ls.json"), JSON.stringify([
        { verb: "local_storage", action: "get", key: "token" },
      ]));
      const code = await browser.run(["run", "ls.json"], ctx);
      assert.equal(code, 0);
      const ls = bodies.find((b) => b.path.endsWith("/local_storage"));
      assert.ok(ls, "local_storage call was made");
      // The step's own `action` (get) reached the body, not consumed as the verb.
      assert.deepEqual(ls!.body, { action: "get", key: "token" });
    } finally {
      globalThis.fetch = orig;
    }
  });
});

test("run still closes the session when a step fails (finally)", async () => {
  await withBrowserWorkspace(async () => {
    const stub = browserStub((method, path) => {
      if (method === "POST" && path === "/browser/sessions") return { status: 200, body: { session_id: "s2", expires_at: "z" } };
      if (method === "DELETE") return { status: 204, body: undefined };
      if (path.endsWith("/click")) return { status: 404, body: { error: "no such element" } };
      return { status: 200, body: { ok: true } };
    });
    try {
      writeFileSync(join(process.cwd(), "bad.json"), JSON.stringify([
        { action: "navigate", url: "https://example.com" },
        { action: "click", selector: "#missing" },
        { action: "get_text" },
      ]));
      const code = await browser.run(["run", "bad.json"], ctx);
      assert.equal(code, 1); // failed step
      const seq = stub.calls.map((c) => `${c.method} ${c.path}`);
      // stops at the failing click, but STILL closes the session
      assert.deepEqual(seq, [
        "POST /browser/sessions",
        "POST /browser/sessions/s2/navigate",
        "POST /browser/sessions/s2/click",
        "DELETE /browser/sessions/s2",
      ]);
    } finally {
      stub.restore();
    }
  });
});

test("open closes the session when navigate fails (no leak)", async () => {
  await withBrowserWorkspace(async () => {
    const stub = browserStub((method, path) => {
      if (method === "POST" && path === "/browser/sessions") return { status: 200, body: { session_id: "leak", expires_at: "z" } };
      if (method === "DELETE") return { status: 204, body: undefined };
      if (path.endsWith("/navigate")) return { status: 400, body: { error: "Cannot navigate to invalid URL" } };
      return { status: 200, body: { ok: true } };
    });
    try {
      const code = await browser.run(["open", "not-a-url"], ctx);
      assert.equal(code, 1);
      const seq = stub.calls.map((c) => `${c.method} ${c.path}`);
      assert.deepEqual(seq, [
        "POST /browser/sessions",
        "POST /browser/sessions/leak/navigate",
        "DELETE /browser/sessions/leak",
      ]);
    } finally {
      stub.restore();
    }
  });
});

test("select wraps plain --value into option[value=…] before POSTing", async () => {
  await withBrowserWorkspace(async () => {
    const bodies: Array<{ path: string; body: unknown }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      bodies.push({ path, body });
      if (method === "POST" && path === "/browser/sessions") {
        return new Response(JSON.stringify({ session_id: "s4", expires_at: "z" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      // open first so we have a session path — but we call select with a fake session
      // directly: gate + sessionCall only.
      const code = await browser.run(["select", "--session", "s4", "--selector", "#dropdown", "--value", "2"], ctx);
      assert.equal(code, 0);
      const sel = bodies.find((b) => b.path.endsWith("/select"));
      assert.ok(sel);
      assert.deepEqual(sel!.body, { selector: "#dropdown", value: 'option[value="2"]' });
    } finally {
      globalThis.fetch = orig;
    }
  });
});
