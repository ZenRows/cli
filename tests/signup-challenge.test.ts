import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tempRoot } from "./helpers.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { resolveApiKey } from "../src/core/auth.ts";
import { answerSignupChallenge, readAccount, signupAgent } from "../src/core/agent-account.ts";
import { ensureApiKey } from "../src/core/ensure-key.ts";
import { ToolkitError } from "../src/core/errors.ts";
import { defaultPolicy } from "../src/core/policy.ts";
import { challengePath, readChallenge, writeChallenge } from "../src/core/signup-challenge.ts";
import { printError } from "../src/cli/output.ts";
import { signup } from "../src/cli/commands/signup.ts";

const URL_ = "https://stub.test/api/agent/signup";

function challenge428(id: string, prompt: string, message = "To create a Zenrows account, answer: ...") {
  return new Response(
    JSON.stringify({ message, error: "challenge_required", next: "...", challenge: { id, prompt, expires_in: 600 } }),
    { status: 428, headers: { "content-type": "application/json" } },
  );
}

type Call = { url: string; body?: string };

function stubFetch(responses: Array<() => Response>, calls: Call[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : undefined });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request " + url);
    return next();
  }) as unknown as typeof fetch;
}

function withTelemetryOff<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ZENROWS_TELEMETRY;
  process.env.ZENROWS_TELEMETRY = "off";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.ZENROWS_TELEMETRY;
    else process.env.ZENROWS_TELEMETRY = prev;
  });
}

test("a 428 challenge_required is stored and reported as SIGNUP_CHALLENGE with the question", async () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    const calls: Call[] = [];
    const fetchImpl = stubFetch([() => challenge428("abcd1234", "which of norway, walrus, pear is a country?")], calls);
    await withTelemetryOff(async () => {
      await assert.rejects(
        () => signupAgent({ url: URL_, fetchImpl, projectRoot: root }),
        (e: unknown) => {
          assert.ok(e instanceof ToolkitError);
          assert.equal(e.code, "SIGNUP_CHALLENGE");
          assert.equal(
            e.message,
            "Zenrows needs one quick answer before it creates an account: which of norway, walrus, pear is a country?",
          );
          assert.match(e.next_action, /zenrows signup --answer "<your answer>"/);
          assert.doesNotMatch(e.message + e.next_action + e.likely_cause, /—/);
          const json = e.toJSON();
          assert.equal(json.challenge?.question, "which of norway, walrus, pear is a country?");
          assert.equal(json.challenge?.id, "abcd1234");
          assert.ok(Date.parse(json.challenge!.expires_at) > Date.now());
          return true;
        },
      );
    });
    const stored = readChallenge(root);
    assert.equal(stored?.id, "abcd1234");
    assert.equal(stored?.signupUrl, URL_);
    assert.equal(calls[0]!.body, undefined, "a plain signup sends no body");
  } finally {
    cleanup();
  }
});

test("--json error output carries the code, question and answer command", async () => {
  const out: string[] = [];
  const prevWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  try {
    const { root, cleanup } = tempRoot();
    try {
      createWorkspace(root);
      const fetchImpl = stubFetch([() => challenge428("abcd1234", "odd one out: gecko, chin, badger, ferret?")], []);
      const err = await withTelemetryOff(() => signupAgent({ url: URL_, fetchImpl, projectRoot: root }).catch((e) => e));
      printError(err, true);
    } finally {
      cleanup();
    }
  } finally {
    process.stdout.write = prevWrite;
  }
  const parsed = JSON.parse(out.join(""));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "SIGNUP_CHALLENGE");
  assert.equal(parsed.error.challenge.question, "odd one out: gecko, chin, badger, ferret?");
  assert.deepEqual(parsed.error.suggested_commands[0], 'zenrows signup --answer "<your answer>"');
});

test("ensureApiKey surfaces SIGNUP_CHALLENGE and stores no key", async () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    const fetchImpl = stubFetch([() => challenge428("abcd1234", "q?")], []);
    await withTelemetryOff(async () => {
      await assert.rejects(
        () => ensureApiKey(defaultPolicy(), { projectRoot: root, signupImpl: (o) => signupAgent({ ...o, url: URL_, fetchImpl }) }),
        (e: unknown) => e instanceof ToolkitError && e.code === "SIGNUP_CHALLENGE",
      );
    });
    assert.equal(resolveApiKey(root).key, undefined);
    assert.equal(readChallenge(root)?.id, "abcd1234");
  } finally {
    cleanup();
  }
});

test("a right answer posts {challenge_id, answer} to the issuing URL and clears the question", async () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    writeChallenge({ id: "abcd1234", prompt: "q?", expiresAt: new Date(Date.now() + 60_000).toISOString(), signupUrl: URL_ }, root);
    const calls: Call[] = [];
    const fetchImpl = stubFetch(
      [() => new Response(JSON.stringify({ apiKey: "zr-new", accountId: "u1", claimUrl: "https://x/claim/t" }), { status: 201 })],
      calls,
    );
    const res = await withTelemetryOff(() => answerSignupChallenge("norway", { fetchImpl, projectRoot: root }));
    assert.equal(res.apiKey, "zr-new");
    assert.equal(calls[0]!.url, URL_);
    assert.deepEqual(JSON.parse(calls[0]!.body!), { challenge_id: "abcd1234", answer: "norway" });
    assert.equal(existsSync(challengePath(root)), false);
  } finally {
    cleanup();
  }
});

