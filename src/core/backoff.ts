/**
 * Retry delays shared by the HTTP clients.
 *
 * Crawl keeps its own schedule (`crawlBackoffMs`). Fetch and Extract use full
 * jitter (`fullJitterMs`), the policy every Zenrows Fetch/Extract client shares.
 * Both honour a `Retry-After` in whole seconds through `retryAfterMs`.
 */

/** The longest a Retry-After may make one retry wait, so a large server value cannot hang a command. */
export const MAX_RETRY_AFTER_SECONDS = 30;

/** Crawl's schedule: 250 ms x 2^attempt, capped at 10 s, +/-20% jitter. */
export function crawlBackoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 10_000) * (0.8 + Math.random() * 0.4);
}

/** Shortest full-jitter wait: never retry in a tight loop. */
export const JITTER_FLOOR_MS = 250;
/** Longest full-jitter wait. */
export const JITTER_CAP_MS = 30_000;

/**
 * Full jitter: uniform(0.25 s, min(30 s, 1 s x 2^attempt)). `attempt` is the
 * 0-based retry index, so the first retry waits at most 1 s and the second 2 s.
 * `random` is injectable for tests.
 */
export function fullJitterMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.max(JITTER_FLOOR_MS, Math.min(JITTER_CAP_MS, 1000 * 2 ** attempt));
  return JITTER_FLOOR_MS + random() * (ceiling - JITTER_FLOOR_MS);
}

/** `Retry-After` in whole seconds, as milliseconds, at most `MAX_RETRY_AFTER_SECONDS`. */
export function retryAfterMs(value: string | null): number | undefined {
  return value && /^\d+$/.test(value.trim()) ? Math.min(Number(value), MAX_RETRY_AFTER_SECONDS) * 1000 : undefined;
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
