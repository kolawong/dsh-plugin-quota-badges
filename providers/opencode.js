/**
 * dsh-plugin-quota-badges — OpenCode (Zen Go) provider adapter.
 *
 * Everything OpenCode-specific lives here: its upstream endpoints, Bearer
 * auth resolution, usage-window parsing (via usage-core), and the lms model
 * catalog sync (discovery enrichment + explicit write into the llm-pi-ai
 * settings namespace). index.js assembles providers through a registry; this
 * module exposes the `opencodeProvider` adapter with the shared contract:
 *
 *   {
 *     id, displayName,
 *     config: (merged) => providerConfig,       // extract this provider's slice
 *     fetchUsage: (ctx) => Promise<{snapshot, error}>,
 *     syncModels?: (ctx) => Promise<result>,    // OpenCode-only today
 *     install?: (ctx) => void,                  // discovery enrichment (OpenCode-only)
 *   }
 *
 * `ctx` is a small context object injected by the assembly layer:
 *   { logger, config, settingsService, llmRuntime, resolveApiKey }
 *
 * @license MIT
 */

import {
  extractModelIds,
  mergeModelLists,
  diffModelIds,
  MAX_LISTING_BYTES,
  parseModelToml,
  applyMetadata,
  collectModelMetadata,
  fillFromSiblings,
  applyCatalogModalities,
  applyVisionOverride,
} from "../models-core.js";
import { parseUsageText } from "../usage-core.js";

/** Upstream usage endpoint; a fixed protocol address of the OpenCode Zen Go API. */
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/** Settings namespace owned by the llm-pi-ai adapter plugin. */
const LLM_PI_AI_NS = "llm-pi-ai";

// ── errors ──────────────────────────────────────────────────────────────────

// The Quota* error classes are shared by every provider adapter; the message
// prefix names the vendor that threw (`new QuotaApiError(msg, 403, "Kimi Code")`).
// The label defaults to OpenCode so existing no-arg call sites keep their text.

export class QuotaAuthError extends Error {
  constructor(provider = "OpenCode") {
    super(provider + " API key is missing, invalid, or expired");
    this.name = "QuotaAuthError";
    this.code = "invalid-credentials";
  }
}

export class QuotaApiError extends Error {
  constructor(message, status, provider = "OpenCode") {
    super(provider + " API error (HTTP " + status + "): " + message);
    this.name = "QuotaApiError";
    this.code = "api-error";
  }
}

export class QuotaParseError extends Error {
  constructor(message, provider = "OpenCode") {
    super(message ?? provider + " usage response could not be parsed into usage windows");
    this.name = "QuotaParseError";
    this.code = "parse-failed";
  }
}

export class QuotaNetworkError extends Error {
  constructor(cause) {
    super("OpenCode network error: " + (cause?.message ?? String(cause)));
    this.name = "QuotaNetworkError";
    this.code = "network-error";
  }
}

// ── upstream access ─────────────────────────────────────────────────────────

/** Fetch helper with an optional Bearer auth, JSON accept, and a timeout. */
export async function upstreamFetch(url, apiKey, signal, timeoutMs, timeoutSec) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("timeout")),
    (typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : (timeoutSec ?? 10) * 1000),
  );
  // An external signal aborts through the internal controller as well.
  signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        // An empty key means an unauthenticated call (the models.dev registry).
        ...(apiKey === "" ? {} : { Authorization: "Bearer " + apiKey }),
        Accept: "application/json, text/plain;q=0.9",
        "User-Agent": "dsh-plugin-quota-badges",
      },
      signal: controller.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a reply body, refusing one that outgrows MAX_LISTING_BYTES. The bound
 * holds on bytes actually read because the URL is caller-supplied.
 */
export async function readBounded(response) {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_LISTING_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new QuotaParseError("model listing exceeds " + MAX_LISTING_BYTES + " bytes");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_LISTING_BYTES) {
    throw new QuotaParseError("model listing exceeds " + MAX_LISTING_BYTES + " bytes");
  }
  return new TextDecoder().decode(buffer);
}

