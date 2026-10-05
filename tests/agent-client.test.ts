import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_ENV_VARS,
  CLIENT_HEADER,
  CLIENT_OVERRIDE_ENV,
  agentClientHeader,
  detectAgentClient,
} from "../src/core/agent-client.ts";
import { scrape } from "../src/core/http.ts";
import { batchRequest } from "../src/core/batch-api.ts";
import { browserRequest } from "../src/core/browser-api.ts";
import { fetchUsage } from "../src/core/usage.ts";
import { discoverSignupUrl, fetchAccountStatus, signupAgent } from "../src/core/agent-account.ts";
import { CLI_VERSION, TELEMETRY_ENV, defaultConfig, loadConfig, saveConfig } from "../src/core/config.ts";
import { loadPolicy } from "../src/core/policy.ts";
import { runFetch } from "../src/adapters/protected-fetch.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { tempRoot } from "./helpers.ts";
import type { ToolkitConfig } from "../src/types/index.ts";

const cases: Array<{ name: string; env: Record<string, string>; want: string | undefined }> = [
  { name: "no agent", env: { HOME: "/home/u", PATH: "/usr/bin", TERM_PROGRAM: "vscode" }, want: undefined },
  { name: "Claude Code", env: { CLAUDE_CODE_CHILD_SESSION: "1" }, want: "claude-code" },
  { name: "Cursor agent", env: { CURSOR_AGENT: "1" }, want: "cursor" },
  { name: "Copilot agent in VS Code", env: { COPILOT_AGENT: "1", TERM_PROGRAM: "vscode" }, want: "vscode" },
  { name: "Codex shell tool", env: { CODEX_THREAD_ID: "019a-thread" }, want: "codex" },
  { name: "Codex sandbox only", env: { CODEX_SANDBOX: "seatbelt" }, want: "codex" },
  { name: "Gemini CLI", env: { GEMINI_CLI: "1" }, want: "gemini-cli" },
  // Claude Code's IDE extensions export CLAUDECODE into every integrated terminal,
  // so it says nothing about who is typing.
  { name: "a terminal in an IDE with Claude Code's extension is not Claude Code", env: { CLAUDECODE: "1", TERM_PROGRAM: "vscode" }, want: undefined },
  { name: "Cursor agent with Claude Code's extension installed", env: { CURSOR_AGENT: "1", CLAUDECODE: "1" }, want: "cursor" },
  { name: "Copilot agent with Claude Code's extension installed", env: { COPILOT_AGENT: "1", CLAUDECODE: "1" }, want: "vscode" },
  // Precedence: one row per neighbouring pair in AGENT_SIGNALS, so any reordering
  // flips at least one of them.
  { name: "Cursor agent over Copilot agent", env: { CURSOR_AGENT: "1", COPILOT_AGENT: "1" }, want: "cursor" },
  { name: "Copilot agent over Codex", env: { COPILOT_AGENT: "1", CODEX_THREAD_ID: "t" }, want: "vscode" },
  { name: "Codex over Gemini CLI", env: { CODEX_THREAD_ID: "t", GEMINI_CLI: "1" }, want: "codex" },
  { name: "Codex thread over Claude Code", env: { CODEX_THREAD_ID: "t", CLAUDE_CODE_CHILD_SESSION: "1" }, want: "codex" },
  { name: "Codex sandbox over Claude Code", env: { CODEX_SANDBOX: "seatbelt", CLAUDE_CODE_CHILD_SESSION: "1" }, want: "codex" },
  { name: "Gemini CLI over Claude Code", env: { GEMINI_CLI: "1", CLAUDE_CODE_CHILD_SESSION: "1" }, want: "gemini-cli" },
  { name: "an empty value is not a signal", env: { CLAUDE_CODE_CHILD_SESSION: "", GEMINI_CLI: "" }, want: undefined },
  { name: "0 and false are not signals", env: { CLAUDE_CODE_CHILD_SESSION: "0", CURSOR_AGENT: "false", GEMINI_CLI: " FALSE " }, want: undefined },
  // Variables that only say a tool is installed or configured, not that it is running the CLI.
  { name: "an OpenAI key is not Codex", env: { OPENAI_API_KEY: "sk-x", CODEX_HOME: "/home/u/.codex" }, want: undefined },
  { name: "a Cursor terminal is not the Cursor agent", env: { CURSOR_TRACE_ID: "abc", TERM_PROGRAM: "cursor" }, want: undefined },
  { name: "a Claude Code setting is not Claude Code", env: { CLAUDE_CONFIG_DIR: "/home/u/.claude" }, want: undefined },
  { name: "Windsurf has no verified signal", env: { WINDSURF_SESSION: "x" }, want: undefined },
];

for (const c of cases) {
  test(`detectAgentClient: ${c.name}`, () => {
    assert.equal(detectAgentClient(c.env), c.want);
  });
}

