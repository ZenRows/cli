/**
 * Shared types for the ZenRows CLI.
 *
 * The toolkit is the open-source adoption / distribution layer for the ZenRows
 * protected web data platform. These types model the local workspace, the
 * capability matrix, and the installable asset registry — not the cloud
 * infrastructure itself.
 */

export type CapabilityStatus =
  | "available"
  | "available-but-needs-confirmation"
  | "experimental"
  | "beta"
  | "planned"
  | "not-implemented"
  | "deprecated";

export interface Capability {
  /** Stable capability key, e.g. "protected_fetch". */
  key: string;
  /** Human label. */
  label: string;
  status: CapabilityStatus;
  /** CLI command that exposes this capability, e.g. "zenrows fetch". */
  command: string;
  /** Backend endpoint or surface, e.g. "GET https://api.zenrows.com/v1/". */
  backend: string;
  /** Whether a valid API key is required before the command can do real work. */
  requiresAuth: boolean;
  /** Notes explaining the classification (shown in `status`). */
  notes?: string;
}

export type AssetType =
  | "plugin"
  | "skill"
  | "template"
  | "workflow"
  | "recipe"
  | "eval";

export interface RegistryAsset {
  name: string;
  type: AssetType;
  description: string;
  status: Exclude<CapabilityStatus, "available-but-needs-confirmation" | "not-implemented">;
  /** Capability keys this asset depends on; checked before run. */
  requires_backend_capabilities: string[];
  requires_auth: boolean;
  version: string;
  /** Path relative to the package root. */
  path: string;
  tags: string[];
}

export interface ToolkitConfig {
  /** ZenRows REST API base, confirmed: https://api.zenrows.com/v1/ */
  apiBase: string;
  /** Default fetch mode. "auto" = Adaptive Stealth Mode. */
  defaultMode: "auto" | "manual";
  /**
   * Anonymous attribution toggle. The toolkit never POSTs to a telemetry
   * endpoint; "anonymous" only attaches provenance headers to the signup
   * request and `utm_*` params to the browser URLs a human opens. "off" (or
   * `ZENROWS_TELEMETRY=off`) suppresses both.
   */
  telemetry: "anonymous" | "off";
  /**
   * Override the agent-signup endpoint. Defaults to the production endpoint
   * when unset; set this (or the ZENROWS_AGENT_SIGNUP_URL env var) to point at a
   * local/staging server for testing.
   */
  signupUrl?: string;
  /**
   * Base origin used to discover the agent-signup endpoint via
   * `/.well-known/oauth-protected-resource`. Defaults to the production origin
   * when unset; set this (or the ZENROWS_DISCOVERY_URL env var) to point
   * discovery at a local/staging server for testing.
   */
  discoveryUrl?: string;
  /**
   * Stable, anonymous agent id (uuid). Generated once and persisted here; sent
   * as the `X-ZR-Agent-Id` signup header so the backend can correlate the
   * anonymous device with the account it merges on claim. No PII — random only.
   */
  telemetryId?: string;
  /** Schema/version marker for forward-compatible migrations. */
  version: string;
}

export interface Policy {
  max_credits_per_run: number;
  max_pages_per_run: number;
  max_concurrency: number;
  allow_browser: boolean;
  allow_experimental: boolean;
  allowed_domains: string[];
  blocked_domains: string[];
  redact_secrets: boolean;
  telemetry: "anonymous" | "off";
  /** Auto-create an unclaimed ZenRows account on first cloud call when no key exists. */
  auto_signup: boolean;
}

export interface AgentAccount {
  accountId: string;
  /** True until a human claims the account. */
  unclaimed: boolean;
  /** URL a human opens to claim (set email + password). */
  claimUrl: string;
  /** ISO-8601 creation time (local). */
  createdAt: string;
  /** ISO-8601 timestamp of the last usage check (throttles the claim nudge). */
  lastUsageCheckAt?: string;
}

export interface Secrets {
  /** ZenRows API key. Never written to run artifacts or printed. */
  apiKey?: string;
}

export interface AuthState {
  hasKey: boolean;
  /** Where the key was resolved from. */
  source: "secrets-file" | "env" | "none";
  /** Masked preview for display, e.g. "ab12…wxyz". Never the full key. */
  masked?: string;
}
