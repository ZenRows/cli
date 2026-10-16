/**
 * `zenrows batch` against the Batch API's real wire shapes: the run that stop,
 * pause and resume answer with, failed runs per failure_reason, reruns by task
 * status, lifecycle 409s, Idempotency-Key and retries, POST tasks, the API's
 * metadata and external_id limits, durations, paused runs, and the new list,
 * content and delete commands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batch, runFailure, timeoutFlag } from "../src/cli/commands/batch.ts";
import { estimateCredits, toJobBody, validateJsonl, withAdaptiveStealth } from "../src/adapters/batch.ts";
import { waitForJob } from "../src/core/batch-api.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { savePolicy, defaultPolicy } from "../src/core/policy.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { tempRoot } from "./helpers.ts";

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
type Call = { url: URL; init?: RequestInit };

const stats = { total: 5, completed: 3, successful: 3, failed: 0 };
const run = (o: Record<string, unknown> = {}) => ({
  run_id: "r1",
  job_id: "j1",
  run_sequence: 1,
  status: "running",
  trigger: "manual",
  stats,
  created_at: "2026-10-16T09:00:00Z",
  ...o,
});
const job = (r: Record<string, unknown> = {}, o: Record<string, unknown> = {}) => ({
  job_id: "j1",
  type: "regular",
  status: "closed",
  latest_run: run(r),
  ...o,
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ type: `https://docs.zenrows.com/api-error-codes#${code}`, title: code, status, code, detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/** Run `fn` in a fresh workspace with a saved key; every network call goes to `handler` and is recorded. */
async function withWorkspace(
  handler: Handler,
  fn: (calls: Call[], root: string) => Promise<void>,
  policy: Partial<ReturnType<typeof defaultPolicy>> = {},
): Promise<void> {
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  savePolicy({ ...defaultPolicy(), ...policy }, root);
  saveApiKey("0".repeat(41), root);
  process.chdir(root);
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    const url = new URL(u);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  try {
    await fn(calls, root);
  } finally {
    globalThis.fetch = orig;
    process.chdir(cwd);
    cleanup();
  }
}

async function captureOut(fn: () => unknown): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((s: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof s !== "string") return (orig as (...a: unknown[]) => boolean)(s, ...rest);
    buf += s;
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}

async function run_(args: string[], yes = false): Promise<{ code: number; out: Record<string, any> }> {
  let code = -1;
  const raw = await captureOut(async () => {
    code = await batch.run(args, { json: true, yes });
  });
  return { code, out: JSON.parse(raw) };
}