test("detectAgentClient: the override wins over a detected agent", () => {
  assert.equal(detectAgentClient({ CLAUDE_CODE_CHILD_SESSION: "1", [CLIENT_OVERRIDE_ENV]: "cursor" }), "cursor");
  assert.equal(detectAgentClient({ [CLIENT_OVERRIDE_ENV]: "my-pipeline" }), "my-pipeline");
});

test("detectAgentClient: the override is normalised the way the gateway reads it", () => {
  assert.equal(detectAgentClient({ [CLIENT_OVERRIDE_ENV]: "  Claude Code " }), "claude-code");
  assert.equal(detectAgentClient({ [CLIENT_OVERRIDE_ENV]: "JetBrains" }), "jetbrains");
});

test("detectAgentClient: an invalid override sends nothing, not the detected agent", () => {
  for (const bad of ["a\r\nX-Injected: 1", "café", "x".repeat(33), "-leading-dash", "/home/u/secret", "a;b"]) {
    assert.equal(detectAgentClient({ CLAUDE_CODE_CHILD_SESSION: "1", [CLIENT_OVERRIDE_ENV]: bad }), undefined, bad);
  }
});

test("detectAgentClient: an empty override falls back to detection", () => {
  assert.equal(detectAgentClient({ CLAUDE_CODE_CHILD_SESSION: "1", [CLIENT_OVERRIDE_ENV]: "  " }), "claude-code");
});

test("detectAgentClient: sends the agent's name, never the variable's value", () => {
  assert.equal(detectAgentClient({ CODEX_THREAD_ID: "zr-api-key-lookalike" }), "codex");
});

test("agentClientHeader: the header when an agent is detected, nothing otherwise", async () => {
  await withEnv({}, async () => {
    assert.deepEqual(agentClientHeader({ env: { CLAUDE_CODE_CHILD_SESSION: "1" } }), { [CLIENT_HEADER]: "claude-code" });
    assert.deepEqual(agentClientHeader({}), {});
  });
});

test("agentClientHeader: ZENROWS_TELEMETRY=off suppresses it, override included", async () => {
  await withEnv({ [TELEMETRY_ENV]: "off" }, async () => {
    assert.deepEqual(agentClientHeader({ env: { CLAUDE_CODE_CHILD_SESSION: "1" } }), {});
    assert.deepEqual(agentClientHeader({ env: { [CLIENT_OVERRIDE_ENV]: "cursor" } }), {});
  });
});

test("agentClientHeader: a projectRoot's telemetry \"off\" applies from another cwd", async () => {
  await withProject({ ...defaultConfig(), telemetry: "off" }, async (root) => {
    await withEnv({ CLAUDE_CODE_CHILD_SESSION: "1" }, async () => {
      assert.deepEqual(agentClientHeader({ projectRoot: root }), {});
      assert.deepEqual(agentClientHeader(), { [CLIENT_HEADER]: "claude-code" }, "the cwd's own workspace still sends it");
    });
  });
});

// `zenrows init --workspace <dir> --no-telemetry`, run from outside <dir>: the
// smoke fetch must honour <dir>'s config, not the cwd's.
test("runFetch: init's smoke fetch honours --workspace telemetry off from another cwd", async () => {
  await withProject({ ...defaultConfig(), telemetry: "off" }, async (root) => {
    const sent = await withEnv({ CLAUDE_CODE_CHILD_SESSION: "1" }, () =>
      withStubbedFetch(() => runFetch({ url: "https://x" }, loadConfig(root), loadPolicy(root), "k", root)),
    );
    assert.ok(sent.length > 0, "the stub saw no request");
    for (const h of sent) assert.equal(h.has(CLIENT_HEADER), false);
  });
});

test("discoverSignupUrl: honours its projectRoot's telemetry off from another cwd", async () => {
  await withProject({ ...defaultConfig(), telemetry: "off" }, async (root) => {
    const { impl, sent } = recorder(() => json({}));
    await withEnv({ CLAUDE_CODE_CHILD_SESSION: "1" }, () => discoverSignupUrl(root, { fetchImpl: impl }));
    assert.ok(sent.length > 0, "the stub saw no request");
    for (const h of sent) assert.equal(h.has(CLIENT_HEADER), false);
  });
});

/**
 * Every client that talks to a Zenrows API, each driven through a stub that
 * records the headers it sent. The clients read `process.env`, so each check
 * runs under `withEnv`.
 */
type Sent = Headers;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recorder(respond: () => Response) {
  const sent: Sent[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return respond();
  }) as unknown as typeof fetch;
  return { impl, sent };
}

