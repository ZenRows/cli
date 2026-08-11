import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(process.cwd(), "agent-plugin");

test("agent-plugin plugin.json is Agent Plugins 1.0", () => {
  const plugin = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")) as Record<string, unknown>;
  assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(plugin.name, "zenrows");
  assert.ok(typeof plugin.version === "string" && plugin.version.length > 0);
  // closed schema: no unknown top-level keys beyond the known set
  const allowed = new Set([
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ]);
  for (const key of Object.keys(plugin)) {
    assert.ok(allowed.has(key), `unexpected plugin.json field: ${key}`);
  }
});

test("agent-plugin mcp.json declares stdio and streamable-http without secrets", () => {
  const mcp = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")) as {
    $schema: string;
    mcpServers: Record<string, Record<string, unknown>>;
  };
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  const servers = mcp.mcpServers;
  assert.ok(servers);

  const stdio = Object.values(servers).find((s) => s.type === "stdio");
  assert.ok(stdio, "expected a stdio server");
  assert.equal(stdio.command, "npx");
  assert.deepEqual(stdio.args, ["-y", "@zenrows/mcp"]);
  assert.equal(stdio.env, undefined, "must not embed API keys in env");

  const http = Object.values(servers).find((s) => s.type === "streamable-http");
  assert.ok(http, "expected a streamable-http server");
  assert.equal(http.url, "https://mcp.zenrows.com/mcp");
  assert.equal(http.headers, undefined, "must not embed secrets in headers");
});

test("agent-plugin skills are MCP-native (not CLI-primary)", () => {
  const skillsDir = join(root, "skills");
  const names = readdirSync(skillsDir).filter((n) => existsSync(join(skillsDir, n, "SKILL.md")));
  assert.ok(names.includes("zenrows"));
  assert.ok(names.includes("extract"));
  assert.ok(names.includes("batch-jobs"));

  const master = readFileSync(join(skillsDir, "zenrows", "SKILL.md"), "utf8");
  assert.match(master, /\bscrape\b/);
  assert.match(master, /\bextract\b/);
  assert.match(master, /batch_create|batch_\*/);
  assert.match(master, /claim/i);
  assert.match(master, /OAuth|stdio/i);
  // should not instruct CLI as the primary path
  assert.doesNotMatch(master, /→ Use Protected Fetch\.\s+\(zenrows fetch/);
});
