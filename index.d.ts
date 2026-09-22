/**
 * dsh-plugin-quota-badges — public type face of the server half.
 * The client half is plain browser JS loaded through the dsh module table.
 */

export declare const name: "quota-badges";
export declare const inject: string[];

/** Per-provider configuration block keyed by provider id. */
export interface ProviderConfigBlock {
  [providerId: string]: Record<string, unknown>;
}

export interface QuotaBadgesConfig {
  /** Explicit OpenCode API key; empty falls back to `apiKeyEnvVar`. */
  apiKey: string;
  /** Environment variable consulted when `apiKey` is empty. */
  apiKeyEnvVar: string;
  /** Background poll period in seconds (minimum 15). */
  intervalSec: number;
  /** Per-request upstream timeout in seconds (minimum 1). */
  timeoutSec: number;
  /** Same-origin route serving the cached snapshot (GET). */
  statusPath: string;
  /** Same-origin route forcing one refresh (POST). */
  refreshPath: string;
  /** Provider ids pinned as blocks in the settings card (the rest wait in the picker). */
  visibleProviders: string[];
  /** Per-provider configuration overriding the flat compatibility keys. */
  providers?: ProviderConfigBlock;
}

export declare const Config: unknown;

export interface UsageWindow {
  /** Usage percentage clamped to 0..100. */
  percent: number;
  /** Seconds until this window resets. */
  resetInSec: number;
}

export interface UsageSnapshot {
  /** Rolling 5-hour window; null when absent from the payload. */
  rolling: UsageWindow | null;
  /** Weekly window; null when absent from the payload. */
  weekly: UsageWindow | null;
  /** Monthly window; null when absent from the payload. */
  monthly: UsageWindow | null;
  /** Subscription renewal stamp (ISO) when the payload reports one. */
  renewsAt?: string;
  /** ISO stamp of the successful upstream fetch. */
  fetchedAt?: string;
}

/**
 * Status route payload: the active provider's snapshot at the top level
 * (backward-compatible) plus every provider's entry under `all`.
 */
export interface StatusPayload {
  ok: boolean;
  provider: string;
  displayName: string;
  data: UsageSnapshot | null;
  error: { code: string; message: string } | null;
  fetchedAt: string | null;
  ageSec: number | null;
  providers: string[];
  all: Record<string, ProviderStatusEntry>;
}

export interface ProviderStatusEntry {
  provider: string;
  displayName: string;
  data: UsageSnapshot | null;
  error: { code: string; message: string } | null;
  fetchedAt: string | null;
  ageSec: number | null;
}

export declare function apply(ctx: unknown, config: Partial<QuotaBadgesConfig>): void;