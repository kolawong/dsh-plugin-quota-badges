/**
 * dsh-plugin-quota-badges — Server half (v0.7.0, multi-provider assembly).
 *
 * DeepSeek Harness Cordis plugin that tracks subscription quotas for one or
 * more providers and serves them to the Web GUI over same-origin HTTP routes:
 *
 * 1. GET  <statusPath>     — last known snapshot of the active provider
 *                            (never triggers upstream traffic).
 * 2. POST <refreshPath>    — force one upstream fetch, then serve the result.
 *
 * Each provider is an adapter (see providers/opencode.js) exposing
 *   { id, displayName, config(merged), fetchUsage(ctx) }
 * State is tracked per provider id; the routes serve the "active" provider —
 * today that is always the first registered one (opencode), which keeps the
 * wire shape and the existing client compatible while the client-side
 * multi-provider UI lands in the companion step.
 *
 * The OpenCode model-list sync (live listing merge, models.dev enrichment,
 * discovery wrap, vision/text-only overrides) moved out to dsh-plugin-toolkit's
 * `modelCapability` optimization.
 *
 * @license MIT
 */

import z from "@deepseek-ai/schemastery";
import { opencodeProvider } from "./providers/opencode.js";
import { minimaxProvider } from "./providers/minimax.js";
import { kimiProvider } from "./providers/kimi.js";
import { deepseekProvider } from "./providers/deepseek.js";

export const name = "quota-badges";
export const inject = ["webServer", "settings"];

/**
 * Plugin configuration. Top-level flat keys remain the OpenCode compatibility
 * layer (the legacy settings document used them); a nested `providers.*`
 * block carries per-provider config and overrides the flat keys.
 */
export const Config = z.object({
  /** Explicit OpenCode API key; empty falls back to the apiKeyEnvVar environment variable. */
  apiKey: z.string().default(""),
  /** Environment variable consulted when apiKey is empty. */
  apiKeyEnvVar: z.string().default("OPENCODE_API_KEY"),
  /** Background poll period in seconds; floored at 15 to keep upstream traffic sane. */
  intervalSec: z.number().default(60),
  /** Per-request upstream timeout in seconds. */
  timeoutSec: z.number().default(10),
  /** Same-origin route serving the cached snapshot (GET). */
  statusPath: z.string().default("/api/quota-badges/status"),
  /** Same-origin route forcing one refresh (POST). */
  refreshPath: z.string().default("/api/quota-badges/refresh"),
  /** Show the badge only while the session's selected model comes from an opencode provider. */
  syncWithModel: z.boolean().default(true),
  /**
   * Provider ids pinned as editable blocks in the settings card; the rest wait
   * behind the card's "add provider" picker. Purely a UI-curation key - the
   * server keeps polling every registered provider (a removed block also gets
   * its saved key cleared, so it goes unqueried in practice unless an env var
   * supplies one). New vendors stay opt-in: bump this seed list only to change
   * what fresh installs see by default.
   */
  visibleProviders: z.array(z.string()).default(["opencode", "minimax"]),
  /**
   * Per-provider configuration, keyed by provider id. Values here override the
   * flat compatibility keys above for that provider. Schema is a permissive
   * dict because each adapter validates its own slice.
   */
  providers: z.dict(z.dict(z.any())).default({}),
});

/** Active configuration until apply() stores the validated values. */
let pluginConfig = {
  apiKey: "",
  apiKeyEnvVar: "OPENCODE_API_KEY",
  intervalSec: 60,
  timeoutSec: 10,
  statusPath: "/api/quota-badges/status",
  refreshPath: "/api/quota-badges/refresh",
  syncWithModel: true,
  visibleProviders: ["opencode", "minimax"],
  providers: {},
};

/**
 * Live settings-scope handle for the registered namespace; null keeps the
 * composition values (settings seam absent). Every read goes through
 * currentConfig() so Web-settings edits apply without a restart.
 */
let settingsHandle = null;

/** Merge the composition layer with any newer user-layer settings section. */
function currentConfig() {
  const section = settingsHandle?.get?.();
  if (!section || typeof section !== "object") return pluginConfig;
  return { ...pluginConfig, ...section };
}

/** Resolve the Bearer key: explicit config wins, then the configured env var. */
function resolveApiKey(config) {
  const explicit = (config.apiKey ?? "").trim();
  if (explicit !== "") return explicit;
  const fromEnv = process.env[config.apiKeyEnvVar];
  return typeof fromEnv === "string" ? fromEnv.trim() : "";
}

/**
 * Registered provider adapters in display order. index.js assembles state and
 * routes from this table; each adapter owns its upstream specifics.
 */
const providers = new Map([
  [opencodeProvider.id, opencodeProvider],
  [minimaxProvider.id, minimaxProvider],
  [kimiProvider.id, kimiProvider],
  [deepseekProvider.id, deepseekProvider],
]);

/** The provider served by the status/refresh routes (first registered today). */
function activeProvider() {
  // Multi-provider selection (model-follow) lands in the client step; for now
  // the first registered adapter is the active one and the wire shape is
  // unchanged from the single-provider version.
  return providers.values().next().value;
}

// ── quota state & routes ────────────────────────────────────────────────────

/**
 * Shared latest-known state per provider, served to every connected badge.
 * Kept per provider id so adding providers never mixes snapshots.
 */
const stateByProvider = new Map();

function providerState(providerId) {
  let entry = stateByProvider.get(providerId);
  if (entry === undefined) {
    entry = { data: null, error: null, fetchedAt: 0, refreshing: null };
    stateByProvider.set(providerId, entry);
  }
  return entry;
}