function spec(root: string, lines: unknown[]): string {
  const file = join(root, "jobs.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const sentBody = (c: Call) => JSON.parse(String(c.init?.body));
const header = (c: Call, name: string) => (c.init?.headers as Record<string, string>)[name];

// ---------- cancel / pause / resume read the Run ----------

test("cancel reads the stopped Run: status and stats, not 'unknown'", async () => {
  await withWorkspace(
    () => json(run({ status: "stopped" })),
    async () => {
      const { code, out } = await run_(["cancel", "j1"]);
      assert.equal(code, 0);
      assert.equal(out.ok, true);
      assert.equal(out.status, "stopped");
      assert.equal(out.job_id, "j1");
      assert.equal(out.jobId, "j1");
      assert.equal(out.run_id, "r1");
      assert.deepEqual(out.stats, stats);
    },
  );
});

test("cancel on an ended run says nothing was stopped and prints the job as it ended", async () => {
  await withWorkspace(
    (url) =>
      url.pathname.endsWith("/stop")
        ? problem(409, "run_not_stoppable", "Run is not in a stoppable state.")
        : json(job({ status: "completed", stats: { total: 5, completed: 5, successful: 5, failed: 0 } })),
    async () => {
      const { code, out } = await run_(["cancel", "j1"]);
      assert.equal(code, 0);
      assert.equal(out.status, "completed");
    },
  );
});

test("pause and resume read the Run they answer with; a paused run says so", async () => {
  await withWorkspace(
    (url) => json(run(url.pathname.endsWith("/pause") ? { pause_state: "paused" } : {})),
    async (calls) => {
      const paused = await run_(["pause", "j1"]);
      assert.equal(paused.code, 0);
      assert.equal(paused.out.paused, true);
      assert.match(paused.out.note, /zenrows batch resume j1/);
      const resumed = await run_(["resume", "j1"]);
      assert.equal(resumed.code, 0);
      assert.equal(resumed.out.paused, undefined);
      assert.deepEqual(
        calls.map((c) => `${c.init?.method} ${c.url.pathname}`),
        ["POST /v1/jobs/j1/pause", "POST /v1/jobs/j1/resume"],
      );
    },
  );
});

test("pause on an ended run is BATCH_RUN_ENDED with server_code and job_id", async () => {
  await withWorkspace(
    () => problem(409, "run_not_stoppable", "Latest run is terminal; pause/resume only apply to in-flight runs."),
    async () => {
      const { code, out } = await run_(["pause", "j1"]);
      assert.equal(code, 1);
      assert.equal(out.error.code, "BATCH_RUN_ENDED");
      assert.equal(out.error.server_code, "run_not_stoppable");
      assert.equal(out.error.job_id, "j1");
    },
  );
});

// ---------- failed runs map like the matching HTTP refusal ----------

test("a run that ran out of credits is POLICY_MAX_CREDITS_EXCEEDED, exit 1, with server_code, job_id and the rerun", async () => {
  await withWorkspace(
    () => json(job({ status: "failed", failure_reason: "insufficient_credits", failure_detail: "Subscription has no credit available." })),
    async () => {
      const { code, out } = await run_(["status", "j1"]);
      assert.equal(code, 1);
      assert.equal(out.ok, false);
      assert.equal(out.error.code, "POLICY_MAX_CREDITS_EXCEEDED");
      assert.equal(out.error.server_code, "insufficient_credits");
      assert.equal(out.error.job_id, "j1");
      assert.match(out.error.likely_cause, /Stopped batch job j1/);
      assert.doesNotMatch(out.error.likely_cause, /HTTP/);
      assert.ok(out.error.suggested_commands.includes("zenrows batch rerun j1 --status failed,pending,processing"));
      assert.ok(out.error.suggested_commands.includes("zenrows usage"));
    },
  );
});

test("a run whose subscription lapsed is AUTH_INVALID with Billing advice", () => {
  const err = runFailure(job({ status: "failed", failure_reason: "subscription_inactive", failure_detail: "Subscription has expired." }) as never)!;
  assert.equal(err.code, "AUTH_INVALID");
  assert.match(err.next_action, /app\.zenrows\.com\/billing/);
  assert.equal(err.server_code, "subscription_inactive");
  assert.equal(err.job_id, "j1");
});

test("a run the key cap stopped is KEY_CREDIT_CAP_REACHED with server_code", () => {
  const err = runFailure(job({ status: "failed", failure_reason: "api_key_cap_reached" }) as never)!;
  assert.equal(err.code, "KEY_CREDIT_CAP_REACHED");
  assert.equal(err.server_code, "api_key_cap_reached");
  assert.equal(err.job_id, "j1");
});

test("any other failure stays BATCH_FAILED, without 'fix the tasks' advice", () => {
  const err = runFailure(job({ status: "failed", failure_reason: "something_new" }) as never)!;
  assert.equal(err.code, "BATCH_FAILED");
  assert.match(err.message, /stopped before it finished/);
  assert.equal(err.server_code, "something_new");
  assert.equal(runFailure(job({ status: "stopped" }) as never), null);
});

// ---------- rerun ----------

test("rerun with no --status is a full rerun; output keeps rerun_of, retried_tasks, inherited_tasks", async () => {
  const answer = { job_id: "j1", status: "closed", latest_run: run({ run_id: "r2", ingest_status: "pending" }), rerun_of: "r1", retried_tasks: 5, inherited_tasks: 0 };
  await withWorkspace(
    () => json(answer, 202),
    async (calls) => {
      const { code, out } = await run_(["rerun", "j1"]);
      assert.equal(code, 0);
      assert.equal(calls[0]!.url.searchParams.get("status"), null);
      assert.ok(header(calls[0]!, "Idempotency-Key"));
      assert.equal(out.run_id, "r2");
      assert.equal(out.rerun_of, "r1");
      assert.equal(out.retried_tasks, 5);
      assert.equal(out.inherited_tasks, 0);
      assert.equal(out.ingest_status, "pending");
    },
  );
});

test("rerun --status takes pending,processing,failed,successful and rejects anything else before any request", async () => {
  await withWorkspace(
    () => json(job()),
    async (calls) => {
      const ok = await run_(["rerun", "j1", "--status", "Failed, pending,processing,failed"]);
      assert.equal(ok.code, 0);
      assert.equal(calls[0]!.url.searchParams.get("status"), "failed,pending,processing");
      const all = await run_(["rerun", "j1", "--status", "successful"]);
      assert.equal(all.code, 0);
      const bad = await run_(["rerun", "j1", "--status", "expired"]);
      assert.equal(bad.code, 1);
      assert.equal(bad.out.error.code, "INVALID_USAGE");
      assert.equal(calls.length, 2);
    },
  );
});

test("retry-failed sends status=failed, and --include-pending recovers unfinished tasks", async () => {
  await withWorkspace(
    () => json(job()),
    async (calls) => {
      await run_(["retry-failed", "j1"]);
      await run_(["retry-failed", "j1", "--include-pending"]);
      assert.equal(calls[0]!.url.searchParams.get("status"), "failed");
      assert.equal(calls[1]!.url.searchParams.get("status"), "failed,pending,processing");
    },
  );
});

test("each lifecycle 409 gets its own code and advice, carrying server_code and job_id", async () => {
  const cases: Array<[string, string, string, RegExp]> = [
    ["no_matching_tasks", "No tasks match the requested statuses.", "BATCH_NO_MATCHING_TASKS", /--status failed,pending,processing/],
    ["partial_rerun_window_expired", "Partial rerun window expired.", "BATCH_RERUN_WINDOW_EXPIRED", /zenrows batch rerun j1`/],
    ["run_not_terminal", "Previous run is still in flight; call /stop before /rerun.", "BATCH_RUN_IN_PROGRESS", /batch wait j1/],
    ["idempotency_key_conflict", "Idempotency key conflict.", "BATCH_REQUEST_IN_FLIGHT", /same key/],
    ["run_has_descendants", "Run has descendants.", "BATCH_CONFLICT", /batch status j1/],
  ];
  for (const [server, detail, code, advice] of cases) {
    await withWorkspace(
      () => problem(409, server, detail),
      async () => {
        const { out } = await run_(["rerun", "j1", "--status", "failed"]);
        assert.equal(out.error.code, code, server);
        assert.equal(out.error.server_code, server);
        assert.equal(out.error.job_id, "j1");
        assert.match(out.error.next_action, advice);
        assert.doesNotMatch(out.error.likely_cause, /\.\./, "no doubled period");
      },
    );
  }
});

test("402 'Subscription has expired.' uses subscription wording, not out of credits", async () => {
  await withWorkspace(
    () => problem(402, "payment_required", "Subscription has expired."),
    async () => {
      const { out } = await run_(["rerun", "j1"]);
      assert.equal(out.error.code, "AUTH_INVALID");
      assert.equal(out.error.server_code, "payment_required");
      assert.match(out.error.next_action, /Billing/);
    },
  );
});

test("429 names the slot rules and real commands, not a <id> placeholder status", async () => {
  await withWorkspace(
    () => problem(429, "quota_exceeded", "Account already has 3 active jobs; max 3 allowed concurrently. Wait for one to finish or DELETE one before submitting a new one."),
    async (_calls, root) => {
      const file = spec(root, [{ url: "https://example.com/a" }]);
      const { out } = await run_(["create", file]);
      assert.equal(out.error.code, "BATCH_QUOTA_EXCEEDED");
      assert.deepEqual(out.error.suggested_commands, ["zenrows batch list", "zenrows crawl list"]);
      assert.match(out.error.next_action, /shared with Crawl/);
    },
  );
});

// ---------- create: idempotency, retries, output ----------

test("create sends an Idempotency-Key and reuses it when a 503 is retried", async () => {
  let n = 0;
  await withWorkspace(
    () => (n++ === 0 ? problem(503, "internal", "boom") : json({ job_id: "j1", status: "closed", latest_run: run(), accepted_tasks: 2 }, 201)),
    async (calls, root) => {
      const file = spec(root, [{ url: "https://example.com/a" }, { url: "https://example.com/b" }]);
      const { code, out } = await run_(["create", file]);
      assert.equal(code, 0);
      assert.equal(calls.length, 2);
      const k1 = header(calls[0]!, "Idempotency-Key");
      assert.ok(k1);
      assert.equal(header(calls[1]!, "Idempotency-Key"), k1);
      assert.equal(out.accepted_tasks, 2);
      assert.equal(out.run_id, "r1");
      assert.equal(out.job.status, "closed");
    },
  );
});

test("create whose outcome is unknown names the key and the exact command that repeats it safely", async () => {
  await withWorkspace(
    () => problem(503, "internal", "boom"),
    async (calls, root) => {
      const file = spec(root, [{ url: "https://example.com/a" }]);
      const { code, out } = await run_(["create", file, "--idempotency-key", "abc-123"]);
      assert.equal(code, 1);
      assert.equal(calls.length, 4, "the first try plus 3 retries");
      assert.equal(out.error.idempotency_key, "abc-123");
      assert.equal(out.error.suggested_commands[0], `zenrows batch create ${file} --idempotency-key abc-123`);
    },
  );
});

test("create keeps accepted_tasks and ingest_status of a 202 submit", async () => {
  await withWorkspace(
    () => json({ job_id: "j1", status: "closed", latest_run: run({ ingest_status: "pending" }), accepted_tasks: 20000 }, 202),
    async (_calls, root) => {
      const file = spec(root, [{ url: "https://example.com/a" }]);
      const { out } = await run_(["create", file]);
      assert.equal(out.accepted_tasks, 20000);
      assert.equal(out.ingest_status, "pending");
    },
  );
});

test("create sends job-level --name, --external-id and --metadata, and rejects invalid ones locally", async () => {
  await withWorkspace(
    () => json(job()),
    async (calls, root) => {
      const file = spec(root, [{ url: "https://example.com/a" }]);
      const ok = await run_(["create", file, "--name", "Nightly", "--external-id", "n-1", "--metadata", "team=growth", "--metadata", "src=cli"]);
      assert.equal(ok.code, 0);
      const body = sentBody(calls[0]!);
      assert.equal(body.name, "Nightly");
      assert.equal(body.external_id, "n-1");
      assert.deepEqual(body.metadata, { team: "growth", src: "cli" });
      const bad = await run_(["create", file, "--external-id", "has space"]);
      assert.equal(bad.code, 1);
      const badMeta = await run_(["create", file, "--metadata", "novalue"]);
      assert.equal(badMeta.code, 1);
      assert.equal(calls.length, 1);
    },
  );
});

test("create --follow honours --timeout and exits 0 with a note when the wait runs out", async () => {
  await withWorkspace(
    (url, init) => (init?.method === "POST" ? json({ job_id: "j1", latest_run: run(), accepted_tasks: 1 }, 201) : json(job())),
    async (_calls, root) => {
      const file = spec(root, [{ url: "https://example.com/a" }]);
      const { code, out } = await run_(["create", file, "--follow", "--timeout", "1ms"]);
      assert.equal(code, 0);
      assert.equal(out.status, "running");
      assert.equal(out.accepted_tasks, 1);
      assert.match(out.note, /zenrows batch wait j1/);
    },
  );
});

// ---------- the default policy and the estimate ----------

test("the default policy lets an Adaptive Stealth Mode batch of 1,000 URLs through", async () => {
  await withWorkspace(
    () => json(job()),
    async (calls, root) => {
      const file = spec(root, Array.from({ length: 1000 }, (_, i) => ({ url: `https://example.com/${i}` })));
      const { code } = await run_(["create", file]);
      assert.equal(code, 0);
      assert.equal(calls.length, 1);
    },
  );
  assert.equal(defaultPolicy().max_pages_per_run, 10_000);
  assert.equal(defaultPolicy().max_credits_per_run, 250_000);
});

test("a policy cap error prints the exact command to raise it", async () => {
  await withWorkspace(
    () => json(job()),
    async (_calls, root) => {
      const file = spec(root, [{ url: "https://example.com/a" }, { url: "https://example.com/b" }]);
      const { out } = await run_(["create", file], false);
      assert.equal(out.ok, true);
      const capped = await (async () => {
        savePolicy({ ...defaultPolicy(), max_credits_per_run: 10 }, root);
        return run_(["create", file]);
      })();
      assert.equal(capped.out.error.code, "POLICY_LIMIT_EXCEEDED");
      assert.equal(capped.out.error.suggested_commands[0], "zenrows policy set max_credits_per_run 50");
    },
  );
});

test("estimate prices job-level flags, nested zenrows_params and \"false\" the way create submits them", () => {
  const jobs = [
    { url: "https://a.example/" },
    { url: "https://b.example/", zenrows_params: { js_render: "true" } },
    { url: "https://c.example/", js_render: "false" },
  ];
  assert.deepEqual(estimateCredits(jobs).perJob, [1, 5, 1]);
  assert.deepEqual(estimateCredits(jobs, { premium_proxy: true }).perJob, [10, 25, 10]);
  const auto = estimateCredits(withAdaptiveStealth([{ url: "https://a.example/" }]));
  assert.equal(auto.credits, 25);
  assert.equal(auto.min, 1);
});

test("batch estimate takes create's flags and reports the min and the upper bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zr-est-"));
  const file = spec(dir, [{ url: "https://a.example/" }, { url: "https://b.example/" }]);
  const { code, out } = await run_(["estimate", file, "--premium-proxy"]);
  assert.equal(code, 0);
  assert.equal(out.estimated_credits, 20);
  assert.equal(out.estimatedCredits, 20);
  assert.equal(out.estimated_credits_min, 20);
});

