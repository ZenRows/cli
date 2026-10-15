import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJob, getJob, listResults, rerunJob, stopJob, waitForJob } from "../src/core/batch-api.ts";
import { ToolkitError } from "../src/core/errors.ts";
import { estimateCredits, toJobBody, validateJsonl, type BatchJob } from "../src/adapters/batch.ts";
import { assertWithinLimits, defaultPolicy, savePolicy } from "../src/core/policy.ts";
import { batch, runFailure, timeoutFlag } from "../src/cli/commands/batch.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { tempRoot } from "./helpers.ts";

const noSleep = async () => {};

/** A fetch stub that answers each call from `responses` in order, recording the calls. */
function seqFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const runningJob = { job_id: "j1", latest_run: { status: "running", stats: { total: 1, completed: 0, successful: 0, failed: 0 } } };

test("GETs retry a transient 503 and then succeed", async () => {
  const { impl, calls } = seqFetch([{ status: 503, body: { code: "unavailable" } }, { status: 200, body: runningJob }]);
  const job = await getJob("j1", { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep });
  assert.equal(job.job_id, "j1");
  assert.equal(calls.length, 2);
});

test("GET pagination survives a transient 502 mid-way without losing pages", async () => {
  const { impl, calls } = seqFetch([
    { status: 200, body: { results: [{ task_id: "a" }], next_cursor: "c2" } },
    { status: 502 },
    { status: 200, body: { results: [{ task_id: "b" }], next_cursor: null } },
  ]);
  const rows = await listResults("j1", { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep });
  assert.deepEqual(rows.map((r) => r.task_id), ["a", "b"]);
  assert.equal(calls.length, 3);
});

test("createJob sends an Idempotency-Key and retries a 502 with the same key", async () => {
  const { impl, calls } = seqFetch([{ status: 502 }, { status: 201, body: runningJob }]);
  await createJob({ type: "regular", status: "closed", tasks: [] }, { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep });
  assert.equal(calls.length, 2);
  const k1 = (calls[0]!.init?.headers as Record<string, string>)["Idempotency-Key"];
  const k2 = (calls[1]!.init?.headers as Record<string, string>)["Idempotency-Key"];
  assert.ok(k1 && k1.length > 0);
  assert.equal(k1, k2);
});

test("createJob does not retry a 429 (an account limit, not a blip)", async () => {
  const { impl, calls } = seqFetch([{ status: 429, body: { code: "quota_exceeded", status: 429 } }]);
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BATCH_QUOTA_EXCEEDED",
  );
  assert.equal(calls.length, 1);
});

test("createJob honors a caller-supplied Idempotency-Key", async () => {
  const { impl, calls } = seqFetch([{ status: 201, body: runningJob }]);
  await createJob({ tasks: [] }, { apiKey: "k", fetchImpl: impl, idempotencyKey: "my-key" });
  assert.equal((calls[0]!.init?.headers as Record<string, string>)["Idempotency-Key"], "my-key");
});

test("rerunJob sends an Idempotency-Key and the status filter", async () => {
  const { impl, calls } = seqFetch([{ status: 202, body: runningJob }]);
  await rerunJob("j1", { apiKey: "k", fetchImpl: impl, status: "failed,pending" });
  assert.match(calls[0]!.url, /\/jobs\/j1\/rerun\?status=failed%2Cpending$/);
  assert.ok((calls[0]!.init?.headers as Record<string, string>)["Idempotency-Key"]);
});

test("409 no_matching_tasks points at --include-pending and keeps server_code", async () => {
  const { impl } = seqFetch([
    { status: 409, body: { status: 409, code: "no_matching_tasks", detail: "No tasks in the previous run match the requested statuses." } },
  ]);
  await assert.rejects(
    () => rerunJob("j1", { apiKey: "k", fetchImpl: impl, status: "failed" }),
    (e: unknown) =>
      e instanceof ToolkitError &&
      e.code === "BATCH_FAILED" &&
      e.server_code === "no_matching_tasks" &&
      /--include-pending/.test(e.next_action),
  );
});

test("409 run_not_terminal and partial_rerun_window_expired get their own guidance", async () => {
  for (const [code, re] of [
    ["run_not_terminal", /still in progress/],
    ["partial_rerun_window_expired", /10 days/],
  ] as const) {
    const { impl } = seqFetch([{ status: 409, body: { status: 409, code } }]);
    await assert.rejects(
      () => rerunJob("j1", { apiKey: "k", fetchImpl: impl, status: "failed" }),
      (e: unknown) => e instanceof ToolkitError && e.server_code === code && re.test(e.next_action),
    );
  }
});

