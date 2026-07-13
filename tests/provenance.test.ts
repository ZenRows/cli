import { test } from "node:test";
import assert from "node:assert/strict";
import { attributionParams, detectClient } from "../src/core/provenance.ts";

test("detectClient: claude-code from CLAUDECODE", () => {
  assert.equal(detectClient({ CLAUDECODE: "1" }).client, "claude-code");
});

test("detectClient: claude-code from a CLAUDE_ prefixed var", () => {
  assert.equal(detectClient({ CLAUDE_SESSION: "x" }).client, "claude-code");
});

test("detectClient: cursor from CURSOR_TRACE_ID", () => {
  assert.equal(detectClient({ CURSOR_TRACE_ID: "abc" }).client, "cursor");
});

test("detectClient: cursor from TERM_PROGRAM", () => {
  assert.equal(detectClient({ TERM_PROGRAM: "cursor" }).client, "cursor");
});

test("detectClient: openai-codex from OPENAI_/CODEX_", () => {
  assert.equal(detectClient({ OPENAI_API_KEY: "x" }).client, "openai-codex");
  assert.equal(detectClient({ CODEX_HOME: "x" }).client, "openai-codex");
});

test("detectClient: windsurf", () => {
  assert.equal(detectClient({ WINDSURF_SESSION: "x" }).client, "windsurf");
});

test("detectClient: vscode from TERM_PROGRAM and VSCODE_", () => {
  assert.equal(detectClient({ TERM_PROGRAM: "vscode" }).client, "vscode");
  assert.equal(detectClient({ VSCODE_PID: "1" }).client, "vscode");
});

test("detectClient: unknown when nothing matches", () => {
  assert.equal(detectClient({ HOME: "/root", PATH: "/bin" }).client, "unknown");
});

test("detectClient: ci detection", () => {
  assert.equal(detectClient({ CI: "true" }).ci, true);
  assert.equal(detectClient({ GITHUB_ACTIONS: "true" }).ci, true);
  assert.equal(detectClient({ GITLAB_CI: "true" }).ci, true);
  assert.equal(detectClient({ BUILDKITE: "true" }).ci, true);
  assert.equal(detectClient({}).ci, false);
});

test("detectClient: reports os and node from process", () => {
  const p = detectClient({});
  assert.equal(p.os, process.platform);
  assert.equal(p.node, process.version);
});

test("detectClient: precedence — claude-code beats cursor", () => {
  assert.equal(detectClient({ CLAUDECODE: "1", CURSOR_TRACE_ID: "x" }).client, "claude-code");
});

test("attributionParams: standard utm keys carrying the client brand", () => {
  assert.deepEqual(attributionParams("claude-code"), {
    utm_source: "agent",
    utm_medium: "claude-code",
    utm_campaign: "cli",
  });
});
