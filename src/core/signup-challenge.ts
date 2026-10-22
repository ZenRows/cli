/**
 * The signup challenge: before it creates an account, the signup endpoint may
 * answer 428 with one short natural-language question for the agent running
 * the CLI to answer itself. The CLI never tries to solve it.
 *
 * Each CLI run is its own process, so the pending question is kept in
 * `.zenrows/signup-challenge.json` (no secret: the id, the question, when it
 * expires, and the signup URL that issued it, which is where the answer goes).
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ToolkitError } from "./errors.ts";
import { findWorkspace, readJson, workspacePaths, writeJson } from "./workspace.ts";

export interface PendingChallenge {
  id: string;
  prompt: string;
  /** ISO timestamp after which the server no longer accepts an answer. */
  expiresAt: string;
  /** The signup URL that issued the question; the answer is posted there. */
  signupUrl: string;
}

/** The command an agent runs to answer the pending question. */
export const ANSWER_COMMAND = 'zenrows signup --answer "<your answer>"';

export function challengePath(projectRoot?: string): string {
  const ws = projectRoot ? workspacePaths(projectRoot) : (findWorkspace() ?? workspacePaths());
  return join(ws.dir, "signup-challenge.json");
}

export function readChallenge(projectRoot?: string): PendingChallenge | null {
  try {
    const c = readJson<PendingChallenge>(challengePath(projectRoot));
    if (!c || typeof c.id !== "string" || typeof c.prompt !== "string" || typeof c.signupUrl !== "string") return null;
    return c;
  } catch {
    return null;
  }
}

export function writeChallenge(c: PendingChallenge, projectRoot?: string): void {
  writeJson(challengePath(projectRoot), c);
}

export function clearChallenge(projectRoot?: string): void {
  const file = challengePath(projectRoot);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {
    // best effort
  }
}

/** True when the stored question can no longer be answered. */
export function challengeExpired(c: PendingChallenge, now = Date.now()): boolean {
  const t = Date.parse(c.expiresAt);
  return Number.isFinite(t) && t <= now;
}

interface ChallengeBody {
  error?: unknown;
  message?: unknown;
  challenge?: { id?: unknown; prompt?: unknown; expires_in?: unknown };
}

function parseBody(body: string): ChallengeBody | null {
  try {
    const json = JSON.parse(body) as unknown;
    return json && typeof json === "object" ? (json as ChallengeBody) : null;
  } catch {
    return null;
  }
}

/**
 * Parse a 428 `challenge_required` body into a pending challenge, or null when
 * the body is not one (then the caller reports a generic failure).
 */
export function parseChallenge(body: string, signupUrl: string, now = Date.now()): PendingChallenge | null {
  const json = parseBody(body);
  if (!json || json.error !== "challenge_required") return null;
  const ch = json.challenge;
  if (!ch || typeof ch.id !== "string" || !ch.id || typeof ch.prompt !== "string" || !ch.prompt.trim()) return null;
  const ttl = typeof ch.expires_in === "number" && ch.expires_in > 0 ? ch.expires_in : 600;
  return { id: ch.id, prompt: ch.prompt.trim(), expiresAt: new Date(now + ttl * 1000).toISOString(), signupUrl };
}

/** True when a 428 says the previous answer was wrong or came too late. */
export function wasWrongAnswer(body: string): boolean {
  const msg = parseBody(body)?.message;
  return typeof msg === "string" && /^wrong or expired/i.test(msg.trim());
}

/** True when a 429 is the per-network lock after too many questions or wrong answers. */
export function isChallengeLocked(body: string): boolean {
  return parseBody(body)?.error === "challenge_locked";
}

/** The error an agent sees while a question is waiting for its answer. */
export function challengeError(c: PendingChallenge, opts: { wrong?: boolean } = {}): ToolkitError {
  const lead = opts.wrong ? "That answer was wrong or came too late, so here is a new question. " : "";
  return new ToolkitError({
    code: "SIGNUP_CHALLENGE",
    message: `${lead}Zenrows needs one quick answer before it creates an account: ${c.prompt}`,
    likely_cause: "No API key is configured, and new accounts created by agents answer one short question first.",
    next_action: `Answer the question yourself, then run: ${ANSWER_COMMAND}. When it succeeds, re-run your original command.`,
    suggested_commands: [ANSWER_COMMAND, "zenrows login --api-key <your-key>"],
    challenge: { id: c.id, question: c.prompt, expires_at: c.expiresAt },
  });
}

export function challengeLockedError(retryAfter?: number): ToolkitError {
  return new ToolkitError({
    code: "SIGNUP_CHALLENGE_LOCKED",
    message: "Too many signup questions or wrong answers from this network, so Zenrows paused account creation here.",
    likely_cause: "Too many signup questions asked, or wrong answers given, from this network within an hour.",
    next_action:
      "Try again in an hour by re-running your original command, which asks a new question. If you already have a Zenrows API key, use it now: zenrows login --api-key <key> (or set ZENROWS_API_KEY).",
    suggested_commands: ["zenrows login --api-key <your-key>"],
    ...(retryAfter !== undefined ? { retry_after: retryAfter } : {}),
  });
}

export function noChallengeError(expired: boolean): ToolkitError {
  return new ToolkitError({
    code: "SIGNUP_CHALLENGE_MISSING",
    message: expired ? "The signup question expired before it was answered." : "There is no signup question waiting for an answer.",
    likely_cause: expired
      ? "Questions are valid for a few minutes."
      : "No signup was attempted from this directory, or the question was already answered.",
    next_action: "Re-run your original command (for example zenrows fetch <url>) to get a new question, then answer it with: " + ANSWER_COMMAND,
    suggested_commands: ["zenrows fetch <url>"],
  });
}