/** Pull a human-readable message out of an error body (JSON fields or title tag). */
export function extractServerErrorMessage(text) {
  try {
    const object = JSON.parse(text);
    for (const key of ["message", "error", "detail"]) {
      const value = object?.[key];
      if (typeof value === "string" && value !== "") return value;
      if (typeof value?.message === "string" && value.message !== "") return value.message;
    }
  } catch {
    // fall through to the title scan below
  }
  const match = /<title>([^<]+)<\/title>/i.exec(text);
  return match ? match[1].trim() : undefined;
}

// ── usage fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch and parse one OpenCode usage snapshot.
 * @returns {Promise<{snapshot: object | null, error: {code: string, message: string} | null}>}
 */
export async function fetchUsageSnapshot(ctx) {
  const { logger, resolveApiKey } = ctx;
  /** ctx.config is always a function returning the current provider config. */
  const config = typeof ctx.config === "function" ? ctx.config() : ctx.config;
  const apiKey = resolveApiKey(config);
  if (apiKey === "") {
    return {
      snapshot: null,
      error: {
        code: "unconfigured",
        message: "No API key: set apiKey in the plugin settings UI or export " + config.apiKeyEnvVar,
      },
    };
  }
  try {
    const response = await upstreamFetch(USAGE_URL, apiKey, undefined, undefined, config.timeoutSec);
    if (response.status === 401 || response.status === 403) throw new QuotaAuthError();
    const text = await response.text();
    if (!response.ok) {
      throw new QuotaApiError(extractServerErrorMessage(text) ?? "", response.status);
    }
    const now = Date.now();
    const snapshot = parseUsageText(text, now);
    if (snapshot === null || snapshot.rolling === null) throw new QuotaParseError();
    return { snapshot: { ...snapshot, fetchedAt: new Date(now).toISOString() }, error: null };
  } catch (error) {
    if (error instanceof QuotaAuthError || error instanceof QuotaApiError || error instanceof QuotaParseError) {
      return { snapshot: null, error: { code: error.code, message: error.message } };
    }
    logger?.warn?.("[quota-badges] opencode upstream fetch failed:", error);
    return {
      snapshot: null,
      error: { code: "network-error", message: error?.message ?? String(error) },
    };
  }
}

// ── model-list sync ─────────────────────────────────────────────────────────

/**
 * Probe one OpenAI-compatible listing endpoint and extract its model ids.
 * @returns {Promise<string[]>} unique ids in endpoint order.
 */
export async function fetchLiveModelList(baseURL, apiKey, signal, timeoutSec) {
  if (apiKey === "") throw new QuotaAuthError();
  const url = baseURL.replace(/\/+$/, "") + "/models";
  let response;
  try {
    response = await upstreamFetch(url, apiKey, signal, undefined, timeoutSec);
  } catch (error) {
    throw new QuotaNetworkError(error);
  }
  if (response.status === 401 || response.status === 403) throw new QuotaAuthError();
  let text;
  try {
    text = await readBounded(response);
  } catch (error) {
    if (error instanceof QuotaParseError) throw error;
    throw new QuotaNetworkError(error);
  }
  if (!response.ok) {
    throw new QuotaApiError(extractServerErrorMessage(text) ?? "", response.status);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new QuotaParseError("model listing did not answer with JSON");
  }
  const ids = extractModelIds(body);
  if (ids === null) throw new QuotaParseError('model listing has no "data" array');
  return ids;
}

