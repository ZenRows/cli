/**
 * Retry delays shared by the HTTP clients.
 *
 * Crawl keeps its own schedule (`crawlBackoffMs`) and reads `Retry-After`
 * through `retryAfterMs`. Fetch and Extract use full jitter (`fullJitterMs`)
 * and read `Retry-After` through `retryAfterDelayMs`, which also applies the
 * 250 ms floor: the policy every Zenrows Fetch/Extract client shares.
 */

/** The longest a Retry-After may make one retry wait, so a large server value cannot hang a command. */
export const MAX_RETRY_AFTER_SECONDS = 30;

/** Crawl's schedule: 250 ms x 2^attempt, capped at 10 s, +/-20% jitter. */
export function crawlBackoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 10_000) * (0.8 + Math.random() * 0.4);
}

/** Shortest Fetch/Extract wait, from jitter or from Retry-After: never retry in a tight loop. */
export const JITTER_FLOOR_MS = 250;
/** Longest full-jitter wait. */
export const JITTER_CAP_MS = 30_000;

/**
 * Full jitter: uniform(0.25 s, max(0.25 s, min(capMs, 1 s x 2^attempt))).
 * `attempt` is the 0-based retry index, so the first retry waits at most 1 s
 * and the second 2 s. `random` is injectable for tests. `capMs` is 30 s; the
 * CLI has no option to change it, and the parameter exists for the shared
 * conformance vectors.
 */
export function fullJitterMs(attempt: number, random: () => number = Math.random, capMs: number = JITTER_CAP_MS): number {
  const ceiling = Math.max(JITTER_FLOOR_MS, Math.min(capMs, 1000 * 2 ** attempt));
  return JITTER_FLOOR_MS + random() * (ceiling - JITTER_FLOOR_MS);
}

/**
 * `Retry-After` in whole seconds, as milliseconds, at most `MAX_RETRY_AFTER_SECONDS`.
 * Crawl's reading: `0` means no wait. Anything but whole decimal digits is undefined.
 */
export function retryAfterMs(value: string | null): number | undefined {
  return value && /^\d+$/.test(value.trim()) ? Math.min(Number(value), MAX_RETRY_AFTER_SECONDS) * 1000 : undefined;
}

/**
 * Fetch and Extract's reading of `Retry-After`: whole decimal digits only,
 * clamped to [0.25 s, 30 s], so `0` waits 250 ms. Undefined means "use jitter".
 */
export function retryAfterDelayMs(value: string | null): number | undefined {
  const ms = retryAfterMs(value);
  return ms === undefined ? undefined : Math.max(JITTER_FLOOR_MS, ms);
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