test("listResults passes the processing filter through", async () => {
  const { impl, calls } = seqFetch([{ status: 200, body: { results: [], next_cursor: null } }]);
  await listResults("j1", { apiKey: "k", fetchImpl: impl, status: "processing" });
  assert.match(calls[0]!.url, /status=processing/);
});

test("waitForJob fails right away on a paused run, with the timeout's code and reason run_paused", async () => {
  const paused = { job_id: "j1", latest_run: { status: "running", pause_state: "paused", stats: { total: 2, completed: 1, successful: 1, failed: 0 } } };
  const { impl, calls } = seqFetch([{ status: 200, body: paused }]);
  await assert.rejects(
    () => waitForJob("j1", { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep, timeoutMs: 600_000 }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BATCH_FAILED" && e.reason === "run_paused",
  );
  assert.equal(calls.length, 1);
});

test("waitForJob still times out with BATCH_FAILED, now with reason wait_timeout", async () => {
  const { impl } = seqFetch([{ status: 200, body: runningJob }]);
  await assert.rejects(
    () => waitForJob("j1", { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep, timeoutMs: 0 }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BATCH_FAILED" && e.reason === "wait_timeout" && /Timed out/.test(e.message),
  );
});

test("estimateCredits prices job-level flags: 2 URLs with --premium-proxy cost 20, not 2", () => {
  const jobs: BatchJob[] = [{ url: "https://a.com" }, { url: "https://b.com" }];
  assert.equal(estimateCredits(jobs).credits, 2);
  assert.equal(estimateCredits(jobs, { premium_proxy: true }).credits, 20);
  assert.equal(estimateCredits(jobs, { premium_proxy: true, js_render: true }).credits, 50);
});

test("estimateCredits reads nested zenrows_params and canonical flag spellings", () => {
  assert.equal(estimateCredits([{ url: "https://a.com", zenrows_params: { js_render: true } }]).credits, 5);
  // The API lowercases boolean strings, so "TRUE" is on; it rejects "1", so that is never priced as on.
  assert.equal(estimateCredits([{ url: "https://a.com", zenrows_params: { premium_proxy: "TRUE" } }]).credits, 10);
  assert.equal(estimateCredits([{ url: "https://a.com", zenrows_params: { premium_proxy: "1" } }]).credits, 1);
  assert.equal(estimateCredits([{ url: "https://a.com", js_render: "false" } as unknown as BatchJob]).credits, 1);
  // A task's own params win over the job's.
  assert.equal(estimateCredits([{ url: "https://a.com", js_render: false }], { js_render: true }).credits, 1);
  // Adaptive Stealth Mode counts at its upper bound.
  assert.equal(estimateCredits([{ url: "https://a.com" }], { mode: "auto" }).credits, 25);
});

test("a task flag set to null is not submitted, so the job's value applies and is priced", () => {
  const jobs = [{ url: "https://a.com", js_render: null } as unknown as BatchJob];
  assert.equal(estimateCredits(jobs, { js_render: true }).credits, 5);
  const body = toJobBody(jobs, { js_render: true });
  assert.equal(body.tasks[0]!.zenrows_params, undefined);
  assert.equal(body.zenrows_params?.js_render, "true");
});

test("a null premium_proxy on a task keeps the job's premium_proxy for the proxy_country check", () => {
  const jobs = [{ url: "https://a.com", premium_proxy: null, proxy_country: "us" } as unknown as BatchJob];
  assert.equal(estimateCredits(jobs, { premium_proxy: true }).credits, 10);
  const body = toJobBody(jobs, { premium_proxy: true });
  assert.deepEqual(body.tasks[0]!.zenrows_params, { proxy_country: "us" });
  assert.equal(body.zenrows_params?.premium_proxy, "true");
});

test("boolean params are sent as true/false; any case is normalized, other values are rejected locally", () => {
  const body = toJobBody([{ url: "https://a.com", zenrows_params: { js_render: "TRUE", autoparse: false } }], { json_response: true });
  assert.deepEqual(body.tasks[0]!.zenrows_params, { js_render: "true", autoparse: "false" });
  assert.equal(body.zenrows_params?.json_response, "true");
  for (const bad of ["1", 1, "yes", 0]) {
    assert.throws(
      () => toJobBody([{ url: "https://a.com", zenrows_params: { premium_proxy: bad } }]),
      (e: unknown) => e instanceof ToolkitError && e.code === "INVALID_USAGE" && /premium_proxy must be true or false/.test(e.message),
      String(bad),
    );
  }
});

test("validateJsonl rejects metadata that is not string-to-string", () => {
  const { root, cleanup } = tempRoot();
  try {
    const file = join(root, "jobs.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ url: "https://a.com", metadata: { sku: "1" } }),
        JSON.stringify({ url: "https://b.com", metadata: { sku: 1 } }),
        JSON.stringify({ url: "https://c.com", metadata: ["x"] }),
      ].join("\n") + "\n",
    );
    const v = validateJsonl(file);
    assert.equal(v.validJobs, 1);
    assert.deepEqual(
      v.errors.map((e) => e.line),
      [2, 3],
    );
    assert.match(v.errors[0]!.reason, /metadata\.sku/);
  } finally {
    cleanup();
  }
});

test("a policy cap names the exact `zenrows policy set` command", () => {
  const policy = defaultPolicy();
  assert.throws(
    () => assertWithinLimits({ pages: 1500 }, policy, "batch"),
    (e: unknown) =>
      e instanceof ToolkitError &&
      e.code === "POLICY_LIMIT_EXCEEDED" &&
      e.suggested_commands.includes("zenrows policy set max_pages_per_run 1500") &&
      /default is 1000/.test(e.next_action),
  );
  assert.throws(
    () => assertWithinLimits({ credits: 12500 }, policy, "batch"),
    (e: unknown) => e instanceof ToolkitError && e.suggested_commands.includes("zenrows policy set max_credits_per_run 12500"),
  );
});

test("a run that ran out of credits keeps BATCH_FAILED, adds reason insufficient_credits, and suggests --include-pending", () => {
  const err = runFailure({
    job_id: "j9",
    latest_run: { status: "failed", stats: { total: 3, completed: 1, successful: 1, failed: 0 }, failure_reason: "insufficient_credits" },
  });
  assert.ok(err);
  assert.equal(err.code, "BATCH_FAILED");
  assert.equal(err.reason, "insufficient_credits");
  assert.equal(err.server_code, "insufficient_credits");
  assert.ok(err.suggested_commands.includes("zenrows batch retry-failed j9 --include-pending"));
});

/** Run `fn` in a workspace with a key, routing fetch through `impl`. */
async function inWorkspace(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  savePolicy(defaultPolicy(), root);
  saveApiKey("0".repeat(41), root);
  process.chdir(root);
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
    process.chdir(cwd);
    cleanup();
  }
}

