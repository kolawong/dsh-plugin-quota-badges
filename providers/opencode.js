/**
 * dsh-plugin-quota-badges — OpenCode (Zen Go) provider adapter.
 *
 * Everything OpenCode-specific lives here: its upstream endpoints, Bearer
 * auth resolution, and usage-window parsing (via usage-core). index.js
 * assembles providers through a registry; this module exposes the
 * `opencodeProvider` adapter with the shared contract:
 *
 *   {
 *     id, displayName,
 *     config: (merged) => providerConfig,       // extract this provider's slice
 *     fetchUsage: (ctx) => Promise<{snapshot, error}>,
 *   }
 *
 * `ctx` is a small context object injected by the assembly layer:
 *   { logger, config, resolveApiKey, effect }
 *
 * The model-list sync (model discovery enrichment, the llm-pi-ai catalog
 * write, and the forced vision / text-only overrides) moved to
 * dsh-plugin-toolkit's `modelCapability` optimization.
 *
 * @license MIT
 */

import { parseUsageText } from "../usage-core.js";

/** Upstream usage endpoint; a fixed protocol address of the OpenCode Zen Go API. */
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

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
        // An empty key (no caller does this today) means an unauthenticated call.
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

// ── adapter export ──────────────────────────────────────────────────────────

/**
 * The OpenCode provider adapter. `config(merged)` extracts the provider slice
 * from the merged plugin config; the top-level flat keys (apiKey, …) act as
 * the compatibility layer for the legacy flat settings document, while a
 * nested `providers.opencode.*` block (when present) overrides them.
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
    };
  },

  fetchUsage(ctx) {
    return fetchUsageSnapshot(ctx);
  },
};

// Kept exported for tests and introspection.
export const opencodeInternals = {
  USAGE_URL,
};