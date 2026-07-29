/**
 * Cross-platform "open this URL in the browser" helper + canonical Zenrows
 * URLs. Falls back to printing the URL when no opener is available (e.g. CI).
 */
import { spawn } from "node:child_process";
import { log } from "./logger.ts";

export const SIGNUP_URL = "https://app.zenrows.com/register";
export const AGENT_SIGNUP_API_URL = "https://app.zenrows.com/api/agent/signup";
/** Well-known path advertising the agent-auth endpoints (signup discovery). */
export const WELL_KNOWN_PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";
export const DASHBOARD_URL = "https://app.zenrows.com/dashboard";
export const DOCS_URL = "https://docs.zenrows.com";

/** Append query params to a URL (used to attach anonymous `utm_*` attribution). */
export function withParams(url: string, params: Record<string, string>): string {
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return url;
  }
}

export async function openUrl(url: string): Promise<boolean> {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => log.info(`Open this URL: ${url}`));
    child.unref();
    return true;
  } catch {
    log.info(`Open this URL: ${url}`);
    return false;
  }
}
