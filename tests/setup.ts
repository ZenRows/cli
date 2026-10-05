/**
 * Test bootstrap — makes the suite hermetic.
 *
 * Scrubs every `ZENROWS_*` environment variable at process startup so a
 * developer's ambient config (e.g. `ZENROWS_API_BASE` pointing at a local
 * server, or an exported `ZENROWS_API_KEY`) can't leak in and change results.
 * Also scrubs the variables `agent-client.ts` detects an AI agent from.
 * Wired via `node --test --import ./dist/tests/setup.js`, so it runs once in
 * each test-file worker before any test module loads. Tests that need a
 * specific override set it explicitly (and restore it) themselves.
 */
import { AGENT_ENV_VARS } from "../src/core/agent-client.ts";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("ZENROWS_")) delete process.env[key];
}
// Running the suite from inside an AI agent (CLAUDE_CODE_CHILD_SESSION=1 in
// Claude Code's shell) would otherwise add X-ZenRows-Client to every request.
for (const key of AGENT_ENV_VARS) delete process.env[key];
