/**
 * Test bootstrap — makes the suite hermetic.
 *
 * Scrubs every `ZENROWS_*` environment variable at process startup so a
 * developer's ambient config (e.g. `ZENROWS_API_BASE` pointing at a local
 * server, or an exported `ZENROWS_API_KEY`) can't leak in and change results.
 * Wired via `node --test --import ./dist/tests/setup.js`, so it runs once in
 * each test-file worker before any test module loads. Tests that need a
 * specific override set it explicitly (and restore it) themselves.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("ZENROWS_")) delete process.env[key];
}
