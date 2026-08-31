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
  /** Master switch for the model-list fix (discovery enrichment + sync route). */
  modelsSyncEnabled: boolean;
  /** The llm-pi-ai provider route whose model list this plugin keeps current. */
  modelsRouteKey: string;
  /** Endpoint probed for the live model listing. */
  modelsBaseURL: string;
  /** Same-origin route forcing one model-list sync (POST). */
  syncModelsPath: string;
  /** Wire protocol written onto the route so catalog-unknown models are serviceable. */
  modelsRouteApi: string;
  /** Fill missing capacities/modalities for new models from the models.dev registry. */
  modelsEnrichFromRegistry: boolean;
  /** Model ids to force vision-capable, overriding any auto-detection. */
  modelsVision: string[];
  /** Model ids to force text-only (image stripped), overriding auto-detection. */
  modelsTextOnly: string[];
  /** Provider ids pinned as blocks in the settings card (the rest wait in the picker). */
  visibleProviders: string[];
  /** Per-provider configuration overriding the flat compatibility keys. */
  providers?: ProviderConfigBlock;
}

/** One merged entry of a synced llm-pi-ai models profile list. */
export interface SyncedModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Probe an OpenAI-compatible `GET {baseURL}/models` listing and extract its
 * unique model ids in endpoint order.
 * @throws an error whose `code` classifies the failure
 *   (invalid-credentials | api-error | parse-failed | network-error).
 */
export declare function fetchLiveModelList(baseURL: string, apiKey: string, signal?: AbortSignal): Promise<string[]>;

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