import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  getJob,
  listResults,
  stopJob,
  waitForJob,
  type ResultsPage,
} from "../src/core/batch-api.ts";
import { ToolkitError } from "../src/core/errors.ts";

/** Build a fetch stub that returns a JSON body, recording the call. */
function jsonFetch(status: number, payload: unknown, contentType = "application/json") {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status,
      headers: { "content-type": contentType },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("createJob posts /jobs, sends X-API-Key + JSON body, returns job_id", async () => {
  const { impl, calls } = jsonFetch(201, {
    job_id: "job_123",
    latest_run: { status: "running", stats: { total: 2, completed: 0, successful: 0, failed: 0 } },
  });
  const body = { type: "regular", status: "closed", tasks: [{ url: "https://a.com" }] };
  const job = await createJob(body, { apiKey: "zr-key", fetchImpl: impl });

  assert.equal(job.job_id, "job_123");
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.match(call.url, /\/jobs$/);
  assert.equal(call.init?.method, "POST");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers["X-API-Key"], "zr-key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(call.init?.body)), body);
});

test("createJob treats 202 (>=10k tasks) as success", async () => {
  const { impl } = jsonFetch(202, {
    job_id: "job_big",
    latest_run: { status: "running", stats: { total: 12000, completed: 0, successful: 0, failed: 0 } },
  });
  const job = await createJob({ type: "regular", status: "closed", tasks: [] }, { apiKey: "k", fetchImpl: impl });
  assert.equal(job.job_id, "job_big");
});

test("getJob parses latest_run stats", async () => {
  const { impl, calls } = jsonFetch(200, {
    job_id: "job_1",
    latest_run: { status: "completed", stats: { total: 10, completed: 10, successful: 8, failed: 2 } },
  });
  const job = await getJob("job_1", { apiKey: "k", fetchImpl: impl });
  assert.equal(job.latest_run.status, "completed");
  assert.equal(job.latest_run.stats.successful, 8);
  assert.equal(job.latest_run.stats.failed, 2);
  assert.match(calls[0]!.url, /\/jobs\/job_1$/);
});

test("listResults paginates across >=2 cursor pages until next_cursor is null", async () => {
  const pages: ResultsPage[] = [
    { results: [{ task_id: "t1", external_id: "a", result_url: "u1" }], next_cursor: "c1" },
    { results: [{ task_id: "t2", external_id: "b", result_url: "u2" }], next_cursor: "c2" },
    { results: [{ task_id: "t3", external_id: "c", result_url: "u3" }], next_cursor: null },
  ];
  const seenCursors: Array<string | null> = [];
  let i = 0;
  const impl = (async (url: string) => {
    const u = new URL(url);
    seenCursors.push(u.searchParams.get("cursor"));
    const page = pages[i++]!;
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const rows = await listResults("job_1", { apiKey: "k", status: "successful", fetchImpl: impl });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.task_id), ["t1", "t2", "t3"]);
  // First page has no cursor; subsequent pages follow next_cursor.
  assert.deepEqual(seenCursors, [null, "c1", "c2"]);
});

test("stopJob posts /jobs/{id}/stop", async () => {
  const { impl, calls } = jsonFetch(200, {
    job_id: "job_1",
    latest_run: { status: "stopped", stats: { total: 5, completed: 3, successful: 3, failed: 0 } },
  });
  const job = await stopJob("job_1", { apiKey: "k", fetchImpl: impl });
  assert.equal(job.latest_run.status, "stopped");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.match(calls[0]!.url, /\/jobs\/job_1\/stop$/);
});

test("problem+json 403 maps to BATCH_ACCESS_DENIED", async () => {
  const { impl } = jsonFetch(
    403,
    { type: "about:blank", title: "Forbidden", status: 403, code: "forbidden", detail: "not invited to the beta" },
    "application/problem+json",
  );
  await assert.rejects(
    () => getJob("job_1", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BATCH_ACCESS_DENIED" && /not invited/.test(e.likely_cause),
  );
});

test("problem+json 429 quota_exceeded maps to BATCH_QUOTA_EXCEEDED", async () => {
  const { impl } = jsonFetch(
    429,
    { title: "Too Many Requests", status: 429, code: "quota_exceeded", detail: "max 3 concurrent active jobs" },
    "application/problem+json",
  );
  await assert.rejects(
    () => createJob({ type: "regular", status: "closed", tasks: [] }, { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BATCH_QUOTA_EXCEEDED",
  );
});

test("problem+json 404 maps to BATCH_NOT_FOUND", async () => {
  const { impl } = jsonFetch(404, { code: "not_found", detail: "job missing" }, "application/problem+json");
  await assert.rejects(
    () => getJob("nope", { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BATCH_NOT_FOUND",
  );
});

test("problem+json 400 surfaces invalid_tasks in the cause", async () => {
  const { impl } = jsonFetch(
    400,
    { code: "invalid_argument", detail: "validation failed", invalid_tasks: [{ index: 0, reason: "bad url" }] },
    "application/problem+json",
  );
  await assert.rejects(
    () => createJob({ type: "regular", status: "closed", tasks: [] }, { apiKey: "k", fetchImpl: impl }),
    (e: unknown) => e instanceof ToolkitError && e.code === "BATCH_FAILED" && /#0: bad url/.test(e.likely_cause),
  );
});

test("waitForJob polls until a terminal status", async () => {
  const statuses = ["running", "running", "completed"];
  let i = 0;
  const impl = (async () => {
    const status = statuses[Math.min(i++, statuses.length - 1)]!;
    return new Response(
      JSON.stringify({ job_id: "j", latest_run: { status, stats: { total: 1, completed: 1, successful: 1, failed: 0 } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const job = await waitForJob("j", { apiKey: "k", fetchImpl: impl, sleepImpl: async () => {} });
  assert.equal(job.latest_run.status, "completed");
  assert.equal(i, 3);
});
