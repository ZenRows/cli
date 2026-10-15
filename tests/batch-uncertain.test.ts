/**
 * Every way a Batch write (create, rerun) can end without a known result, and
 * what the CLI must do then: keep the Idempotency-Key on the error, never
 * suggest a new key, and print the exact command that repeats the request.
 *
 *   A. no answer on every attempt (connection error)
 *   B. no answer on every attempt (client-side timeout)
 *   C. a 5xx on the last attempt
 *   D. a refusal (402, 409, 429, 400) after an attempt that got no usable answer
 *   E. a 2xx whose answer is empty, not JSON, or has no job_id
 *   F. create succeeded but `--follow` failed afterwards (job id known)
 *
 * A definite refusal on the first attempt, and every GET, carry no key.
 * Stop sends no key: the API treats a repeated stop as a no-op.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJob, getJob, isPaused, rerunJob, stopJob } from "../src/core/batch-api.ts";
import { ToolkitError } from "../src/core/errors.ts";
import { batch, repeatArgs, shellQuote } from "../src/cli/commands/batch.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { defaultPolicy, savePolicy } from "../src/core/policy.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { tempRoot } from "./helpers.ts";

const noSleep = async () => {};

type Reply = { status: number; body?: unknown; raw?: string } | "throw";

/** A fetch stub answering each call from `replies` in order (the last repeats). */
function seqFetch(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r === "throw") throw new Error("socket hang up");
    const text = r.raw ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const keys = () => calls.map((c) => (c.init?.headers as Record<string, string>)["Idempotency-Key"]);
  return { impl, calls, keys };
}

const job = { job_id: "j1", latest_run: { status: "running", stats: { total: 1, completed: 0, successful: 0, failed: 0 } } };

/** The error of an unknown outcome: carries the key, forbids a new key, explains a 409. */
function isUnknownOutcome(key: string) {
  return (e: unknown) =>
    e instanceof ToolkitError &&
    e.idempotency_key === key &&
    /Do not resubmit with a new key/.test(e.next_action) &&
    /within 24 hours of the first attempt cannot create a duplicate/.test(e.next_action) &&
    /not guaranteed to be the original/.test(e.next_action) &&
    /402/.test(e.next_action) &&
    e.next_action.includes(key);
}

const create = (impl: typeof fetch, key: string) =>
  createJob({ tasks: [] }, { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep, idempotencyKey: key });
const rerun = (impl: typeof fetch, key: string) =>
  rerunJob("j1", { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep, idempotencyKey: key, status: "failed" });

// A. no answer on every attempt
test("A: create and rerun with no answer on every attempt keep the key", async () => {
  for (const [name, call] of [["create", create], ["rerun", rerun]] as const) {
    const { impl, calls, keys } = seqFetch(["throw"]);
    await assert.rejects(() => call(impl, `a-${name}`), isUnknownOutcome(`a-${name}`), name);
    assert.equal(calls.length, 4, name);
    assert.deepEqual(new Set(keys()), new Set([`a-${name}`]), name);
  }
});

// B. client-side timeout on every attempt
test("B: a write that times out on every attempt keeps the key", async () => {
  const impl = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    })) as unknown as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep, idempotencyKey: "b-1", timeoutMs: 5 }),
    (e: unknown) => isUnknownOutcome("b-1")(e) && (e as ToolkitError).code === "BACKEND_UNAVAILABLE",
  );
});

// C. a 5xx on the last attempt
test("C: create and rerun whose last answer is a 5xx keep the key", async () => {
  for (const [name, call] of [["create", create], ["rerun", rerun]] as const) {
    const { impl, calls } = seqFetch([{ status: 502 }, { status: 503 }, { status: 504 }, { status: 500, body: { code: "internal" } }]);
    await assert.rejects(() => call(impl, `c-${name}`), isUnknownOutcome(`c-${name}`), name);
    assert.equal(calls.length, 4, name);
  }
});

// D. a refusal after an attempt that got no usable answer
test("D: a 402 after a lost attempt keeps the key and the credit advice (create and rerun)", async () => {
  for (const [name, call] of [["create", create], ["rerun", rerun]] as const) {
    const { impl } = seqFetch([{ status: 502 }, { status: 402, body: { status: 402, code: "payment_required", detail: "No credit available." } }]);
    await assert.rejects(
      () => call(impl, `d-${name}`),
      (e: unknown) =>
        isUnknownOutcome(`d-${name}`)(e) &&
        (e as ToolkitError).code === "POLICY_MAX_CREDITS_EXCEEDED" &&
        (e as ToolkitError).reason === "insufficient_credits" &&
        /may have been accepted/.test((e as ToolkitError).next_action),
      name,
    );
  }
});