/** models.dev registry mirrors, tried in order: a CDN first, raw fallback. */
const REGISTRY_SOURCES = [
  "https://cdn.jsdelivr.net/gh/sst/models.dev@dev/providers/",
  "https://raw.githubusercontent.com/sst/models.dev/dev/providers/",
];
/** This endpoint's provider directory inside the registry. */
const REGISTRY_PROVIDER = "opencode-go";
/** Concurrent registry fetches; small enough to stay under CDN abuse limits. */
const REGISTRY_CONCURRENCY = 5;
/** How long a non-empty registry answer stays fresh. */
const REGISTRY_CACHE_MS = 6 * 60 * 60 * 1000;
/** How long an empty (every source failed) answer stays fresh before a retry. */
const REGISTRY_EMPTY_TTL_MS = 60 * 1000;
/** Per-request timeout for the tiny registry TOML files. */
const REGISTRY_TIMEOUT_MS = 4000;
/** In-flight registry scan promise; deduplicates concurrent callers. */
let registryInflight = null;
/** Latest registry scan: when it ran and what it produced, keyed by model id. */
let registryCache = { at: 0, meta: new Map() };

/** Fetch and parse one registry TOML across the source mirrors; null on total failure. */
async function fetchRegistryToml(provider, id) {
  for (const source of REGISTRY_SOURCES) {
    try {
      const response = await upstreamFetch(source + provider + "/models/" + id + ".toml", "", undefined, REGISTRY_TIMEOUT_MS);
      if (response.ok) return parseModelToml(await response.text());
      // A 404 is the registry saying "no such model"; the mirrors serve one
      // repository, so asking the next one would only burn its timeout on
      // ids that are simply absent. Only a transport failure (timeout, 5xx)
      // falls through to the next mirror.
      if (response.status === 404) return null;
    } catch {
      // Try the next mirror; a dead source must not fail the whole listing.
    }
  }
  return null;
}

/**
 * Capacities and modalities for the given ids from the models.dev registry
 * (OpenCode's own model database), via collectModelMetadata: alias chains
 * resolve toward their canonical files, ids the registry does not describe
 * stay absent from the answer, and individual failures never fail the call.
 * A non-empty answer caches for six hours, an empty one (every source down)
 * for one minute, and one in-flight scan serves every concurrent caller.
 */
async function fetchModelMetadata(ids) {
  const ttl = registryCache.meta.size > 0 ? REGISTRY_CACHE_MS : REGISTRY_EMPTY_TTL_MS;
  if (registryCache.at + ttl > Date.now()) return registryCache.meta;
  if (registryInflight === null) {
    registryInflight = collectModelMetadata(ids, REGISTRY_PROVIDER, fetchRegistryToml, {
      concurrency: REGISTRY_CONCURRENCY,
    })
      .catch(() => new Map())
      .then((meta) => {
        registryCache = { at: Date.now(), meta };
        return meta;
      })
      .finally(() => {
        registryInflight = null;
      });
  }
  return registryInflight;
}

/** Run an async worker over items with a fixed concurrency cap. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function lane() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, lane));
  return results;
}

/**
 * Cross-provider model info cache (in-process reads, refreshed once a minute).
 */
let donorCache = { at: 0, models: [] };

/**
 * Every model every registered provider route serves, for exact-id modality
 * borrowing: when another provider in this process (e.g. the official
 * DeepSeek route) declares a model multimodal, that is authoritative for the
 * same id here. Reads are in-process service calls, never network.
 * @returns {Promise<Array<{id: string, inputModalities?: string[]}>>}
 */
async function crossProviderModels(llmRuntime) {
  if (donorCache.at + 60 * 1000 > Date.now()) return donorCache.models;
  const models = [];
  try {
    for (const provider of llmRuntime.listProviders()) {
      try {
        models.push(...(await llmRuntime.listModels(provider.id)));
      } catch {
        // One route failing to list never blocks the rest.
      }
    }
  } catch {
    // Runtime absent or moved: no donors, entries stay text-only.
  }
  donorCache = { at: Date.now(), models };
  return models;
}

/**
 * Pre-write the route's wire protocol into the llm-pi-ai user layer so that
 * ANY configuration-surface save of an adopted model listing passes
 * serviceability — not only this plugin's sync route (the GUI's own save path
 * sends no api field of its own). Idempotent: skips once the value matches,
 * and waits briefly for the namespace when this plugin starts before it.
 */
