import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { batch } from "../src/cli/commands/batch.ts";
import { createWorkspace } from "../src/core/workspace.ts";
import { savePolicy, defaultPolicy } from "../src/core/policy.ts";
import { saveApiKey } from "../src/core/auth.ts";
import { tempRoot } from "./helpers.ts";

const ctx = { json: true, yes: false };

/**
 * Run `fn` inside a fresh initialized workspace with a saved key, applying the
 * given policy. A fetch stub records whether ANY network call was attempted so
 * pre-flight (local) governance can be proven to fire before the wire.
 */
function withBatchWorkspace(
  policy: Partial<ReturnType<typeof defaultPolicy>>,
  fn: (didFetch: () => boolean) => Promise<void>,
): Promise<void> {
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  savePolicy({ ...defaultPolicy(), ...policy }, root);
  saveApiKey("0".repeat(41), root);
  process.chdir(root);
  let fetched = false;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response(JSON.stringify({ job_id: "j1", latest_run: { status: "queued" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return fn(() => fetched).finally(() => {
    globalThis.fetch = orig;
    process.chdir(cwd);
    cleanup();
  });
}

function writeSpec(urls: string[]): string {
  const file = join(process.cwd(), "jobs.jsonl");
  writeFileSync(file, urls.map((u) => JSON.stringify({ url: u })).join("\n") + "\n");
  return file;
}

test("batch create rejects a blocked-domain task before any network call", async () => {
  await withBatchWorkspace({ blocked_domains: ["blocked.example"] }, async (didFetch) => {
    const file = writeSpec(["https://ok.example/a", "https://blocked.example/b"]);
    const code = await batch.run(["create", file], ctx);
    assert.equal(code, 1);
    assert.equal(didFetch(), false, "blocked task must be rejected before submitting");
  });
});

test("batch create rejects a run over the page cap before any network call", async () => {
  await withBatchWorkspace({ max_pages_per_run: 1 }, async (didFetch) => {
    const file = writeSpec(["https://ok.example/a", "https://ok.example/b"]);
    const code = await batch.run(["create", file], ctx);
    assert.equal(code, 1);
    assert.equal(didFetch(), false, "over-cap run must be rejected before submitting");
  });
});

test("batch create rejects a run over the credit cap before any network call", async () => {
  // Two premium+js tasks ≈ 50 credits; cap at 10 → blocked.
  await withBatchWorkspace({ max_credits_per_run: 10 }, async (didFetch) => {
    const file = join(process.cwd(), "jobs.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ url: "https://ok.example/a", js_render: true, premium_proxy: true }),
        JSON.stringify({ url: "https://ok.example/b", js_render: true, premium_proxy: true }),
      ].join("\n") + "\n",
    );
    const code = await batch.run(["create", file], ctx);
    assert.equal(code, 1);
    assert.equal(didFetch(), false, "over-credit-cap run must be rejected before submitting");
  });
});

test("batch create submits when the run is within policy caps", async () => {
  await withBatchWorkspace({ max_pages_per_run: 10, max_credits_per_run: 100 }, async (didFetch) => {
    const file = writeSpec(["https://ok.example/a", "https://ok.example/b"]);
    const code = await batch.run(["create", file], ctx);
    assert.equal(code, 0);
    assert.equal(didFetch(), true, "an in-policy run must reach the Batch API");
  });
});

test("batch create rejects an unknown --output format before any network call", async () => {
  await withBatchWorkspace({}, async (didFetch) => {
    const file = writeSpec(["https://ok.example/a"]);
    const code = await batch.run(["create", file, "--output", "bogus"], ctx);
    assert.equal(code, 1);
    assert.equal(didFetch(), false, "an unknown --output must fail loudly, not silently drop");
  });
});

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

test("batch estimate --json emits an {ok,...} envelope (ok reflects spec validity)", async () => {
  await withBatchWorkspace({}, async () => {
    const good = writeSpec(["https://ok.example/a"]);
    const okOut = await captureOut(() => batch.run(["estimate", good], ctx));
    const okJson = JSON.parse(okOut) as { ok: boolean; estimatedCredits: number };
    assert.equal(okJson.ok, true);
    assert.equal(typeof okJson.estimatedCredits, "number");

    // A spec with a bad line → ok:false (and the command's exit code is 1).
    const bad = join(process.cwd(), "bad.jsonl");
    writeFileSync(bad, '{"url":"https://ok.example/a"}\nnot-json\n');
    const badOut = await captureOut(() => batch.run(["estimate", bad], ctx));
    const badJson = JSON.parse(badOut) as { ok: boolean };
    assert.equal(badJson.ok, false);
  });
});

/** Run `fn` in a workspace whose Batch API always answers with `job`. */
function withJobResponse(job: unknown, fn: () => Promise<void>): Promise<void> {
  const { root, cleanup } = tempRoot();
  const cwd = process.cwd();
  createWorkspace(root);
  savePolicy(defaultPolicy(), root);
  saveApiKey("0".repeat(41), root);
  process.chdir(root);
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(job), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
    process.chdir(cwd);
    cleanup();
  });
}

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

const capFailedJob = {
  job_id: "j_cap",
  latest_run: {
    status: "failed",
    stats: { total: 3, completed: 1, successful: 1, failed: 0 },
    failure_reason: "api_key_cap_reached",
    failure_detail: "This API key reached its weekly credit cap of 100. It resets on 2026-10-05.",
  },
};

test("batch status on a run the key cap stopped exits 1, ok:false, with reason, detail, and cap guidance", async () => {
  await withJobResponse(capFailedJob, async () => {
    let code = -1;
    const out = await captureOut(async () => {
      code = await batch.run(["status", "j_cap"], ctx);
    });
    assert.equal(code, 1);
    const j = JSON.parse(out) as Record<string, any>;
    assert.equal(j.ok, false);
    assert.equal(j.status, "failed");
    assert.equal(j.failure_reason, "api_key_cap_reached");
    assert.match(j.failure_detail, /weekly credit cap/);
    assert.equal(j.error.code, "KEY_CREDIT_CAP_REACHED");
    assert.match(j.error.next_action, /settings\/api-keys/);
    // The status call itself succeeded, so the cause must not cite an HTTP 402.
    assert.doesNotMatch(j.error.likely_cause, /HTTP 402/);
    assert.match(j.error.likely_cause, /Stopped batch job j_cap/);
  });
});

test("batch wait (human) on a cap-failed run prints reason and detail, no success mark, exits 1", async () => {
  await withJobResponse(capFailedJob, async () => {
    let code = -1;
    const err = await captureErr(async () => {
      code = await batch.run(["wait", "j_cap"], { json: false, yes: false });
    });
    assert.equal(code, 1);
    assert.doesNotMatch(err, /✓/);
    assert.match(err, /failure_reason: api_key_cap_reached/);
    assert.match(err, /failure_detail: .*weekly credit cap/);
    assert.match(err, /KEY_CREDIT_CAP_REACHED/);
  });
});

test("batch status on a run failed for another reason exits 1 with BATCH_FAILED", async () => {
  await withJobResponse(
    { job_id: "j_f", latest_run: { status: "failed", stats: { total: 1, completed: 0, successful: 0, failed: 0 }, failure_reason: "internal_error", failure_detail: "boom" } },
    async () => {
      let code = -1;
      const out = await captureOut(async () => {
        code = await batch.run(["status", "j_f"], ctx);
      });
      assert.equal(code, 1);
      const j = JSON.parse(out) as Record<string, any>;
      assert.equal(j.ok, false);
      assert.equal(j.error.code, "BATCH_FAILED");
      assert.match(j.error.likely_cause, /internal_error: boom/);
    },
  );
});

test("batch status on completed and stopped runs exits 0 with ok:true", async () => {
  for (const status of ["completed", "stopped"]) {
    await withJobResponse({ job_id: "j_ok", latest_run: { status, stats: { total: 1, completed: 1, successful: 1, failed: 0 } } }, async () => {
      let code = -1;
      const out = await captureOut(async () => {
        code = await batch.run(["status", "j_ok"], ctx);
      });
      assert.equal(code, 0, status);
      const j = JSON.parse(out) as Record<string, any>;
      assert.equal(j.ok, true, status);
      assert.equal(j.error, undefined, status);
    });
  }
});

test("batch create --wait whose run the cap stops exits 1 with ok:false", async () => {
  await withJobResponse(capFailedJob, async () => {
    const file = writeSpec(["https://ok.example/a"]);
    let code = -1;
    const out = await captureOut(async () => {
      code = await batch.run(["create", file, "--wait"], ctx);
    });
    assert.equal(code, 1);
    const j = JSON.parse(out) as Record<string, any>;
    assert.equal(j.ok, false);
    assert.equal(j.failure_reason, "api_key_cap_reached");
  });
});

test("batch create sends mode=auto per task by default; --manual and --js-render opt out", async () => {
  const bodies: Array<{ tasks: Array<{ zenrows_params?: Record<string, string> }>; zenrows_params?: Record<string, string> }> = [];
  await withBatchWorkspace({}, async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ job_id: "j1", latest_run: { status: "queued" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const file = writeSpec(["https://ok.example/a", "https://ok.example/b"]);
      await captureOut(() => batch.run(["create", file], ctx));
      await captureOut(() => batch.run(["create", file, "--manual"], ctx));
      await captureOut(() => batch.run(["create", file, "--js-render"], ctx));
      await captureOut(() => batch.run(["create", file, "--proxy-country", "us"], ctx));
    } finally {
      globalThis.fetch = orig;
    }
  });
  assert.equal(bodies.length, 4);
  assert.deepEqual(bodies[0]!.tasks.map((t) => t.zenrows_params?.mode), ["auto", "auto"]);
  assert.deepEqual(bodies[1]!.tasks.map((t) => t.zenrows_params?.mode), [undefined, undefined]);
  assert.deepEqual(bodies[2]!.tasks.map((t) => t.zenrows_params?.mode), [undefined, undefined]);
  assert.equal(bodies[2]!.zenrows_params?.js_render, "true");
  assert.deepEqual(bodies[3]!.tasks.map((t) => t.zenrows_params?.mode), ["auto", "auto"]);
  assert.equal(bodies[3]!.zenrows_params?.proxy_country, "us");
});

test("batch estimate counts Adaptive Stealth Mode as the upper bound, --manual as basic", async () => {
  await withBatchWorkspace({}, async () => {
    const file = writeSpec(["https://ok.example/a", "https://ok.example/b"]);
    const auto = JSON.parse(await captureOut(() => batch.run(["estimate", file], ctx))) as { estimatedCredits: number };
    const manual = JSON.parse(await captureOut(() => batch.run(["estimate", file, "--manual"], ctx))) as { estimatedCredits: number };
    assert.equal(auto.estimatedCredits, 50);
    assert.equal(manual.estimatedCredits, 2);
  });
});