const clients: Array<{ name: string; call: () => Promise<Sent[]> }> = [
  {
    name: "scrape",
    call: () => withStubbedFetch(() => scrape("https://api.zenrows.com/v1/", "k", { url: "https://x" })),
  },
  {
    name: "batch",
    call: async () => {
      const { impl, sent } = recorder(() => json({ job_id: "j" }));
      await batchRequest("GET", "/jobs/j", { apiKey: "k", fetchImpl: impl });
      return sent;
    },
  },
  {
    name: "browser",
    call: async () => {
      const { impl, sent } = recorder(() => json({ ok: true }));
      await browserRequest("POST", "/browser/sessions", { apiKey: "k", body: {}, fetchImpl: impl });
      return sent;
    },
  },
  {
    name: "usage",
    call: async () => {
      const { impl, sent } = recorder(() =>
        json({ status: "ACTIVE", usage: 0, usage_percent: 0, plan: { name: "Free", products: {} }, top_ups: [] }),
      );
      await fetchUsage("https://api.zenrows.com/v1/", "k", { fetchImpl: impl });
      return sent;
    },
  },
  {
    name: "signup discovery",
    call: async () => {
      const { impl, sent } = recorder(() => json({}));
      await discoverSignupUrl(undefined, { fetchImpl: impl });
      return sent;
    },
  },
  {
    name: "signup",
    call: async () => {
      const { impl, sent } = recorder(() => json({ apiKey: "k", accountId: "u", claimUrl: "https://x/c" }, 201));
      await signupAgent({ url: "https://x/api/agent/signup", fetchImpl: impl });
      return sent;
    },
  },
  {
    name: "account status",
    call: async () => {
      const { impl, sent } = recorder(() => json({ accountId: "u", claimed: false, isAgent: true }));
      await fetchAccountStatus("k", { url: "https://x/api/agent/account", fetchImpl: impl });
      return sent;
    },
  },
];

for (const c of clients) {
  test(`${c.name}: sends ${CLIENT_HEADER} when run by an agent`, async () => {
    const sent = await withEnv({ CLAUDE_CODE_CHILD_SESSION: "1" }, c.call);
    assert.ok(sent.length > 0, "the stub saw no request");
    for (const h of sent) assert.equal(h.get(CLIENT_HEADER), "claude-code");
  });

  test(`${c.name}: sends no ${CLIENT_HEADER} when no agent is detected`, async () => {
    const sent = await withEnv({}, c.call);
    assert.ok(sent.length > 0, "the stub saw no request");
    for (const h of sent) assert.equal(h.has(CLIENT_HEADER), false);
  });

  test(`${c.name}: ZENROWS_TELEMETRY=off sends no ${CLIENT_HEADER}`, async () => {
    const sent = await withEnv({ CLAUDE_CODE_CHILD_SESSION: "1", [TELEMETRY_ENV]: "off" }, c.call);
    assert.ok(sent.length > 0, "the stub saw no request");
    for (const h of sent) assert.equal(h.has(CLIENT_HEADER), false);
  });

  test(`${c.name}: config telemetry "off" sends no ${CLIENT_HEADER}`, async () => {
    const sent = await withEnv({ CLAUDE_CODE_CHILD_SESSION: "1" }, c.call, { ...defaultConfig(), telemetry: "off" });
    assert.ok(sent.length > 0, "the stub saw no request");
    for (const h of sent) assert.equal(h.has(CLIENT_HEADER), false);
  });

  test(`${c.name}: sends a User-Agent carrying the CLI version`, async () => {
    const sent = await withEnv({}, c.call);
    for (const h of sent) assert.equal(h.get("user-agent"), `zenrows-cli/${CLI_VERSION}`);
  });
}

/** Run `fn` with a stub as the global `fetch`; returns the headers it was sent. */
async function withStubbedFetch(fn: () => Promise<unknown>): Promise<Sent[]> {
  const { impl, sent } = recorder(() => new Response("ok", { status: 200, headers: { "content-type": "text/html" } }));
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
  return sent;
}

/** A workspace holding `config` that is not the cwd's, for `projectRoot` callers. */
async function withProject(config: ToolkitConfig, fn: (root: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    saveConfig(config, root);
    await fn(root);
  } finally {
    cleanup();
  }
}

/**
 * Run `fn` with exactly `vars` set among the variables detection and attribution
 * read, from a fresh workspace holding `config`, then restore both. setup.ts
 * clears the variables for the process; the workspace keeps a developer's own
 * `.zenrows/config.json` above the cwd (say `telemetry: "off"`) out of the result.
 */
async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
  config: ToolkitConfig = defaultConfig(),
): Promise<T> {
  const keys = new Set([...AGENT_ENV_VARS, CLIENT_OVERRIDE_ENV, TELEMETRY_ENV, ...Object.keys(vars)]);
  const saved = new Map([...keys].map((k) => [k, process.env[k]]));
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  saveConfig(config, root);
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(cwd);
    cleanup();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
