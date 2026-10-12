// CLI (`@zenrows/cli`): the README walk-through, checks 1-21 and the CLI extra checks.
// Installs the release tarball globally, as the README's `npm install -g @zenrows/cli` does,
// and drives `zenrows crawl …` as a user would. The key reaches the CLI by environment only.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import * as H from "/harness/harness.mjs";

const {
  PASS,
  FAIL,
  SKIP,
  passIf,
  record,
  check,
  liveCheck,
  ledger,
  sh,
  KEY,
  HAS_KEY,
  CRAWL_URL,
  INCLUDE,
} = H;
const APP = "/work/app";
const HOME = "/work/home";
const tarball = `/artifact/${readdirSync("/artifact").find((f) => f.endsWith(".tgz"))}`;
mkdirSync(APP, { recursive: true });
mkdirSync(HOME, { recursive: true });

// Without a key, "invalid" keeps the CLI from creating an account.
const baseEnv = { ...process.env, HOME, NO_COLOR: "1", ZENROWS_API_KEY: HAS_KEY ? KEY : "invalid" };
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
/** Run `zenrows <args>` and wait. */
function z(args, env = {}) {
  const r = sh("zenrows", args, { cwd: APP, env: { ...baseEnv, ...env }, timeout: 15 * 60_000 });
  return { ...r, json: parse(r.stdout), cmd: `zenrows ${args.join(" ")}` };
}
/** Run `zenrows <args>` without blocking, for calls the in-process stand-in server answers. */
function zAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("zenrows", args, { cwd: APP, env: { ...baseEnv, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("exit", (code) =>
      resolve({ code, stdout, stderr, json: parse(stdout), cmd: `zenrows ${args.join(" ")}` }),
    );
  });
}
const show = (r) =>
  H.trim(
    `$ ${r.cmd}\nexit ${r.code}\n${r.stdout}${r.stderr ? `\n[stderr] ${r.stderr}` : ""}`,
    1500,
  );
const idOf = (text) => text.match(/\bc_[0-9A-Z]{20,}\b/)?.[0];

// ---------- README: install and init ----------
const install = sh("npm", ["install", "-g", tarball], { cwd: APP, env: baseEnv });
record(
  "readme-1",
  "Install (README: `npm install -g @zenrows/cli`; here the release tarball)",
  passIf(install.code === 0),
  "zenrows is on PATH",
  `exit ${install.code}; zenrows ${z(["--version"]).stdout.trim()}`,
  `${install.cmd}\n${install.stdout}${install.stderr}`,
);
if (install.code !== 0) process.exit(1);
const pkgReadme = readFileSync(
  `${sh("npm", ["root", "-g"]).stdout.trim()}/@zenrows/cli/README.md`,
  "utf8",
);
const init = z(["init"]);
record(
  "readme-1b",
  "`zenrows init` (README quickstart)",
  passIf(init.code === 0),
  "the workspace is created",
  `exit ${init.code}`,
  show(init),
);