/** Backing store for ctx.effect captured during provider fetch. */
let ctxEffect = (label, fn) => fn();

/**
 * One refresh cycle for a provider, deduplicated while in flight. Keeps the
 * previous snapshot on upstream failure so badges degrade to stale-with-error
 * instead of blanking.
 */
async function refreshProvider(provider, logger) {
  const entry = providerState(provider.id);
  if (entry.refreshing) return entry.refreshing;
  entry.refreshing = (async () => {
    try {
      const { snapshot, error } = await provider.fetchUsage({
        logger,
        config: () => provider.config(currentConfig()),
        resolveApiKey,
        effect: (fn, label) => ctxEffect(fn, label),
      });
      if (snapshot !== null) {
        entry.data = snapshot;
        entry.error = null;
      } else {
        entry.error = error;
      }
      entry.fetchedAt = Date.now();
    } finally {
      entry.refreshing = null;
    }
  })();
  return entry.refreshing;
}

/** Refresh every registered provider concurrently, each with its own dedupe. */
function refreshAllProviders(logger) {
  return Promise.all([...providers.values()].map((p) => refreshProvider(p, logger)));
}

/** JSON body describing the active provider's state, shared by both quota routes. */
function payload() {
  const provider = activeProvider();
  const entry = providerState(provider.id);
  // `all` carries every provider's entry so the client can render a multi-
  // provider aggregate; the top-level fields stay the active provider's for
  // backward compatibility with the single-provider client shape.
  const all = {};
  for (const [id, p] of providers) {
    const e = providerState(id);
    all[id] = {
      provider: id,
      displayName: p.displayName,
      data: e.data,
      error: e.error,
      fetchedAt: e.fetchedAt === 0 ? null : new Date(e.fetchedAt).toISOString(),
      ageSec: e.fetchedAt === 0 ? null : Math.round((Date.now() - e.fetchedAt) / 1000),
    };
  }
  return {
    ok: true,
    provider: provider.id,
    displayName: provider.displayName,
    data: entry.data,
    error: entry.error,
    fetchedAt: entry.fetchedAt === 0 ? null : new Date(entry.fetchedAt).toISOString(),
    ageSec: entry.fetchedAt === 0 ? null : Math.round((Date.now() - entry.fetchedAt) / 1000),
    providers: [...providers.values()].map((p) => p.id),
    all,
  };
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Build the per-provider context handed to adapter methods.
 */
function providerCtx(provider, logger) {
  return {
    logger,
    config: () => provider.config(currentConfig()),
    resolveApiKey,
    effect: (fn, label) => ctxEffect(fn, label),
  };
}

/**
 * Plugin activation: store config, register the settings namespace (live —
 * Web-settings edits re-key and reschedule without a restart), start the
 * poller, and mount the two HTTP routes on the shared web server.
 */
export function apply(ctx, config) {
  pluginConfig = { ...pluginConfig, ...(config || {}) };
  if (pluginConfig.intervalSec < 15) pluginConfig.intervalSec = 15;
  if (pluginConfig.timeoutSec < 1) pluginConfig.timeoutSec = 1;
  ctxEffect = ctx.effect.bind(ctx);

  const logger = ctx.logger;
  void refreshAllProviders(logger);

  // Register the settings namespace over the exported Config schema, seeded
  // with this composition's values; keep the live handle so currentConfig()
  // serves user-layer edits. A watch on the interval field reschedules the
  // poller in place.
  let reschedule = () => {};
  ctx.inject(["settings"], (sctx) => {
    try {
      settingsHandle = sctx.settings.register("quota-badges", Config, { base: pluginConfig });
      settingsHandle.watch?.((next, prev) => {
        if ((next?.intervalSec ?? 0) !== (prev?.intervalSec ?? 0)) reschedule();
        void refreshAllProviders(logger);
      });
      // Boot race repair: the apply-time kick may have run before this handle
      // existed and read only the composition layer. If that left an
      // unconfigured error while the live section carries a key, retry now.
      const hadUnconfigured = [...providers.values()].some((p) => {
        const e = providerState(p.id);
        return e.data === null && e.error?.code === "unconfigured";
      });
      if (hadUnconfigured) {
        void refreshAllProviders(logger);
      }
    } catch (error) {
      logger?.warn?.("[quota-badges] settings registration:", error);
    }
  });

  // Background poller; the returned disposer clears it with our fiber. The
  // interval reads live config so settings edits take effect immediately.
  ctx.effect(() => {
    let timer;
    const start = () => {
      clearInterval(timer);
      const period = Math.max(15, currentConfig().intervalSec) * 1000;
      timer = setInterval(() => {
        void refreshAllProviders(logger);
      }, period);
      timer.unref?.();
    };
    start();
    reschedule = start;
    return () => {
      clearInterval(timer);
      reschedule = () => {};
    };
  }, "quota-badges: poller");

  // GET status: serve whatever the active provider already knows. Route paths
  // are read once at registration; changing them is a restart-level change.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: pluginConfig.statusPath,
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, { ok: false, error: "Method not allowed" }, 405);
            return;
          }
          sendJson(res, payload());
        },
      }),
    "quota-badges: GET status route",
  );

  // POST refresh: force one upstream fetch for every provider, then answer.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: pluginConfig.refreshPath,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, { ok: false, error: "Method not allowed" }, 405);
            return;
          }
          await refreshAllProviders(logger);
          sendJson(res, payload());
        },
      }),
    "quota-badges: POST refresh route",
  );
}