import { test } from "node:test";
import assert from "node:assert/strict";
import { buildParams, validateAutoManual, type FetchOptions } from "../src/adapters/protected-fetch.ts";
import { defaultConfig } from "../src/core/config.ts";
import { ToolkitError } from "../src/core/errors.ts";

const cfg = defaultConfig(); // defaultMode = "auto"

test("auto mode + --js-render is a PARAM_CONFLICT_AUTO_MANUAL", () => {
  const opts: FetchOptions = { url: "https://x.com", jsRender: true };
  assert.throws(() => validateAutoManual(opts, cfg), (e: unknown) => e instanceof ToolkitError && e.code === "PARAM_CONFLICT_AUTO_MANUAL");
});

test("auto mode + --premium-proxy is a conflict", () => {
  const opts: FetchOptions = { url: "https://x.com", premiumProxy: true };
  assert.throws(() => validateAutoManual(opts, cfg), (e: unknown) => e instanceof ToolkitError && e.code === "PARAM_CONFLICT_AUTO_MANUAL");
});

test("auto mode + --proxy-country is allowed (per docs)", () => {
  const opts: FetchOptions = { url: "https://x.com", proxyCountry: "us" };
  assert.doesNotThrow(() => validateAutoManual(opts, cfg));
  const params = buildParams(opts, cfg);
  assert.equal(params.mode, "auto");
  assert.equal(params.proxy_country, "us");
  assert.equal(params.js_render, undefined);
});

test("manual mode + --proxy-country WITHOUT --premium-proxy is rejected (REQS004 guard)", () => {
  const opts: FetchOptions = { url: "https://x.com", manual: true, proxyCountry: "es" };
  assert.throws(
    () => validateAutoManual(opts, cfg),
    (e: unknown) => e instanceof ToolkitError && e.code === "PARAM_PROXY_COUNTRY_REQUIRES_PREMIUM",
  );
});

test("manual mode + --proxy-country + --premium-proxy is allowed and maps correctly", () => {
  const opts: FetchOptions = { url: "https://x.com", manual: true, premiumProxy: true, proxyCountry: "es" };
  assert.doesNotThrow(() => validateAutoManual(opts, cfg));
  const params = buildParams(opts, cfg);
  assert.equal(params.premium_proxy, true);
  assert.equal(params.proxy_country, "es");
});

test("--manual + --js-render + --premium-proxy is allowed and maps correctly", () => {
  const opts: FetchOptions = { url: "https://x.com", manual: true, jsRender: true, premiumProxy: true };
  assert.doesNotThrow(() => validateAutoManual(opts, cfg));
  const params = buildParams(opts, cfg);
  assert.equal(params.mode, undefined); // not auto
  assert.equal(params.js_render, true);
  assert.equal(params.premium_proxy, true);
});

test("buildParams maps response formats and waits", () => {
  const opts: FetchOptions = { url: "https://x.com", output: "markdown", wait: 2000, waitFor: ".price" };
  const params = buildParams(opts, cfg);
  assert.equal(params.response_type, "markdown");
  assert.equal(params.wait, 2000);
  assert.equal(params.wait_for, ".price");
});