/**
 * Capture the CLI's stdout (the logger writes strings) and silence stderr while
 * `fn` runs. Binary writes pass through: under `node --test` they are the test
 * runner's own reports, and a slow test (real retry backoff) must not swallow them.
 */
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

test("batch retry-failed --include-pending reruns failed and pending tasks", async () => {
  const { impl, calls } = seqFetch([{ status: 202, body: runningJob }]);
  await inWorkspace(impl, async () => {
    let code = -1;
    await quiet(async () => {
      code = await batch.run(["retry-failed", "j1", "--include-pending"], { json: true, yes: false });
    });
    assert.equal(code, 0);
  });
  assert.match(calls[0]!.url, /status=failed%2Cpending%2Cprocessing$/);
});

test("batch retry-failed without the flag reruns only failed tasks", async () => {
  const { impl, calls } = seqFetch([{ status: 202, body: runningJob }]);
  await inWorkspace(impl, async () => {
    await quiet(() => batch.run(["retry-failed", "j1"], { json: true, yes: false }));
  });
  assert.match(calls[0]!.url, /status=failed$/);
});

test("batch wait on a paused run exits 1 with BATCH_FAILED, as the timeout it would reach did", async () => {
  const paused = { job_id: "j1", latest_run: { status: "running", pause_state: "paused", stats: { total: 2, completed: 1, successful: 1, failed: 0 } } };
  const { impl } = seqFetch([{ status: 200, body: paused }]);
  await inWorkspace(impl, async () => {
    let code = -1;
    const out = await quiet(async () => {
      code = await batch.run(["wait", "j1", "--timeout", "600000"], { json: true, yes: false });
    });
    assert.equal(code, 1);
    const j = JSON.parse(out) as { ok: boolean; error: { code: string; reason: string } };
    assert.equal(j.ok, false);
    assert.equal(j.error.code, "BATCH_FAILED");
    assert.equal(j.error.reason, "run_paused");
  });
});

