/**
 * Secret redaction helpers. The API key must never appear in logs, run
 * artifacts, or generated assets.
 */

const KEY_PATTERNS = [
  /apikey=([^&\s"']+)/gi,
  /api[_-]?key["']?\s*[:=]\s*["']?([^&\s"',}]+)/gi,
  /ZENROWS_API_KEY=([^\s"']+)/g,
];

/** Mask a secret for display: keep first 4 + last 4, redact the middle. */
export function mask(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** Redact any known secret-bearing substrings from arbitrary text. */
export function redact(text: string, knownSecrets: string[] = []): string {
  let out = text;
  for (const pat of KEY_PATTERNS) {
    out = out.replace(pat, (m, g1) => m.replace(g1, "***REDACTED***"));
  }
  for (const s of knownSecrets) {
    if (s && s.length >= 4) out = out.split(s).join("***REDACTED***");
  }
  return out;
}

/** Deep-clone-and-redact an object before it is persisted as an artifact. */
export function redactObject<T>(value: T, knownSecrets: string[] = []): T {
  const json = JSON.stringify(value, (key, val) => {
    if (typeof key === "string" && /api[_-]?key|apikey|secret|token/i.test(key)) {
      return "***REDACTED***";
    }
    return val;
  });
  const parsed = JSON.parse(json);
  return JSON.parse(redact(JSON.stringify(parsed), knownSecrets));
}