test("D: a 402 key cap after a connection error keeps the key", async () => {
  const { impl } = seqFetch(["throw", { status: 402, body: { status: 402, code: "api_key_cap_reached" } }]);
  await assert.rejects(
    () => create(impl, "d-cap"),
    (e: unknown) => isUnknownOutcome("d-cap")(e) && (e as ToolkitError).code === "KEY_CREDIT_CAP_REACHED",
  );
});

test("D: a 429 or 400 after a lost attempt keeps the key", async () => {
  for (const status of [429, 400]) {
    const { impl } = seqFetch([{ status: 503 }, { status, body: { status, code: status === 429 ? "quota_exceeded" : "invalid_argument" } }]);
    await assert.rejects(() => create(impl, `d-${status}`), isUnknownOutcome(`d-${status}`), String(status));
  }
});

test("D: a 409 conflict after a lost attempt keeps the key and explains it", async () => {
  const { impl } = seqFetch([{ status: 503 }, { status: 409, body: { status: 409, code: "idempotency_key_conflict" } }]);
  await assert.rejects(
    () => create(impl, "d-409"),
    (e: unknown) =>
      isUnknownOutcome("d-409")(e) &&
      /without a recorded answer/.test((e as ToolkitError).next_action) &&
      !/is still processing it/.test((e as ToolkitError).next_action),
  );
});

test("D: a rerun 409 run_not_terminal after a lost attempt keeps the key", async () => {
  const { impl } = seqFetch([{ status: 502 }, { status: 409, body: { status: 409, code: "run_not_terminal", detail: "Previous run is still in flight." } }]);
  await assert.rejects(
    () => rerun(impl, "d-rnt"),
    (e: unknown) => isUnknownOutcome("d-rnt")(e) && /may have started the new run/.test((e as ToolkitError).next_action),
  );
});

// E. a 2xx whose answer can't be used
test("E: a 2xx with an empty, truncated or job_id-less answer keeps the key (create and rerun)", async () => {
  const bad: Reply[] = [{ status: 201, raw: "" }, { status: 201, raw: '{"job_id":"j1","lat' }, { status: 202, body: { latest_run: {} } }, { status: 201, body: { job_id: "" } }];
  for (const [name, call] of [["create", create], ["rerun", rerun]] as const) {
    for (const [i, reply] of bad.entries()) {
      const { impl, calls } = seqFetch([reply]);
      await assert.rejects(
        () => call(impl, `e-${name}-${i}`),
        (e: unknown) =>
          isUnknownOutcome(`e-${name}-${i}`)(e) && /answer could not be read/.test((e as ToolkitError).message) && /probably exists/.test((e as ToolkitError).next_action),
        `${name} #${i}`,
      );
      // An accepted answer is not retried: a retry would only replay the same unreadable answer.
      assert.equal(calls.length, 1, `${name} #${i}`);
    }
  }
});