test("batch status shows a paused run with paused:true and exits 0", async () => {
  const paused = { job_id: "j1", latest_run: { status: "running", pause_state: "paused", stats: { total: 2, completed: 1, successful: 1, failed: 0 } } };
  const { impl } = seqFetch([{ status: 200, body: paused }]);
  await inWorkspace(impl, async () => {
    let code = -1;
    const out = await quiet(async () => {
      code = await batch.run(["status", "j1"], { json: true, yes: false });
    });
    assert.equal(code, 0);
    const j = JSON.parse(out) as Record<string, unknown>;
    assert.equal(j.paused, true);
    assert.equal(j.status, "running");
  });
});

test("batch wait --timeout 0 is read as 0 ms, as before: it times out at once with exit 1", async () => {
  const { impl } = seqFetch([{ status: 200, body: runningJob }]);
  await inWorkspace(impl, async () => {
    let code = -1;
    const out = await quiet(async () => {
      code = await batch.run(["wait", "j1", "--timeout", "0"], { json: true, yes: false });
    });
    assert.equal(code, 1);
    assert.equal((JSON.parse(out) as { error: { reason: string } }).error.reason, "wait_timeout");
  });
});

test("batch cancel exits 0 with ok:true even when the stopped run is failed, as before", async () => {
  const run = { run_id: "r1", job_id: "j1", status: "failed", failure_reason: "insufficient_credits", stats: { total: 2, completed: 1, successful: 1, failed: 0 } };
  const { impl } = seqFetch([{ status: 200, body: run }]);
  await inWorkspace(impl, async () => {
    let code = -1;
    const out = await quiet(async () => {
      code = await batch.run(["cancel", "j1"], { json: true, yes: false });
    });
    assert.equal(code, 0);
    const j = JSON.parse(out) as Record<string, unknown>;
    assert.equal(j.ok, true);
    assert.equal(j.jobId, "j1");
    assert.equal(j.status, "failed");
    assert.equal(j.failure_reason, "insufficient_credits");
  });
});

test("batch results --status processing is accepted", async () => {
  const { impl, calls } = seqFetch([{ status: 200, body: { results: [], next_cursor: null } }]);
  await inWorkspace(impl, async () => {
    await quiet(() => batch.run(["results", "j1", "--status", "processing"], { json: true, yes: false }));
  });
  assert.match(calls[0]!.url, /status=processing/);
});

test("a rerun whose first attempt was lost and whose retry finds a run in progress is reported as possibly accepted", async () => {
  const { impl, calls } = seqFetch([
    { status: 502 },
    { status: 409, body: { status: 409, code: "run_not_terminal", detail: "Previous run is still in flight; call /stop before /rerun." } },
  ]);
  await assert.rejects(
    () => rerunJob("j1", { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep, status: "failed" }),
    (e: unknown) =>
      e instanceof ToolkitError &&
      e.server_code === "run_not_terminal" &&
      /may have started the new run/.test(e.next_action) &&
      !/then retry/.test(e.next_action),
  );
  assert.equal(calls.length, 2);
  const k = (c: { init?: RequestInit }) => (c.init?.headers as Record<string, string>)["Idempotency-Key"];
  assert.equal(k(calls[0]!), k(calls[1]!));
});

test("a create whose first attempt was lost and is still processing never advises a new key", async () => {
  const { impl } = seqFetch([{ status: 503 }, { status: 409, body: { status: 409, code: "idempotency_key_conflict" } }]);
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep }),
    (e: unknown) =>
      e instanceof ToolkitError &&
      e.server_code === "idempotency_key_conflict" &&
      /Do not resubmit with a new key/.test(e.next_action),
  );
});

test("an idempotency conflict on a first attempt only suggests a new key for a deliberately new job", async () => {
  const { impl } = seqFetch([{ status: 409, body: { status: 409, code: "idempotency_key_conflict" } }]);
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl: impl, idempotencyKey: "k1" }),
    (e: unknown) =>
      e instanceof ToolkitError && /Retrying with the same key within 24 hours of the first request cannot create a duplicate/.test(e.next_action) && /deliberately new job/.test(e.next_action),
  );
});