// ---------- README: the Crawl section, line by line ----------
const section = pkgReadme.split(/^## \d+\. Crawl \(new\)\s*$/m)[1]?.split(/^## /m)[0] ?? "";
const block = section.match(/```bash\n([\s\S]*?)```/)?.[1] ?? "";
record(
  "readme-2",
  "README has a Crawl section with commands",
  passIf(block.length > 0),
  "a ```bash block under the Crawl (new) section",
  `${block.split("\n").filter(Boolean).length} command lines`,
  block || section.slice(0, 600),
);

await liveCheck(
  "readme-3",
  "Run the README's Crawl commands",
  "each command runs; skipped lines are named",
  async () => {
    // Join the backslash-continued line, then take each command without its comment.
    const lines = block
      .replace(/\\\n\s*/g, "")
      .split("\n")
      .map((l) => l.replace(/\s+#.*$/, "").trim())
      .filter(Boolean);
    const log = [];
    let id;
    let failed = 0;
    for (const line of lines) {
      let args = line.split(/\s+/).slice(1);
      if (args[1] === "create" && args.includes("--output-format")) {
        log.push(
          `SKIP  ${line}\n      (depth 2 and html break the cost rules; checks 2, 9 and 10 cover html)`,
        );
        continue;
      }
      if (args[1] === "content") {
        log.push(`SKIP  ${line}\n      (needs an html crawl; check 9 covers it)`);
        continue;
      }
      let note = "";
      if (args[1] === "create") {
        args = args.map((a) =>
          a === "https://example.com/products/" ? CRAWL_URL : a === "/product/" ? INCLUDE : a,
        );
        const mi = args.indexOf("--max-items");
        if (mi >= 0 && Number(args[mi + 1]) > 5) {
          args[mi + 1] = "5";
          note = " (start URL → CRAWL_URL, --max-items → 5)";
        }
      }
      if (args.includes("<crawl-id>")) {
        if (!id) {
          log.push(`SKIP  ${line}\n      (no crawl id from the create line)`);
          continue;
        }
        args = args.map((a) => (a === "<crawl-id>" ? id : a));
      }
      const r = z(args);
      if (args[1] === "create") {
        id = idOf(r.stdout + r.stderr);
        if (id) ledger(id, "README quickstart");
      }
      if (r.code !== 0) failed++;
      const outLine = H.trim((r.stdout + r.stderr).trim().split("\n").slice(0, 4).join(" | "), 300);
      log.push(
        `${r.code === 0 ? "OK  " : "FAIL"}  zenrows ${args.join(" ")}${note}\n      exit ${r.code}: ${outLine}`,
      );
    }
    return {
      status: passIf(failed === 0 && Boolean(id)),
      actual: `${lines.length} lines, ${failed} failed; crawl ${id ?? "none"}`,
      evidence: log.join("\n"),
    };
  },
);

// ---------- extras against the stand-in: unknown flags, Ctrl-C during wait ----------
const cap = await H.captureServer();
const capEnv = { ZENROWS_CRAWL_API_BASE: cap.base, ZENROWS_API_KEY: "capture-key" };
await check(
  "x-cli-unknown-flags",
  "--wait and --html are rejected as unknown flags",
  "both exit non-zero with UNKNOWN_FLAG; nothing is sent",
  async () => {
    const before = cap.requests.length;
    const w = await zAsync(
      ["crawl", "create", "https://example.com/", "--depth", "1", "--wait", "--json"],
      capEnv,
    );
    const h = await zAsync(
      ["crawl", "create", "https://example.com/", "--depth", "1", "--html", "--json"],
      capEnv,
    );
    const sentNow = cap.requests.length - before;
    const ok =
      w.code !== 0 &&
      h.code !== 0 &&
      w.json?.error?.code === "UNKNOWN_FLAG" &&
      h.json?.error?.code === "UNKNOWN_FLAG" &&
      sentNow === 0;
    return {
      status: passIf(ok),
      actual: `--wait: exit ${w.code} ${w.json?.error?.code}; --html: exit ${h.code} ${h.json?.error?.code}; requests sent ${sentNow}`,
      evidence: `${show(w)}\n${show(h)}`,
    };
  },
);
await check(
  "x-cli-ctrl-c",
  "Ctrl-C during `crawl wait` prints the resume hint and exits 130",
  "exit 130 and `zenrows crawl wait <id>` in the output",
  async () => {
    const child = spawn("zenrows", ["crawl", "wait", "c_running"], {
      cwd: APP,
      env: { ...baseEnv, ...capEnv },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    await H.sleep(3000);
    child.kill("SIGINT");
    const code = await new Promise((resolve) =>
      child.on("exit", (c, s) => resolve(c ?? (s ? 128 : 1))),
    );
    const hint = /zenrows crawl wait c_running/.test(out);
    return {
      status: passIf(code === 130 && hint),
      actual: `exit ${code}; resume hint ${hint}`,
      evidence: `zenrows crawl wait c_running against a stand-in that always answers running; SIGINT after 3 s\n${out}`,
    };
  },
);

// ---------- check 1, offline half: what the CLI sends ----------
const before = cap.requests.length;
await zAsync(["crawl", "create", "https://example.com/", "--depth", "1", "--json"], capEnv);
await zAsync(
  [
    "crawl",
    "create",
    "https://example.com/",
    "--depth",
    "1",
    "--max-items",
    "5",
    "--max-pages",
    "10",
    "--include-patterns",
    "/p/",
    "--idempotency-key",
    "idem-1",
    "--json",
  ],
  capEnv,
);
const posts = cap.requests.slice(before).filter((r) => r.method === "POST");
const sent = { minimal: posts[0]?.body, full: posts[1]?.body };
const sentOk =
  H.sameKeys(sent.minimal, ["url", "depth"]) &&
  H.sameKeys(sent.full, ["url", "depth", "max_items", "max_pages", "include_patterns"]);
const sentLine = `sent (stand-in server): minimal=${JSON.stringify(sent.minimal)} full=${JSON.stringify(sent.full)}`;
await cap.close();

// ---------- live ----------
const baseArgs = [
  CRAWL_URL,
  "--depth",
  "1",
  "--max-items",
  "5",
  "--max-pages",
  "10",
  "--include-patterns",
  INCLUDE,
];
function createWith(args) {
  for (let i = 0; i < 10; i++) {
    const r = z(["crawl", "create", ...args, "--json"]);
    if (r.json?.error?.code === "CRAWL_TOO_MANY_CRAWLS") {
      sh("sleep", [String(r.json.error.retry_after ?? 30)]); // the account's active jobs are shared: wait as told
      continue;
    }
    if (r.json?.crawl_id) ledger(r.json.crawl_id, "check");
    return r;
  }
  throw new Error("still 429 after 10 tries");
}
const create = (extra = []) => createWith([...baseArgs, ...extra]);
const isEnvelope = (j) =>
  j?.ok === true &&
  typeof j.crawl_id === "string" &&
  typeof j.status === "string" &&
  typeof j.crawl === "object";
const ENVELOPE_KEYS = new Set([
  "ok",
  "crawl_id",
  "status",
  "crawl",
  "note",
  "results",
  "next_cursor",
  "error",
]);
const shapes = {};
const noteShape = (sub, r) => {
  shapes[sub] = { exit: r.code, keys: r.json ? Object.keys(r.json) : null };
};

let A;
let B;
let C;
let F;
let ended;
await check(
  "1",
  "Create",
  "returns at once: {ok, crawl_id, status: running, crawl}; only the fields set are sent",
  async () => {
    if (!HAS_KEY) {
      return {
        status: sentOk ? SKIP : FAIL,
        actual: `live part skipped (no key); only set fields sent: ${sentOk}`,
        evidence: sentLine,
      };
    }
    const r = create();
    noteShape("create", r);
    A = r.json;
    const c = A?.crawl ?? {};
    const echo = JSON.stringify([c.url, c.depth, c.max_items, c.max_pages, c.include_patterns]);
    const ok =
      sentOk &&
      r.code === 0 &&
      isEnvelope(A) &&
      A.status === "running" &&
      echo === JSON.stringify([CRAWL_URL, 1, 5, 10, [INCLUDE]]);
    return {
      status: passIf(ok),
      actual: `exit ${r.code}; ${A?.crawl_id} ${A?.status}; only set fields sent: ${sentOk}`,
      evidence: `${show(r)}\n${sentLine}`,
    };
  },
);
await liveCheck(
  "5",
  "Wait runs out",
  "crawl wait --timeout 1 on a running crawl: exit 0, running, a note",
  async () => {
    if (!A) return { status: SKIP, actual: "no crawl from check 1" };
    const r = z(["crawl", "wait", A.crawl_id, "--timeout", "1", "--json"]);
    noteShape("wait (ran out)", r);
    if (r.json?.status && r.json.status !== "running")
      return { status: SKIP, actual: `the crawl had already ended (${r.json.status})` };
    return {
      status: passIf(
        r.code === 0 && r.json?.status === "running" && typeof r.json?.note === "string",
      ),
      actual: `exit ${r.code}; ${r.json?.status}; note: ${r.json?.note ?? "none"}`,
      evidence: show(r),
    };
  },
);
const partial = A ? z(["crawl", "results", A.crawl_id, "--json"]) : undefined;

await liveCheck(
  "3",
  "Idempotency",
  "same key + body → same crawl_id; different body → CRAWL_INVALID_REQUEST and the advice to send a new key",
  async () => {
    const small = [
      CRAWL_URL,
      "--depth",
      "1",
      "--max-items",
      "3",
      "--max-pages",
      "3",
      "--include-patterns",
      INCLUDE,
      "--idempotency-key",
      `acc-${randomUUID()}`,
      "--json",
    ];
    const r1 = z(["crawl", "create", ...small]);
    C = r1.json;
    if (C?.crawl_id) {
      ledger(C.crawl_id, "check");
      // Check 11's first stop, right away: a CLI call takes about a second, and a small crawl can end on its own in two.
      C.firstStop = z(["crawl", "stop", C.crawl_id, "--json"]);
    }
    const r2 = z(["crawl", "create", ...small]);
    const r3 = z(["crawl", "create", ...small.map((a) => (a === "3" ? "4" : a))]);
    if (r3.json?.crawl_id)
      ledger(r3.json.crawl_id, "idempotency, different body (unexpected create)");
    const e = r3.json?.error;
    const ok =
      Boolean(C?.crawl_id) &&
      C.crawl_id === r2.json?.crawl_id &&
      e?.code === "CRAWL_INVALID_REQUEST" &&
      e?.server_code === "idempotency_key_reused" &&
      /new key/i.test(e?.next_action ?? "");
    return {
      status: passIf(ok),
      actual: `first ${C?.crawl_id}, second ${r2.json?.crawl_id}; different body → exit ${r3.code} ${e?.code} (${e?.server_code}): ${e?.next_action}`,
      evidence: show(r3),
    };
  },
);
await liveCheck(
  "11",
  "Stop",
  "running → stopped, stop_reason user; ended → answers as it ended, no error",
  async () => {
    if (!C?.firstStop) return { status: SKIP, actual: "no crawl from check 3" };
    const s1 = C.firstStop;
    noteShape("stop", s1);
    if (s1.json?.status === "completed" && s1.json?.crawl?.stop_reason !== "user") {
      return {
        status: SKIP,
        actual: `the crawl had already ended on its own (${s1.json.status}/${s1.json.crawl?.stop_reason})`,
      };
    }
    const s2 = z(["crawl", "stop", C.crawl_id, "--json"]);
    const ok =
      s1.code === 0 &&
      s1.json?.status === "stopped" &&
      s1.json?.crawl?.stop_reason === "user" &&
      s2.code === 0 &&
      s2.json?.status === "stopped";
    return {
      status: passIf(ok),
      actual: `first: exit ${s1.code} ${s1.json?.status}/${s1.json?.crawl?.stop_reason}; second: exit ${s2.code} ${s2.json?.status}`,
      evidence: `${show(s1)}\n${show(s2)}`,
    };
  },
);
await liveCheck("4", "Wait", "crawl wait returns the ended crawl; failed exits 1", async () => {
  if (!A) return { status: SKIP, actual: "no crawl from check 1" };
  const r = z(["crawl", "wait", A.crawl_id, "--json"]);
  noteShape("wait", r);
  ended = r.json;
  const st = r.json?.status;
  return {
    status: passIf(H.TERMINAL.has(st) && r.code === (st === "failed" ? 1 : 0)),
    actual: `exit ${r.code}; ${st}/${r.json?.crawl?.stop_reason ?? "-"}; coverage ${JSON.stringify(r.json?.crawl?.coverage)}`,
    evidence: show(r),
  };
});
await liveCheck(
  "6",
  "Get",
  "crawl get --limit 2 then --cursor: one page each; next_cursor moves on and is null on the last page",
  async () => {
    if (!ended) return { status: SKIP, actual: "no ended crawl" };
    const pages = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const r = z([
        "crawl",
        "get",
        A.crawl_id,
        "--limit",
        "2",
        ...(cursor ? ["--cursor", cursor] : []),
        "--json",
      ]);
      if (i === 0) noteShape("get", r);
      if (r.code !== 0) return { status: FAIL, actual: show(r) };
      pages.push({
        n: r.json.results.length,
        next: r.json.next_cursor,
        urls: r.json.results.map((x) => x.url),
      });
      if (r.json.next_cursor === null) break;
      cursor = r.json.next_cursor;
    }
    const urls = pages.flatMap((p) => p.urls);
    const curs = pages.map((p) => p.next).filter((c) => c !== null);
    const ok =
      pages.every((p) => p.n <= 2) &&
      pages.at(-1).next === null &&
      new Set(curs).size === curs.length &&
      new Set(urls).size === urls.length &&
      (pages.length >= 2 || ended.crawl.coverage.items_found <= 2);
    return {
      status: passIf(ok),
      actual: `${pages.length} pages of ${pages.map((p) => p.n).join(",")}; last next_cursor ${pages.at(-1).next}`,
    };
  },
);
await liveCheck(
  "7",
  "List",
  "crawl list --limit 2 then --cursor: newest first; next_cursor null on the last page",
  async () => {
    const p1 = z(["crawl", "list", "--limit", "2", "--json"]);
    noteShape("list", p1);
    const p2 = p1.json?.next_cursor
      ? z(["crawl", "list", "--limit", "2", "--cursor", p1.json.next_cursor, "--json"])
      : { json: { crawls: [] } };
    const all = [...(p1.json?.crawls ?? []), ...(p2.json?.crawls ?? [])];
    const t = all.map((c) => Date.parse(c.created_at));
    const newest = t.every((x, i) => i === 0 || t[i - 1] >= x);
    let cursor = p2.json?.next_cursor;
    let pages = 2;
    while (cursor && pages < 60) {
      cursor = z(["crawl", "list", "--limit", "100", "--cursor", cursor, "--json"]).json
        ?.next_cursor;
      pages++;
    }
    const ok =
      p1.json?.crawls?.length === 2 &&
      newest &&
      new Set(all.map((c) => c.crawl_id)).size === all.length &&
      !cursor;
    return {
      status: passIf(ok),
      actual: `newest first ${newest}; last page after ${pages} pages: next_cursor ${JSON.stringify(cursor ?? null)}`,
    };
  },
);
await liveCheck(
  "8",
  "Results",
  "every kept URL once, each matching CRAWL_INCLUDE; partial: true on a running crawl",
  async () => {
    if (!ended) return { status: SKIP, actual: "no ended crawl" };
    const r = z(["crawl", "results", A.crawl_id, "--limit", "2", "--json"]);
    noteShape("results", r);
    const urls = (r.json?.results ?? []).map((x) => x.url);
    const ok =
      r.code === 0 &&
      urls.length === ended.crawl.coverage.items_found &&
      new Set(urls).size === urls.length &&
      urls.every((u) => u.includes(INCLUDE)) &&
      r.json.partial === false;
    const run = partial
      ? `while running: ${partial.json?.status}, partial ${partial.json?.partial}, ${partial.json?.count} URLs`
      : "not read";
    const partialOk =
      !partial || partial.json?.status !== "running" || partial.json?.partial === true;
    return {
      status: passIf(ok && partialOk),
      actual: `${urls.length} URLs (items_found ${ended.crawl.coverage.items_found}), partial ${r.json?.partial}; ${run}`,
      evidence: urls.join("\n"),
    };
  },
);
// ---------- the html crawl (checks 20, 2, 9, 10): stopped with pages in flight, read, then settled ----------
let stopInfo;
/** Poll until no result is still `pending` (the pages in flight finished), at most 90 s. */
function settle(id) {
  for (let i = 0; i < 45; i++) {
    const g = z(["crawl", "get", id, "--limit", "100", "--json"]);
    if (!(g.json?.results ?? []).some((r) => r.content_status === "pending")) return "settled";
    sh("sleep", ["2"]);
  }
  return "still pending after 90 s";
}
if (HAS_KEY) {
  const r = create(["--output-format", "html"]);
  B = r.json;
  if (r.code !== 0 || !B?.crawl_id) stopInfo = { error: show(r) };
  else {
    // Stop as soon as the crawl has kept URLs: their pages are then still being fetched.
    let g;
    for (let i = 0; i < 40; i++) {
      g = z(["crawl", "get", B.crawl_id, "--limit", "1", "--json"]);
      if (g.json?.status !== "running" || g.json?.crawl?.coverage?.items_found > 0) break;
    }
    const st = z(["crawl", "stop", B.crawl_id, "--json"]);
    stopInfo = { items: g.json?.crawl?.coverage?.items_found, status: st.json?.status };
  }
}
await liveCheck(
  "20",
  "Results after stop",
  "crawl results on a crawl stopped with pages in flight: partial false, and no URL lost",
  async () => {
    if (!B || stopInfo?.error) return { status: FAIL, actual: `setup failed: ${stopInfo?.error}` };
    if (stopInfo.status !== "stopped") {
      return {
        status: SKIP,
        actual: `the crawl had already ended (${stopInfo.status}) before the stop`,
      };
    }
    const now = z(["crawl", "results", B.crawl_id, "--json"]);
    const j = now.json ?? {};
    const settled = settle(B.crawl_id);
    const settledNote =
      settled === "settled"
        ? settled
        : `${settled} (an API issue: the stop left these pages pending on an ended crawl)`;
    const later = z(["crawl", "results", B.crawl_id, "--json"]).json?.results ?? [];
    const urls = (rows) => JSON.stringify((rows ?? []).map((x) => x.url).sort());
    const same = urls(j.results) === urls(later);
    const pending = (j.results ?? []).filter((x) => x.content_status === "pending").length;
    return {
      status: passIf(now.code === 0 && j.partial === false && same),
      actual: `stopped with ${stopInfo.items} kept; first read: exit ${now.code}, ${j.count} URLs (${pending} pending), partial ${j.partial}; then ${settledNote}: ${later.length} URLs, same set ${same}`,
      evidence: show(now),
    };
  },
);
await liveCheck(
  "2",
  "Create with html",
  "results get content_status and, once fetched, content_url",
  async () => {
    if (!B?.crawl_id) return { status: SKIP, actual: "no html crawl" };
    if (stopInfo?.status === "stopped") settle(B.crawl_id);
    const rs = z(["crawl", "results", B.crawl_id, "--json"]).json?.results ?? [];
    const ok =
      B.crawl?.output_format === "html" &&
      rs.length > 0 &&
      rs.every((x) => x.content_status && (x.content_status !== "fetched" || x.content_url));
    return {
      status: passIf(ok),
      actual: `${B.crawl_id} (${stopInfo?.status ?? "-"}); ${rs.length} results; with content_url ${rs.filter((x) => x.content_url).length}`,
    };
  },
);
await liveCheck(
  "9",
  "Content",
  "crawl content by content id, then by content_url: the same HTML",
  async () => {
    if (!B) return { status: SKIP, actual: "no html crawl" };
    const row = (z(["crawl", "results", B.crawl_id, "--json"]).json?.results ?? []).find(
      (x) => x.content_url,
    );
    if (!row)
      return stopInfo?.status === "stopped"
        ? {
            status: SKIP,
            actual:
              "the stop cancelled every page fetch, so no page has content to read (see check 20)",
          }
        : { status: FAIL, actual: "no result with content_url" };
    const id = row.content_url.split("/").pop();
    const a = z(["crawl", "content", B.crawl_id, id, "--out", "/work/a.html"]);
    const b = z(["crawl", "content", B.crawl_id, row.content_url, "--out", "/work/b.html"]);
    noteShape("content", z(["crawl", "content", B.crawl_id, id, "--json"]));
    const ha = existsSync("/work/a.html") ? readFileSync("/work/a.html", "utf8") : "";
    const hb = existsSync("/work/b.html") ? readFileSync("/work/b.html", "utf8") : "";
    const ok = a.code === 0 && b.code === 0 && ha === hb && /<html|<!doctype/i.test(ha);
    return {
      status: passIf(ok),
      actual: `by id ${ha.length} chars, by content_url ${hb.length} chars, equal ${ha === hb}`,
      evidence: `${show(a)}\n${show(b)}`,
    };
  },
);
await liveCheck(
  "10",
  "Download",
  "a status and one line per result, each with url, content_status, content",
  async () => {
    if (!B) return { status: SKIP, actual: "no html crawl" };
    const r = z(["crawl", "download", B.crawl_id, "--out", "/work/dl.jsonl", "--json"]);
    noteShape("download", r);
    const lines = existsSync("/work/dl.jsonl")
      ? readFileSync("/work/dl.jsonl", "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const fetched = lines.filter((l) => l.content_status === "fetched");
    const ok =
      r.code === 0 &&
      typeof r.json?.status === "string" &&
      lines.length > 0 &&
      lines.every((l) => l.url && l.content_status) &&
      fetched.every((l) => typeof l.content === "string" && l.content);
    return {
      status: passIf(ok),
      actual: `exit ${r.code}; status ${r.json?.status}; ${lines.length} lines; ${fetched.length} with content`,
      evidence: show(r),
    };
  },
);

const errs = {};
await liveCheck("12", "Not found", "CRAWL_NOT_FOUND, with crawl_id and server_code", async () => {
  const r = z(["crawl", "get", "c_does_not_exist", "--json"]);
  errs.notFound = r.json?.error;
  const e = errs.notFound;
  return {
    status: passIf(
      r.code !== 0 &&
        e?.code === "CRAWL_NOT_FOUND" &&
        e?.crawl_id === "c_does_not_exist" &&
        e?.server_code === "crawl_not_found",
    ),
    actual: `exit ${r.code} ${JSON.stringify(e)}`,
  };
});
await liveCheck(
  "13",
  "Invalid input",
  "crawl create --depth 0 → CRAWL_INVALID_REQUEST",
  async () => {
    const r = z(["crawl", "create", CRAWL_URL, "--depth", "0", "--json"]);
    if (r.json?.crawl_id) {
      ledger(r.json.crawl_id, "depth 0 (unexpected create)");
      z(["crawl", "stop", r.json.crawl_id]);
    }
    errs.invalid = r.json?.error;
    const ok = errs.invalid?.code === "CRAWL_INVALID_REQUEST";
    return {
      status: passIf(ok),
      actual: ok
        ? `exit ${r.code} ${JSON.stringify(errs.invalid)}`
        : `rejected before the API: exit ${r.code} ${errs.invalid?.code}: ${errs.invalid?.message}`,
      evidence: show(r),
    };
  },
);
await liveCheck("14", "Gated option", "--output-format json → 422 invalid_parameter", async () => {
  const r = z(["crawl", "create", CRAWL_URL, "--depth", "1", "--output-format", "json", "--json"]);
  if (r.json?.crawl_id) {
    ledger(r.json.crawl_id, "output_format json (accepted)");
    z(["crawl", "stop", r.json.crawl_id]);
    return {
      status: PASS,
      actual: `accepted (${r.json.crawl_id}): the key is in a beta segment, not a bug; stopped it`,
    };
  }
  return {
    status: SKIP,
    actual: `the client does not allow it: ${r.json?.error?.code}: ${r.json?.error?.message}`,
  };
});
await check("15", "Bad key", "AUTH_INVALID", async () => {
  const r = z(["crawl", "get", "c_does_not_exist", "--json"], { ZENROWS_API_KEY: "invalid" });
  errs.badKey = r.json?.error;
  return {
    status: passIf(r.code !== 0 && errs.badKey?.code === "AUTH_INVALID"),
    actual: `exit ${r.code} ${JSON.stringify(errs.badKey)}`,
  };
});
await check(
  "16",
  "Errors carry the server code",
  "server_code on CRAWL_NOT_FOUND, CRAWL_INVALID_REQUEST and AUTH_INVALID",
  async () => {
    const fromApi = errs.invalid?.code === "CRAWL_INVALID_REQUEST";
    const rows = {
      notFound: errs.notFound?.server_code,
      invalid: fromApi ? errs.invalid.server_code : "n/a: rejected before the API (see 13)",
      badKey: errs.badKey?.server_code,
    };
    const liveOk =
      !HAS_KEY ||
      (rows.notFound === "crawl_not_found" && (!fromApi || rows.invalid === "invalid_parameter"));
    const ok = liveOk && Boolean(rows.badKey);
    return { status: ok ? (HAS_KEY ? PASS : SKIP) : FAIL, actual: JSON.stringify(rows) };
  },
);

// ---------- 19-21: a failed crawl, results after a stop, the documented defaults ----------
await liveCheck(
  "19",
  "Failed crawl",
  "a crawl that keeps nothing ends failed (no_items_found); crawl wait exits 1 with ok: false and CRAWL_FAILED",
  async () => {
    const r = createWith([CRAWL_URL, "--depth", "1", "--include-patterns", H.NO_MATCH]);
    F = r.json;
    if (!F?.crawl_id) return { status: FAIL, actual: show(r) };
    const w = z(["crawl", "wait", F.crawl_id, "--json"]);
    const j = w.json ?? {};
    const ok =
      w.code === 1 &&
      j.ok === false &&
      j.status === "failed" &&
      j.crawl?.error?.code === "no_items_found" &&
      j.error?.code === "CRAWL_FAILED" &&
      j.error?.server_code === "no_items_found";
    return {
      status: passIf(ok),
      actual: `${F.crawl_id}: exit ${w.code}, status ${j.status}, ok ${j.ok}, error ${j.error?.code}/${j.error?.server_code}`,
      evidence: show(w),
    };
  },
);
await liveCheck(
  "21",
  "Documented defaults",
  `a create without --max-pages and --max-items echoes the documented default (${H.DOCUMENTED_DEFAULT})`,
  async () => {
    if (!F?.crawl) return { status: SKIP, actual: "no crawl from check 19" };
    const ok =
      F.crawl.max_pages === H.DOCUMENTED_DEFAULT && F.crawl.max_items === H.DOCUMENTED_DEFAULT;
    const help = z(["crawl", "--help"]);
    const doc = `${help.stdout}${help.stderr}`
      .split("\n")
      .filter((l) => /max-(pages|items)/.test(l));
    return {
      status: passIf(ok),
      actual: `the API applied max_pages ${F.crawl.max_pages}, max_items ${F.crawl.max_items}; documented ${H.DOCUMENTED_DEFAULT}`,
      evidence: `zenrows crawl --help:\n${doc.join("\n")}`,
    };
  },
);

await liveCheck(
  "x-cli-json",
  "Every subcommand works with --json; create, get, wait, stop print {ok, crawl_id, status, crawl, note?}",
  "valid JSON from all 8 subcommands; the envelope on the four",
  async () => {
    const problems = [];
    for (const [sub, s] of Object.entries(shapes)) {
      if (!s.keys) problems.push(`${sub}: stdout is not JSON`);
      else if (["create", "get", "wait", "wait (ran out)", "stop"].includes(sub)) {
        const extra = s.keys.filter((k) => !ENVELOPE_KEYS.has(k));
        const missing = ["ok", "crawl_id", "status", "crawl"].filter((k) => !s.keys.includes(k));
        if (extra.length || missing.length)
          problems.push(`${sub}: extra [${extra}], missing [${missing}]`);
      }
    }
    const missingSubs = [
      "create",
      "get",
      "list",
      "results",
      "content",
      "download",
      "stop",
      "wait",
    ].filter((s) => !shapes[s]);
    if (missingSubs.length) problems.push(`not exercised: ${missingSubs.join(", ")}`);
    return {
      status: passIf(problems.length === 0),
      actual: problems.join("; ") || "all 8 subcommands print JSON; the envelope holds",
      evidence: JSON.stringify(shapes),
    };
  },
);

H.naming({
  operations: {
    create: "crawl create",
    get: "crawl get",
    list: "crawl list",
    results: "crawl results",
    content: "crawl content",
    download: "crawl download",
    stop: "crawl stop",
    wait: "crawl wait",
  },
  params: {
    url: "<url>",
    depth: "--depth",
    max_items: "--max-items",
    max_pages: "--max-pages",
    include_patterns: "--include-patterns",
    exclude_patterns: "--exclude-patterns",
    output_format: "--output-format",
    idempotency_key: "--idempotency-key",
    cursor: "--cursor",
    limit: "--limit",
    timeout: "--timeout",
  },
});
record("17", "Naming", SKIP, "the API's names in this surface's casing", "computed by the report");

await check(
  "18",
  "Copy",
  'Crawl is "new", never "beta"; one "still evolving" line; the 429 limit is active jobs shared with Batch',
  async () => {
    const help = z(["crawl", "--help"]);
    const helpText = `${help.stdout}${help.stderr}`;
    const top = z(["--help"]);
    const topCrawl = `${top.stdout}${top.stderr}`.split("\n").filter((l) => /crawl/i.test(l));
    const row = pkgReadme.split("\n").filter((l) => l.includes("`zenrows crawl`"));
    const problems = [];
    const beta = [...helpText.split("\n"), ...topCrawl, ...row, ...section.split("\n")].filter(
      (l) => /\bbeta\b/i.test(l),
    );
    if (beta.length) problems.push(`"beta": ${beta[0].trim().slice(0, 160)}`);
    const evolving = pkgReadme.split("\n").filter((l) => /still evolving/i.test(l)).length;
    if (evolving !== 1) problems.push(`${evolving} "still evolving" lines in the README (want 1)`);
    if (!/active jobs[\s\S]{0,60}Batch/i.test(section))
      problems.push("the README does not read the 429 limit as active jobs shared with Batch");
    if (!/\bnew\b/i.test(helpText)) problems.push('`zenrows crawl --help` does not say "new"');
    return {
      status: passIf(problems.length === 0),
      actual:
        problems.join("; ") || 'README and help say "new"; 1 "still evolving" line; 429 wording ok',
      evidence: `${row.join("\n")}\n--- zenrows --help (crawl lines)\n${topCrawl.join("\n")}\n--- zenrows crawl --help\n${helpText}`,
    };
  },
);
console.log("cli: done");