test("E: a GET with an unreadable answer fails without a key", async () => {
  const { impl } = seqFetch([{ status: 200, raw: "not json" }]);
  await assert.rejects(
    () => getJob("j1", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.idempotency_key === undefined && /could not be read/.test(e.message),
  );
});

// Definite outcomes carry no key.
test("a definite refusal on the first attempt carries no key", async () => {
  const { impl } = seqFetch([{ status: 402, body: { status: 402, code: "payment_required" } }]);
  await assert.rejects(
    () => create(impl, "none"),
    (e: unknown) => e instanceof ToolkitError && e.code === "POLICY_MAX_CREDITS_EXCEEDED" && e.idempotency_key === undefined,
  );
});

test("a readable 2xx returns the job", async () => {
  const { impl } = seqFetch([{ status: 201, body: job }]);
  assert.equal((await create(impl, "ok")).job_id, "j1");
});

test("stop sends no key and is not retried (a repeated stop is a no-op on the API)", async () => {
  const { impl, calls, keys } = seqFetch(["throw"]);
  await assert.rejects(
    () => stopJob("j1", { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BACKEND_UNAVAILABLE" && e.idempotency_key === undefined,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(keys(), [undefined]);
});

// Shell quoting of the repeat command.
test("shellQuote keeps plain words and round-trips spaces and quotes through sh", () => {
  assert.equal(shellQuote("jobs.jsonl"), "jobs.jsonl");
  assert.equal(shellQuote("--idempotency-key"), "--idempotency-key");
  for (const v of ["key with spaces", "it's a key", 'say "hi"', "a;b $(x) `y`", ""]) {
    const out = execFileSync("sh", ["-c", `printf '%s' ${shellQuote(v)}`], { encoding: "utf8" });
    assert.equal(out, v, v);
  }
});

/** Run `fn` in a workspace with a key, routing fetch through `impl`. */
async function inWorkspace(impl: typeof fetch, fn: (root: string) => Promise<void>): Promise<void> {
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  savePolicy(defaultPolicy(), root);
  saveApiKey("0".repeat(41), root);
  process.chdir(root);
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn(root);
  } finally {
    globalThis.fetch = orig;
    process.chdir(cwd);
    cleanup();
  }
}

/** Capture the CLI's string stdout; binary writes (the test runner's) pass through. */
async function quiet(fn: () => unknown): Promise<string> {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stdout.write = ((s: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof s !== "string") return (o as (...a: unknown[]) => boolean)(s, ...rest);
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return out;
}

test("the repeat command quotes a caller key with spaces and quotes, and sh reads it back intact", async () => {
  const { impl } = seqFetch([{ status: 502 }, { status: 402, body: { status: 402, code: "payment_required" } }]);
  const key = `my "key" it's`;
  await inWorkspace(impl, async () => {
    const out = await quiet(() => batch.run(["retry-failed", "j1", "--idempotency-key", key], { json: true, yes: false }));
    const err = (JSON.parse(out) as { error: Record<string, unknown> }).error;
    const cmd = (err.suggested_commands as string[])[0]!;
    assert.equal(cmd, `zenrows batch retry-failed --idempotency-key ${shellQuote(key)} j1`);
    const argv = execFileSync("sh", ["-c", `for a in ${cmd}; do printf '%s\\n' "$a"; done`], { encoding: "utf8" });
    const parts = argv.trim().split("\n");
    assert.equal(parts[parts.indexOf("--idempotency-key") + 1], key);
  });
});

test("retry-failed records its key in the run artifact, on success and on an unknown outcome", async () => {
  for (const replies of [[{ status: 202, body: job }], [{ status: 502 }]] as Reply[][]) {
    const { impl, keys } = seqFetch(replies);
    await inWorkspace(impl, async (root) => {
      await quiet(() => batch.run(["retry-failed", "j1"], { json: true, yes: false }));
      const runs = join(root, ".zenrows", "runs");
      const meta = JSON.parse(readFileSync(join(runs, readdirSync(runs)[0]!, "run.json"), "utf8")) as Record<string, any>;
      assert.equal(meta.command, "zenrows batch retry-failed");
      assert.equal(meta.request.idempotencyKey, keys()[0]);
    });
  }
});

// F. create succeeded, following it failed
test("F: create --follow that fails after the job exists names the job and says not to create again", async () => {
  const replies: Reply[] = [{ status: 201, body: job }, { status: 503 }];
  const { impl } = seqFetch(replies);
  await inWorkspace(impl, async () => {
    writeFileSync(join(process.cwd(), "jobs.jsonl"), JSON.stringify({ url: "https://a.com" }) + "\n");
    const out = await quiet(() => batch.run(["create", "jobs.jsonl", "--manual", "--no-signup", "--follow"], { json: true, yes: false }));
    const err = (JSON.parse(out) as { error: Record<string, unknown> }).error;
    assert.match(String(err.next_action), /Job j1 was created, so do not run `create` again/);
    assert.equal((err.suggested_commands as string[])[0], "zenrows batch wait j1");
    assert.equal(err.idempotency_key, undefined);
  });
});

test("isPaused needs a live run: a stopped run that kept pause_state is not paused", () => {
  assert.equal(isPaused({ status: "running", pause_state: "paused", stats: { total: 1, completed: 0, successful: 0, failed: 0 } }), true);
  assert.equal(isPaused({ status: "pending", pause_state: "paused", stats: { total: 1, completed: 0, successful: 0, failed: 0 } }), true);
  for (const status of ["stopped", "completed", "failed", "deleted"]) {
    assert.equal(isPaused({ status, pause_state: "paused", stats: { total: 1, completed: 0, successful: 0, failed: 0 } }), false, status);
  }
});

test("429 advice names how each kind of slot is freed", async () => {
  const cases: Array<[string, RegExp]> = [
    ["Account already has 5 scheduled jobs; max 5 allowed. DELETE one before submitting a new one.", /until they are deleted/],
    ["Account already has 3 active jobs; max 3 allowed concurrently.", /closed job while its run is in progress.*open job until it is deleted, or closed and its run has ended/],
  ];
  for (const [detail, re] of cases) {
    const { impl } = seqFetch([{ status: 429, body: { status: 429, code: "quota_exceeded", detail } }]);
    await assert.rejects(
      () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl: impl }),
      (e: unknown) => e instanceof ToolkitError && e.code === "BATCH_QUOTA_EXCEEDED" && re.test(e.next_action),
      detail,
    );
  }
});

// Keys the API would not see as sent.
test("blank, padded, control-character and over-long keys are rejected before any request", async () => {
  // Why: HTTP drops a header value's surrounding whitespace, so "   " would reach the API as no key at all.
  assert.equal(new Headers({ "Idempotency-Key": "   " }).get("Idempotency-Key"), "");
  assert.equal(new Headers({ "Idempotency-Key": " k " }).get("Idempotency-Key"), "k");
  assert.equal(new Headers({ "Idempotency-Key": `my "key" it's` }).get("Idempotency-Key"), `my "key" it's`);
  for (const bad of ["", "   ", "\t", " k", "k ", "a\nb", "x".repeat(129)]) {
    for (const [name, call] of [["create", create], ["rerun", rerun]] as const) {
      const { impl, calls } = seqFetch([{ status: 201, body: job }]);
      await assert.rejects(
        () => call(impl, bad),
        (e: unknown) => e instanceof ToolkitError && e.code === "INVALID_USAGE" && /Invalid --idempotency-key/.test(e.message),
        `${name} ${JSON.stringify(bad)}`,
      );
      assert.equal(calls.length, 0, `${name} ${JSON.stringify(bad)}`);
    }
  }
  const { impl } = seqFetch([{ status: 201, body: job }]);
  assert.equal((await create(impl, "x".repeat(128))).job_id, "j1");
});

test("batch create and retry-failed reject a whitespace-only --idempotency-key before any request", async () => {
  for (const argv of [["create", "jobs.jsonl", "--manual", "--no-signup", "--idempotency-key", "   "], ["retry-failed", "j1", "--idempotency-key", "   "]]) {
    const { impl, calls } = seqFetch([{ status: 201, body: job }]);
    await inWorkspace(impl, async () => {
      writeFileSync(join(process.cwd(), "jobs.jsonl"), JSON.stringify({ url: "https://a.com" }) + "\n");
      let code = -1;
      const out = await quiet(async () => {
        code = await batch.run(argv, { json: true, yes: false });
      });
      assert.equal(code, 1, argv[0]);
      assert.equal((JSON.parse(out) as { error: { code: string } }).error.code, "INVALID_USAGE", argv[0]);
    });
    assert.equal(calls.length, 0, argv[0]);
  }
});

// The repeat command carries exactly the key that was sent.
test("repeatArgs puts the sent key ahead of a -- terminator and drops the caller's own key option", () => {
  assert.deepEqual(repeatArgs("create", ["--manual", "--", "jobs.jsonl"], "K"), ["create", "--idempotency-key", "K", "--manual", "--", "jobs.jsonl"]);
  assert.deepEqual(repeatArgs("create", ["jobs.jsonl", "--idempotency-key", "K"], "K"), ["create", "--idempotency-key", "K", "jobs.jsonl"]);
  assert.deepEqual(repeatArgs("create", ["--idempotency-key=K", "jobs.jsonl"], "K"), ["create", "--idempotency-key", "K", "jobs.jsonl"]);
  // After --, "--idempotency-key" is a positional (a file name), so it stays.
  assert.deepEqual(repeatArgs("create", ["--", "--idempotency-key"], "K"), ["create", "--idempotency-key", "K", "--", "--idempotency-key"]);
});

/** Split a printed command the way sh does, dropping the leading "zenrows". */
function shArgv(cmd: string): string[] {
  const out = execFileSync("sh", ["-c", `for a in ${cmd}; do printf '%s\\0' "$a"; done`], { encoding: "utf8" });
  return out.split("\0").slice(0, -1).slice(1);
}

test("running the printed repeat command sends exactly the key of the lost request, also after a -- terminator", async () => {
  for (const [argv, label] of [
    [["create", "--manual", "--no-signup", "--", "jobs.jsonl"], "terminator, generated key"],
    [["create", "jobs.jsonl", "--manual", "--no-signup", "--idempotency-key", `a "b" c's`], "caller key with quotes"],
  ] as const) {
    // First invocation: every attempt answered 502. Second (the repeat): accepted.
    const first = seqFetch([{ status: 502 }]);
    let printed = "";
    await inWorkspace(first.impl, async () => {
      writeFileSync(join(process.cwd(), "jobs.jsonl"), JSON.stringify({ url: "https://a.com" }) + "\n");
      const out = await quiet(() => batch.run([...argv], { json: true, yes: false }));
      printed = ((JSON.parse(out) as { error: { suggested_commands: string[] } }).error.suggested_commands)[0]!;
    });
    const sent = first.keys()[0]!;
    assert.ok(sent, label);
    const replay = seqFetch([{ status: 201, body: job }]);
    await inWorkspace(replay.impl, async () => {
      writeFileSync(join(process.cwd(), "jobs.jsonl"), JSON.stringify({ url: "https://a.com" }) + "\n");
      const args = shArgv(printed);
      assert.equal(args[0], "batch", label);
      let code = -1;
      await quiet(async () => {
        code = await batch.run(args.slice(1), { json: true, yes: false });
      });
      assert.equal(code, 0, label);
    });
    assert.deepEqual(replay.keys(), [sent], label);
  }
});