test("run_not_terminal for a run whose ingestion did not complete advises a new job, not waiting", async () => {
  const { impl } = seqFetch([
    {
      status: 409,
      body: {
        status: 409,
        code: "run_not_terminal",
        detail: "Previous run's task ingestion did not complete; DELETE the job and resubmit instead of rerunning a partial run.",
      },
    },
  ]);
  await assert.rejects(
    () => rerunJob("j1", { apiKey: "k", fetchImpl: impl, status: "failed" }),
    (e: unknown) => e instanceof ToolkitError && /Delete the job/.test(e.next_action) && !/batch wait/.test(e.next_action),
  );
});

test("timeoutFlag reads a bare number as milliseconds, as before, and accepts s and ms units", () => {
  assert.equal(timeoutFlag(undefined), undefined);
  assert.equal(timeoutFlag("5"), 5);
  assert.equal(timeoutFlag("600000"), 600_000);
  assert.equal(timeoutFlag("0"), 0);
  assert.equal(timeoutFlag("-1"), -1);
  assert.equal(timeoutFlag("600s"), 600_000);
  assert.equal(timeoutFlag("1.5s"), 1500);
  assert.equal(timeoutFlag("250ms"), 250);
  for (const bad of ["0s", "0ms", `${"9".repeat(400)}s`, `${"9".repeat(400)}ms`]) {
    assert.throws(() => timeoutFlag(bad), (e: unknown) => e instanceof ToolkitError && e.code === "INVALID_USAGE", bad);
  }
  // Anything else was ignored before (the default applied); it still is, with a warning.
  const warn = process.stderr.write.bind(process.stderr);
  let warned = "";
  process.stderr.write = ((t: string) => {
    warned += t;
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(timeoutFlag("10m"), undefined);
    assert.equal(timeoutFlag("abc"), undefined);
    assert.equal(timeoutFlag("9".repeat(400)), undefined);
  } finally {
    process.stderr.write = warn;
  }
  assert.match(warned, /using the default of 600000 ms/);
});

test("a create whose retries run out keeps its Idempotency-Key on the error", async () => {
  const { impl, calls } = seqFetch([{ status: 502 }]);
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep, idempotencyKey: "key-1" }),
    (e: unknown) =>
      e instanceof ToolkitError &&
      e.idempotency_key === "key-1" &&
      /may have been accepted/.test(e.next_action) &&
      /Do not resubmit with a new key/.test(e.next_action) &&
      /key-1/.test(e.next_action),
  );
  assert.equal(calls.length, 4);
});