async function ensureRouteApi(ctx) {
  const { logger, settingsService } = ctx;
  /** ctx.config is always a function returning the current provider config. */
  const config = typeof ctx.config === "function" ? ctx.config() : ctx.config;
  if (!config.modelsSyncEnabled) return;
  for (let attempt = 0; attempt < 30; attempt++) {
    const resolved = settingsService?.get?.(LLM_PI_AI_NS);
    if (resolved === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    if (resolved?.providers?.[config.modelsRouteKey]?.api !== undefined) return;
    try {
      await settingsService.update(LLM_PI_AI_NS, {
        providers: { [config.modelsRouteKey]: { api: config.modelsRouteApi } },
      });
      logger?.info?.(
        "[quota-badges] route '" + config.modelsRouteKey + "' wire protocol set to " + config.modelsRouteApi,
      );
    } catch (error) {
      logger?.warn?.("[quota-badges] could not pre-set the route api:", error?.message ?? String(error));
    }
    return;
  }
  logger?.warn?.("[quota-badges] llm-pi-ai settings never registered; route api was not pre-set");
}

/**
 * Grant image input to already-saved route models whose id another registered
 * provider declares multimodal. The configuration surface's own save path
 * sends no per-model input field, so an adopted listing loses image support
 * until the next sync; this heals it once at startup, before the user's first
 * attachment can be refused. Reads the raw user section through
 * settings.describe(), patches only entries gaining something, and never
 * removes any field.
 */
async function ensureModalities(ctx) {
  const { logger, settingsService } = ctx;
  /** ctx.config is always a function returning the current provider config. */
  const config = typeof ctx.config === "function" ? ctx.config() : ctx.config;
  if (!config.modelsSyncEnabled) return;
  for (let attempt = 0; attempt < 30; attempt++) {
    const descriptor = settingsService?.describe?.()?.find((entry) => entry?.ns === LLM_PI_AI_NS);
    if (descriptor === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    const rawModels = descriptor?.user?.providers?.[config.modelsRouteKey]?.models;
    if (!Array.isArray(rawModels) || rawModels.length === 0) return;
    const granted = applyCatalogModalities(rawModels, await crossProviderModels(ctx.llmRuntime));
    const override = applyVisionOverride(rawModels, config.modelsVision, config.modelsTextOnly);
    if (granted === 0 && override.granted === 0 && override.stripped === 0) return;
    try {
      await settingsService.update(LLM_PI_AI_NS, {
        providers: { [config.modelsRouteKey]: { models: rawModels } },
      });
      logger?.info?.(
        "[quota-badges] saved " + config.modelsRouteKey + " model modalities: granted " + granted
        + ", forced vision " + override.granted + ", forced text-only " + override.stripped,
      );
    } catch (error) {
      logger?.warn?.("[quota-badges] could not heal saved model modalities:", error?.message ?? String(error));
    }
    return;
  }
  logger?.warn?.("[quota-badges] llm-pi-ai settings never registered; saved modalities were not healed");
}

/**
 * One sync cycle: probe the live listing, merge it over the route's current
 * models (ctx.llmRuntime.listModels), and persist the union into the llm-pi-ai
 * user layer. The write goes through llm-pi-ai's own schema validation, and
 * the adapter re-resolves profiles per request, so new models are selectable
 * immediately.
 * @returns {Promise<object>} a JSON payload describing the outcome.
 */
export async function syncModelsOnce(ctx) {
  const { logger, settingsService, llmRuntime } = ctx;
  /** ctx.config is always a function returning the current provider config. */
  const config = typeof ctx.config === "function" ? ctx.config() : ctx.config;
  if (!config.modelsSyncEnabled) {
    return { ok: false, error: { code: "disabled", message: "model sync is disabled in plugin settings" } };
  }
  if (!settingsService || typeof settingsService.update !== "function") {
    return { ok: false, error: { code: "no-settings", message: "settings seam is unavailable" } };
  }
  const apiKey = ctx.resolveApiKey(config);
  if (apiKey === "") {
    return {
      ok: false,
      error: {
        code: "unconfigured",
        message: "No API key: set apiKey in the plugin settings UI or export " + config.apiKeyEnvVar,
      },
    };
  }
  let live;
  try {
    live = await fetchLiveModelList(config.modelsBaseURL, apiKey, undefined, config.timeoutSec);
  } catch (error) {
    return { ok: false, error: { code: error?.code ?? "network-error", message: error?.message ?? String(error) } };
  }
  let catalog = [];
  try {
    catalog = await llmRuntime.listModels(config.modelsRouteKey);
  } catch {
    // Route not registered (or the runtime moved): bare entries still sync.
  }
  const merged = mergeModelLists({ catalog, live });
  if (config.modelsEnrichFromRegistry) {
    try {
      applyMetadata(merged, await fetchModelMetadata(live));
    } catch {
      // Metadata is a bonus; the bare listing stays serviceable.
    }
  }
  // A sync is explicit, so it also fills unsized ids from their closest sized
  // sibling in the route's own catalog before persisting, and grants image
  // input wherever another registered provider declares the same id
  // multimodal (the official DeepSeek route does, for the vision models).
  fillFromSiblings(merged, catalog);
  const grantedVision = applyCatalogModalities(merged, await crossProviderModels(llmRuntime));
  // Explicit user overrides win over every automatic rule.
  const override = applyVisionOverride(merged, config.modelsVision, config.modelsTextOnly);
  try {
    await settingsService.update(LLM_PI_AI_NS, {
      providers: { [config.modelsRouteKey]: { api: config.modelsRouteApi, models: merged } },
    });
  } catch (error) {
    return {
      ok: false,
      error: { code: "settings-write-failed", message: error?.message ?? String(error) },
    };
  }
  const diff = diffModelIds(
    catalog.map((model) => model.id),
    live,
  );
  return {
    ok: true,
    routeKey: config.modelsRouteKey,
    total: merged.length,
    added: diff.added,
    removed: diff.removed,
    ...grantedVision > 0 ? { grantedImageInput: grantedVision } : {},
    ...override.granted > 0 ? { forcedVision: override.granted } : {},
    ...override.stripped > 0 ? { forcedTextOnly: override.stripped } : {},
    syncedAt: new Date().toISOString(),
  };
}

// ── discovery enrichment ────────────────────────────────────────────────────

/**
 * Wrap the llm runtime's registered llm-pi-ai discovery so the "fetch
 * available models" action returns the live endpoint listing merged over the
 * catalog answer. Best-effort by design: the registration is private state, so
 * absence disables the enrichment (with a warning) instead of breaking either
 * plugin; disposal restores the original function. Registers its own
 * ctx.effect (the present assembly context), like the original server half.
 */
export function installDiscoveryEnrichment(ctx) {
  const { logger, config, settingsService, llmRuntime, effect } = ctx;
  let timer = null;
  let disposed = false;
  let original = null;
  let wrapped = null;

  const install = () => {
    if (disposed || wrapped !== null) return true;
    const map = llmRuntime?.discoveries;
    if (!(map instanceof Map)) return false;
    const inner = map.get(LLM_PI_AI_NS);
    if (typeof inner !== "function") return false;
    wrapped = async (request) => {
      const base = await inner(request);
      const current = config();
      if (!current.modelsSyncEnabled || request?.provider !== current.modelsRouteKey) return base;
      try {
        const draftKey = typeof request.apiKey === "string" ? request.apiKey.trim() : "";
        const baseURL =
          typeof request.baseURL === "string" && request.baseURL !== ""
            ? request.baseURL
            : current.modelsBaseURL;
        const live = await fetchLiveModelList(baseURL, draftKey !== "" ? draftKey : ctx.resolveApiKey(current), request.signal, current.timeoutSec);
        const merged = mergeModelLists({ catalog: base, live });
        if (current.modelsEnrichFromRegistry) {
          // Metadata is a bonus: never let it hold the fetch answer for more
          // than three seconds. A slow scan keeps running in the background —
          // the next fetch is then served instantly from cache.
          const budget = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 3000);
            timer.unref?.();
          });
          const meta = await Promise.race([fetchModelMetadata(live), budget]);
          if (meta !== null) {
            applyMetadata(merged, meta);
            fillFromSiblings(merged, base);
          }
        }
        return merged;
      } catch (error) {
        logger?.warn?.("[quota-badges] live model probe failed; answering from the catalog:", error?.message ?? error);
        return base;
      }
    };
    original = inner;
    map.set(LLM_PI_AI_NS, wrapped);
    return true;
  };

  effect(() => {
    const deadline = Date.now() + 15000;
    const attempt = () => {
      if (disposed || install()) return;
      if (Date.now() < deadline) {
        timer = setTimeout(attempt, 1000);
        timer.unref?.();
      } else {
        logger?.warn?.(
          "[quota-badges] llm-pi-ai model discovery never appeared; 'fetch available models' stays catalog-only (the sync button still works)",
        );
      }
    };
    attempt();
    return () => {
      disposed = true;
      clearTimeout(timer);
      let map;
      try {
        map = llmRuntime?.discoveries;
      } catch {
        map = undefined;
      }
      if (map instanceof Map && map.get(LLM_PI_AI_NS) === wrapped) map.set(LLM_PI_AI_NS, original);
    };
  }, "quota-badges: llm-pi-ai discovery enrichment");
}