test("a wrong answer stores the new question and says the answer was wrong", async () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    writeChallenge({ id: "old00000", prompt: "q?", expiresAt: new Date(Date.now() + 60_000).toISOString(), signupUrl: URL_ }, root);
    const fetchImpl = stubFetch([() => challenge428("new11111", "Mia had nine pens and gave three away. How many left? Digits.", "Wrong or expired. To create...")], []);
    await withTelemetryOff(async () => {
      await assert.rejects(
        () => answerSignupChallenge("7", { fetchImpl, projectRoot: root }),
        (e: unknown) =>
          e instanceof ToolkitError &&
          e.code === "SIGNUP_CHALLENGE" &&
          /^That answer was wrong or came too late/.test(e.message) &&
          e.message.endsWith("Mia had nine pens and gave three away. How many left? Digits."),
      );
    });
    assert.equal(readChallenge(root)?.id, "new11111");
  } finally {
    cleanup();
  }
});

test("429 challenge_locked becomes SIGNUP_CHALLENGE_LOCKED with retry_after", async () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    writeChallenge({ id: "abcd1234", prompt: "q?", expiresAt: new Date(Date.now() + 60_000).toISOString(), signupUrl: URL_ }, root);
    const fetchImpl = stubFetch(
      [() => new Response(JSON.stringify({ error: "challenge_locked", message: "x" }), { status: 429, headers: { "retry-after": "3600" } })],
      [],
    );
    await withTelemetryOff(async () => {
      await assert.rejects(
        () => answerSignupChallenge("x", { fetchImpl, projectRoot: root }),
        (e: unknown) => {
          assert.ok(e instanceof ToolkitError);
          assert.equal(e.code, "SIGNUP_CHALLENGE_LOCKED");
          assert.equal(e.retry_after, 3600);
          assert.match(e.next_action, /in an hour/);
          assert.match(e.next_action, /zenrows login --api-key/);
          return true;
        },
      );
    });
    assert.equal(readChallenge(root), null);
  } finally {
    cleanup();
  }
});

test("no pending question, or an expired one, is SIGNUP_CHALLENGE_MISSING without a request", async () => {
  const { root, cleanup } = tempRoot();
  try {
    createWorkspace(root);
    const calls: Call[] = [];
    const fetchImpl = stubFetch([], calls);
    await assert.rejects(
      () => answerSignupChallenge("x", { fetchImpl, projectRoot: root }),
      (e: unknown) => e instanceof ToolkitError && e.code === "SIGNUP_CHALLENGE_MISSING" && /re-run your original command/i.test(e.next_action),
    );
    writeChallenge({ id: "abcd1234", prompt: "q?", expiresAt: new Date(Date.now() - 1000).toISOString(), signupUrl: URL_ }, root);
    await assert.rejects(
      () => answerSignupChallenge("x", { fetchImpl, projectRoot: root }),
      (e: unknown) => e instanceof ToolkitError && e.code === "SIGNUP_CHALLENGE_MISSING" && /expired/.test(e.message),
    );
    assert.equal(readChallenge(root), null);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test("signup --answer stores the key and account and prints the --json result", async () => {
  const { root, cleanup } = tempRoot();
  const prevFetch = globalThis.fetch;
  const prevCwd = process.cwd();
  const out: string[] = [];
  const prevWrite = process.stdout.write.bind(process.stdout);
  try {
    createWorkspace(root);
    writeChallenge({ id: "abcd1234", prompt: "q?", expiresAt: new Date(Date.now() + 60_000).toISOString(), signupUrl: URL_ }, root);
    globalThis.fetch = stubFetch(
      [() => new Response(JSON.stringify({ apiKey: "zr-new", accountId: "u1", claimUrl: "https://x/claim/t" }), { status: 201 })],
      [],
    );
    process.chdir(root);
    process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
    const code = await withTelemetryOff(async () => signup.run(["--answer", "norway"], { json: true, yes: true }));
    assert.equal(code, 0);
    assert.equal(resolveApiKey(root).key, "zr-new");
    assert.equal(readAccount(root)?.accountId, "u1");
    assert.equal(readAccount(root)?.unclaimed, true);
    const parsed = JSON.parse(out.join(""));
    assert.deepEqual(parsed, { ok: true, accountId: "u1", claimUrl: "https://x/claim/t", next_action: "Re-run your original command." });
  } finally {
    process.stdout.write = prevWrite;
    process.chdir(prevCwd);
    globalThis.fetch = prevFetch;
    cleanup();
  }
});

test("signup --answer with an empty value is INVALID_USAGE", async () => {
  await assert.rejects(
    async () => signup.run(["--answer", "  "], { json: true, yes: true }),
    (e: unknown) => e instanceof ToolkitError && e.code === "INVALID_USAGE",
  );
});

test("a 428 that is not a challenge falls through to SIGNUP_FAILED", async () => {
  const fetchImpl = stubFetch([() => new Response("nope", { status: 428 })], []);
  const { root, cleanup } = tempRoot();
  try {
    await withTelemetryOff(async () => {
      await assert.rejects(
        () => signupAgent({ url: URL_, fetchImpl, projectRoot: root }),
        (e: unknown) => e instanceof ToolkitError && e.code === "SIGNUP_FAILED",
      );
    });
    assert.equal(readChallenge(root), null);
  } finally {
    cleanup();
  }
});