// ---------- POST tasks, metadata and external_id ----------

test("method and body are task fields, not zenrows_params; a POST task gets no Adaptive Stealth Mode", () => {
  const jobs = withAdaptiveStealth([
    { url: "https://api.example.com/graphql", method: "POST", body: { query: "{a}" }, external_id: "g1" },
    { url: "https://example.com/b" },
  ]);
  const body = toJobBody(jobs);
  assert.deepEqual(body.tasks[0], { url: "https://api.example.com/graphql", external_id: "g1", method: "POST", body: { query: "{a}" } });
  assert.deepEqual(body.tasks[1]!.zenrows_params, { mode: "auto" });
  assert.throws(() => toJobBody([{ url: "https://x.example/", method: "post" }], { js_render: true }), /POST task cannot use js_render/);
});

test("validateJsonl enforces the API's metadata, external_id, url and method/body limits", () => {
  const dir = mkdtempSync(join(tmpdir(), "zr-val-"));
  const file = spec(dir, [
    { url: "https://ok.example/", metadata: { a: "1" }, external_id: "ok-1" },
    { url: "https://b.example/", metadata: { price: 3 } },
    { url: "https://c.example/", external_id: "has space" },
    { url: "https://d.example/", external_id: "x".repeat(129) },
    { url: "https://e.example/", metadata: { "bad key": "v" } },
    { url: "https://f.example/", metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])) },
    { url: "ftp://g.example/" },
    { url: "https://h.example/", body: "x=1" },
    { url: "https://i.example/", method: "PUT" },
    { url: "https://j.example/", method: "POST", body: "x".repeat(16 * 1024 + 1) },
  ]);
  const v = validateJsonl(file);
  assert.equal(v.validJobs, 1);
  assert.deepEqual(
    v.errors.map((e) => e.line),
    [2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

// ---------- durations, paused runs, waits ----------

test("--timeout takes 10s, 5m, 1h and 500ms; a bare number stays milliseconds; junk is rejected", () => {
  assert.equal(timeoutFlag("10s"), 10_000);
  assert.equal(timeoutFlag("5m"), 300_000);
  assert.equal(timeoutFlag("1h"), 3_600_000);
  assert.equal(timeoutFlag("500ms"), 500);
  assert.equal(timeoutFlag("600000"), 600_000);
  assert.equal(timeoutFlag(undefined), undefined);
  assert.throws(() => timeoutFlag("10x"), /Invalid --timeout/);
  assert.throws(() => timeoutFlag("0"), /Invalid --timeout/);
});

test("wait returns at once on a paused run, exit 0, with paused and a resume note", async () => {
  await withWorkspace(
    () => json(job({ pause_state: "paused" })),
    async (calls) => {
      const { code, out } = await run_(["wait", "j1", "--timeout", "10m"]);
      assert.equal(code, 0);
      assert.equal(calls.length, 1);
      assert.equal(out.paused, true);
      assert.match(out.note, /paused/);
    },
  );
});

test("wait that runs out exits 0 with the run's state and stats, like crawl wait", async () => {
  await withWorkspace(
    () => json(job()),
    async () => {
      const { code, out } = await run_(["wait", "j1", "--timeout", "1"]);
      assert.equal(code, 0);
      assert.equal(out.status, "running");
      assert.deepEqual(out.stats, stats);
      assert.match(out.note, /wait ran out/);
    },
  );
});

test("waitForJob rides out transient errors that outlast the per-request retries", async () => {
  let n = 0;
  const impl = (async () => {
    n++;
    if (n >= 2 && n <= 6) return problem(503, "internal", "boom");
    return json(job({ status: n > 6 ? "completed" : "running" }));
  }) as unknown as typeof fetch;
  const done = await waitForJob("j1", { apiKey: "k", fetchImpl: impl, sleepImpl: async () => {}, waitMs: 60_000 });
  assert.equal(done.latest_run?.status, "completed");
  assert.ok(n > 6);
  // A non-transient error still ends the wait.
  const gone = (async () => problem(404, "not_found", "Job not found.")) as unknown as typeof fetch;
  await assert.rejects(() => waitForJob("j1", { apiKey: "k", fetchImpl: gone, sleepImpl: async () => {} }), /not found/i);
});

// ---------- list, results, content, delete ----------

test("list reads GET /jobs with its filters and prints {ok, count, jobs, next_cursor}", async () => {
  await withWorkspace(
    () => json({ jobs: [job()], next_cursor: "c2" }),
    async (calls) => {
      const { code, out } = await run_(["list", "--status", "open", "--type", "scheduled", "--limit", "10"]);
      assert.equal(code, 0);
      assert.equal(out.count, 1);
      assert.equal(out.next_cursor, "c2");
      const q = calls[0]!.url.searchParams;
      assert.equal(q.get("status"), "open");
      assert.equal(q.get("type"), "scheduled");
      assert.equal(q.get("limit"), "10");
      const bad = await run_(["list", "--limit", "101"]);
      assert.equal(bad.code, 1);
    },
  );
});

test("results accepts processing and --run, and flags a run still in progress as partial", async () => {
  await withWorkspace(
    (url) =>
      url.pathname.endsWith("/results")
        ? json({ results: [{ task_id: "t1", status: "processing" }], next_cursor: null })
        : json(run()),
    async (calls) => {
      const { code, out } = await run_(["results", "j1", "--status", "processing", "--run", "r1"]);
      assert.equal(code, 0);
      assert.equal(calls[0]!.url.pathname, "/v1/jobs/j1/runs/r1/results");
      assert.equal(calls[0]!.url.searchParams.get("status"), "processing");
      assert.equal(out.job_id, "j1");
      assert.equal(out.partial, true);
      assert.match(out.note, /partial/);
    },
  );
});

test("results --download skips expired rows with the reason and counts them", async () => {
  await withWorkspace(
    (url) => {
      if (url.pathname.endsWith("/results")) {
        return json({
          results: [
            { task_id: "t1", status: "expired", type: "html" },
            { task_id: "t2", status: "successful", type: "html", result_url: "https://s3.example/t2" },
          ],
          next_cursor: null,
        });
      }
      if (url.hostname === "s3.example") return new Response("<html></html>");
      return json(job({ status: "completed" }));
    },
    async (_calls, root) => {
      const { out } = await run_(["results", "j1", "--download", join(root, "dl")]);
      assert.equal(out.downloaded, 1);
      assert.equal(out.expired, 1);
      assert.match(out.results.skipped[0].reason, /expired/);
      assert.equal(out.partial, false);
    },
  );
});

test("content prints one task's body, and maps 409/410/422 to specific codes", async () => {
  let mode = "ok";
  await withWorkspace(
    () => {
      if (mode === "ok") return new Response("<html>hi</html>", { headers: { "content-type": "text/html" } });
      if (mode === "notready") return problem(409, "task_not_ready", "Task is still processing.");
      if (mode === "expired") return problem(410, "result_expired", "Result has expired and is no longer available.");
      return problem(422, "AUTH006", "Could not get content.");
    },
    async (calls, root) => {
      const ok = await run_(["content", "j1", "t1"]);
      assert.equal(ok.code, 0);
      assert.equal(ok.out.content, "<html>hi</html>");
      assert.equal(ok.out.content_type, "text/html");
      assert.equal(calls[0]!.url.pathname, "/v1/jobs/j1/tasks/t1/content");
      const file = join(root, "t1.html");
      await run_(["content", "j1", "t1", "--run", "r1", "--out", file]);
      assert.equal(readFileSync(file, "utf8"), "<html>hi</html>");
      assert.equal(calls[1]!.url.pathname, "/v1/jobs/j1/runs/r1/tasks/t1/content");
      for (const [m, code] of [["notready", "BATCH_TASK_NOT_READY"], ["expired", "BATCH_RESULT_EXPIRED"], ["failed", "BATCH_TASK_FAILED"]]) {
        mode = m!;
        const r = await run_(["content", "j1", "t1"]);
        assert.equal(r.code, 1);
        assert.equal(r.out.error.code, code);
      }
    },
  );
});

test("delete needs --yes, then sends DELETE /jobs/{id}", async () => {
  await withWorkspace(
    () => new Response(null, { status: 202 }),
    async (calls) => {
      const refused = await run_(["delete", "j1"]);
      assert.equal(refused.code, 1);
      assert.equal(calls.length, 0);
      const { code, out } = await run_(["delete", "j1"], true);
      assert.equal(code, 0);
      assert.deepEqual(out, { ok: true, job_id: "j1", deleted: true });
      assert.equal(calls[0]!.init?.method, "DELETE");
      assert.equal(calls[0]!.url.pathname, "/v1/jobs/j1");
    },
  );
});