// ── adapter export ──────────────────────────────────────────────────────────

/**
 * The OpenCode provider adapter. `config(merged)` extracts the provider slice
 * from the merged plugin config; the top-level flat keys (apiKey,
 * modelsRouteKey, …) act as the compatibility layer for the legacy flat
 * settings document, while a nested `providers.opencode.*` block (when
 * present) overrides them.
 */
export const opencodeProvider = {
  id: "opencode",
  displayName: "OpenCode",
  usageUrl: USAGE_URL,

  config(merged) {
    const nested = merged?.providers?.opencode;
    return {
      apiKey: nested?.apiKey ?? merged?.apiKey ?? "",
      apiKeyEnvVar: nested?.apiKeyEnvVar ?? merged?.apiKeyEnvVar ?? "OPENCODE_API_KEY",
      timeoutSec: merged?.timeoutSec ?? 10,
      syncWithModel: merged?.syncWithModel ?? true,
      modelsSyncEnabled: nested?.modelsSyncEnabled ?? merged?.modelsSyncEnabled ?? true,
      modelsRouteKey: nested?.modelsRouteKey ?? merged?.modelsRouteKey ?? "opencode-go",
      modelsBaseURL: nested?.modelsBaseURL ?? merged?.modelsBaseURL ?? "https://opencode.ai/zen/go/v1",
      modelsRouteApi: nested?.modelsRouteApi ?? merged?.modelsRouteApi ?? "openai-completions",
      modelsEnrichFromRegistry: nested?.modelsEnrichFromRegistry ?? merged?.modelsEnrichFromRegistry ?? true,
      modelsVision: nested?.modelsVision ?? merged?.modelsVision ?? [],
      modelsTextOnly: nested?.modelsTextOnly ?? merged?.modelsTextOnly ?? [],
    };
  },

  fetchUsage(ctx) {
    return fetchUsageSnapshot(ctx);
  },

  syncModels(ctx) {
    return syncModelsOnce(ctx);
  },

  install(ctx) {
    installDiscoveryEnrichment(ctx);
    // Startup healing for the OpenCode route's api + saved modalities.
    void ensureRouteApi(ctx);
    void ensureModalities(ctx);
  },
};

// Kept exported for tests and introspection.
export const opencodeInternals = {
  USAGE_URL,
  LLM_PI_AI_NS,
  fetchLiveModelList,
  mapWithConcurrency,
};