test("a create that never reaches the API keeps its Idempotency-Key on the error", async () => {
  const impl = (async () => {
    throw new Error("connect ECONNRESET");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => createJob({ tasks: [] }, { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep, idempotencyKey: "key-2" }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BACKEND_UNAVAILABLE" && e.idempotency_key === "key-2",
  );
});

test("a GET whose retries run out carries no Idempotency-Key", async () => {
  const { impl } = seqFetch([{ status: 503 }]);
  await assert.rejects(
    () => getJob("j1", { apiKey: "k", fetchImpl: impl, sleepImpl: noSleep }),
    (e: unknown) => e instanceof ToolkitError && e.idempotency_key === undefined,
  );
});

test("batch create with exhausted retries prints the exact command to repeat with the same key", async () => {
  const { impl, calls } = seqFetch([{ status: 502 }]);
  await inWorkspace(impl, async () => {
    writeFileSync(join(process.cwd(), "jobs.jsonl"), JSON.stringify({ url: "https://a.com" }) + "\n");
    const out = await quiet(() => batch.run(["create", "jobs.jsonl", "--manual", "--no-signup"], { json: true, yes: false }));
    const err = (JSON.parse(out) as { error: Record<string, unknown> }).error;
    const sent = (calls[0]!.init?.headers as Record<string, string>)["Idempotency-Key"]!;
    assert.ok(sent);
    assert.equal(err.idempotency_key, sent);
    assert.equal((err.suggested_commands as string[])[0], `zenrows batch create --idempotency-key ${sent} jobs.jsonl --manual --no-signup`);
  });
  assert.ok(calls.length >= 2);
});

test("batch retry-failed with exhausted retries repeats with the caller's key, not a new one", async () => {
  const { impl } = seqFetch([{ status: 503 }]);
  await inWorkspace(impl, async () => {
    const out = await quiet(() =>
      batch.run(["retry-failed", "j1", "--include-pending", "--idempotency-key", "mine"], { json: true, yes: false }),
    );
    const err = (JSON.parse(out) as { error: Record<string, unknown> }).error;
    assert.equal((err.suggested_commands as string[])[0], "zenrows batch retry-failed --idempotency-key mine j1 --include-pending");
  });
});

test("a run the policy cap allowed before still goes through when the full estimate is over the cap, with a warning", async () => {
  const { impl, calls } = seqFetch([{ status: 201, body: runningJob }]);
  await inWorkspace(impl, async () => {
    const lines = Array.from({ length: 500 }, (_, i) => JSON.stringify({ url: `https://a.com/${i}` })).join("\n") + "\n";
    writeFileSync(join(process.cwd(), "jobs.jsonl"), lines);
    let code = -1;
    let warned = "";
    await quiet(async () => {
      // quiet() silences stderr; record what is written there instead.
      const silent = process.stderr.write;
      process.stderr.write = ((t: string | Uint8Array) => {
        warned += typeof t === "string" ? t : "";
        return true;
      }) as typeof process.stderr.write;
      try {
        code = await batch.run(["create", "jobs.jsonl", "--premium-proxy", "--js-render", "--no-signup"], { json: true, yes: false });
      } finally {
        process.stderr.write = silent;
      }
    });
    assert.equal(code, 0);
    assert.match(warned, /estimated at up to 12500 credits, over the policy cap of 10000/);
  });
  assert.equal(calls.length, 1);
});

/** Run a batch subcommand with human output, returning its stderr text. */
async function human(impl: typeof fetch, argv: string[]): Promise<{ code: number; err: string }> {
  let code = -1;
  let err = "";
  await inWorkspace(impl, async () => {
    await quiet(async () => {
      const silent = process.stderr.write;
      process.stderr.write = ((t: string | Uint8Array) => {
        err += typeof t === "string" ? t : "";
        return true;
      }) as typeof process.stderr.write;
      try {
        code = await batch.run(argv, { json: false, yes: false });
      } finally {
        process.stderr.write = silent;
      }
    });
  });
  return { code, err };
}

test("human status: a paused run is a warning with the pause hint", async () => {
  const paused = { job_id: "j1", latest_run: { status: "running", pause_state: "paused", stats: { total: 2, completed: 1, successful: 1, failed: 0 } } };
  const { code, err } = await human(seqFetch([{ status: 200, body: paused }]).impl, ["status", "j1"]);
  assert.equal(code, 0);
  assert.match(err, /status: running \(paused\)/);
  assert.match(err, /no new task is picked up/);
  assert.doesNotMatch(err, /✓/);
});

test("human status: a stopped run with unfinished tasks points at --include-pending", async () => {
  const stopped = { job_id: "j1", latest_run: { status: "stopped", stats: { total: 5, completed: 3, successful: 3, failed: 0 } } };
  const { code, err } = await human(seqFetch([{ status: 200, body: stopped }]).impl, ["status", "j1"]);
  assert.equal(code, 0);
  assert.match(err, /2 task\(s\) did not complete\. Run them: zenrows batch retry-failed j1 --include-pending/);
});

test("human cancel: a failed run is shown as a warning, exit 0 as before", async () => {
  const run = { run_id: "r1", job_id: "j1", status: "failed", failure_reason: "x", stats: { total: 1, completed: 1, successful: 0, failed: 1 } };
  const { code, err } = await human(seqFetch([{ status: 200, body: run }]).impl, ["cancel", "j1"]);
  assert.equal(code, 0);
  assert.match(err, /Stopped job j1 · status: failed/);
  assert.doesNotMatch(err, /✓/);
});

test("batch results rejects an unknown --status before any request", async () => {
  const { impl, calls } = seqFetch([{ status: 200, body: { results: [], next_cursor: null } }]);
  const { code, err } = await human(impl, ["results", "j1", "--status", "nope"]);
  assert.equal(code, 1);
  assert.match(err, /Invalid --status: nope/);
  assert.equal(calls.length, 0);
});

test("401 keeps AUTH_INVALID and adds server_code; 409 run_not_stoppable gets its own advice", async () => {
  const a = seqFetch([{ status: 401, body: { status: 401, code: "unauthenticated", detail: "Invalid API key." } }]);
  await assert.rejects(
    () => getJob("j1", { apiKey: "k", fetchImpl: a.impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "AUTH_INVALID" && e.server_code === "unauthenticated",
  );
  const b = seqFetch([{ status: 409, body: { status: 409, code: "run_not_stoppable" } }]);
  await assert.rejects(
    () => stopJob("j1", { apiKey: "k", fetchImpl: b.impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BATCH_FAILED" && /nothing to stop/.test(e.next_action),
  );
});
