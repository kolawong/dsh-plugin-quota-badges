/**
 * dsh-plugin-quota-badges - Kimi For Coding provider adapter (API key path).
 *
 * Port of CodexBar's Kimi Code API fetcher
 * (Sources/CodexBarCore/Providers/Kimi/KimiUsageFetcher.swift): only the
 * API-key path - no Kimi Code CLI credential reuse, no browser cookie import,
 * no web GetUsages fallback, no subscription-stats enrichment. That keeps this
 * adapter lean while sharing CodexBar's parsing semantics:
 *
 *   - GET {baseURL}/coding/v1/usages   (default base https://api.kimi.com)
 *   - Authorization: Bearer <api key>, Accept: application/json
 *   - top-level `usage` is the FEATURE_CODING weekly membership pool:
 *     { limit: "2048", used: "214", remaining: "1834", resetTime: ISO }
 *   - `limits[0]` is the 5-hour rate limit: window { duration: 300,
 *     timeUnit: "TIME_UNIT_MINUTE" } with the same detail shape.
 *   - counts arrive as strings (numbers tolerated); `used` is authoritative
 *     and may exceed the limit during overage; `remaining` (0..limit) is the
 *     fallback for used = limit - remaining.
 *
 * The snapshot is normalized to the plugin's shared wire shape (rolling =
 * the 5-hour rate limit, weekly = the membership pool, monthly = null).
 *
 * Kimi Code is distinct from the Moonshot/Kimi Open Platform: China-issued
 * open-platform keys belong to that product, not this subscription.
 *
 * @license MIT
 */

import { upstreamFetch, extractServerErrorMessage } from "./opencode.js";
import { QuotaAuthError, QuotaApiError, QuotaParseError } from "./opencode.js";

/** Default API host; override only for a compatible HTTPS proxy. */
const DEFAULT_BASE_URL = "https://api.kimi.com";
const USAGE_PATH = "/coding/v1/usages";

/** Window unit -> minutes (CodexBar KimiWindow.durationMinutes). */
const TIME_UNIT_MINUTES = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 24 * 60,
};

/** Reset-time keys accepted on one usage detail (CodexBar CodingKeys). */
const RESET_TIME_KEYS = ["resetTime", "resetAt", "reset_time", "reset_at"];

/** Coerce a count that may arrive as a string, number, or be absent. */
function toCount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * CodexBar usageCounts: used is authoritative (>= 0, may exceed the limit
 * during overage); remaining must be a valid balance (0..limit); a parseable
 * limit with neither counter is NOT a usable window for this port - showing a
 * fabricated gauge is worse than withholding the lane.
 * @returns {{ used: number, limit: number } | null}
 */
function usageCounts(detail) {
  if (detail === null || typeof detail !== "object") return null;
  const limit = toCount(detail.limit);
  if (limit === undefined || limit <= 0) return null;
  const used = toCount(detail.used);
  if (used !== undefined && used >= 0) return { used, limit };
  const remaining = toCount(detail.remaining);
  if (remaining !== undefined && remaining >= 0 && remaining <= limit) {
    return { used: limit - remaining, limit };
  }
  return null;
}

/** First reset-time string present on a usage detail, or undefined. */
function resetTimeOf(detail) {
  for (const key of RESET_TIME_KEYS) {
    const value = detail?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** ISO text (fractional seconds of any width tolerated by Date) -> ms. */
function toDateMs(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Window minutes from a Kimi rate-limit window object, or undefined. */
function windowMinutes(window) {
  if (window === null || typeof window !== "object") return undefined;
  const duration = toCount(window.duration);
  const multiplier = TIME_UNIT_MINUTES[window.timeUnit];
  if (duration === undefined || duration <= 0 || multiplier === undefined) return undefined;
  return duration * multiplier;
}

/** clamp helper. */
function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

/**
 * One usage detail -> normalized window, or null when no reliable counts.
 * The reset is floored at zero like the OpenCode parser (a just-rolled
 * window reports a past or imminent resetTime).
 * @param {Record<string, unknown>} detail
 * @param {number} nowMs
 * @param {number | undefined} minutes - window length for `extra` reporting.
 */
function detailWindow(detail, nowMs) {
  const counts = usageCounts(detail);
  if (counts === null) return null;
  const percent = clampPercent((counts.used / counts.limit) * 100);
  const resetMs = toDateMs(resetTimeOf(detail) ?? "");
  const resetInSec = resetMs === undefined ? 0 : Math.max(0, Math.round((resetMs - nowMs) / 1000));
  return {
    percent,
    resetInSec,
    used: counts.used,
    limit: counts.limit,
  };
}

/**
 * Parse a Kimi Code usages JSON body into the shared snapshot shape.
 * Exported for tests. Throws Quota* errors on unusable bodies.
 * @param {string} text - response body.
 * @param {number} nowMs - epoch ms.
 */
export function parseKimiUsage(text, nowMs = Date.now()) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new QuotaParseError("Kimi usage response is not JSON");
  }
  if (body === null || typeof body !== "object") {
    throw new QuotaParseError("Kimi usage response is not an object");
  }

  // Top-level `usage` (the weekly membership pool) is required; `limits`
  // (the 5-hour rate lane) is optional - a fresh console key may answer
  // before any rate window exists.
  const weeklyWindow = detailWindow(body.usage, nowMs);
  if (weeklyWindow === null) {
    throw new QuotaParseError("Kimi usage response has no usable `usage` detail");
  }

  const limits = Array.isArray(body.limits) ? body.limits : [];
  const rateLimit = limits.length > 0 ? limits[0] : null;
  const rollingWindow = rateLimit ? detailWindow(rateLimit.detail, nowMs) : null;
  const minutes = rateLimit ? windowMinutes(rateLimit.window) : undefined;

  return {
    rolling: rollingWindow
      ? { percent: rollingWindow.percent, resetInSec: rollingWindow.resetInSec }
      : null,
    weekly: { percent: weeklyWindow.percent, resetInSec: weeklyWindow.resetInSec },
    monthly: null,
    extra: {
      windowMinutes: minutes ?? 300,
      weekly: { used: weeklyWindow.used, limit: weeklyWindow.limit },
      ...(rollingWindow
        ? { rolling: { used: rollingWindow.used, limit: rollingWindow.limit } }
        : {}),
    },
  };
}

/**
 * Build the usages URL for one base, mirroring CodexBar's endpoint
 * normalization: bases ending in /coding/v1 or /coding get only the missing
 * suffix; anything else gets the full /coding/v1/usages appended.
 */
export function usagesURL(baseURL = DEFAULT_BASE_URL) {
  const base = String(baseURL ?? "").trim() || DEFAULT_BASE_URL;
  const trimmed = base.replace(/\/+$/, "");
  if (/\/coding\/v1$/i.test(trimmed)) return trimmed + "/usages";
  if (/\/coding$/i.test(trimmed)) return trimmed + "/v1/usages";
  return trimmed + "/coding/v1/usages";
}

/** Fetch and parse one Kimi Code usage snapshot. */
export async function fetchKimiUsage(ctx) {
  const { logger, resolveApiKey } = ctx;
  /** ctx.config is always a function returning the current provider config. */
  const config = typeof ctx.config === "function" ? ctx.config() : ctx.config;
  const apiKey = resolveApiKey(config);
  if (apiKey === "") {
    return {
      snapshot: null,
      error: {
        code: "unconfigured",
        message: "No Kimi Code API key: set providers.kimi.apiKey or export " + config.apiKeyEnvVar,
      },
    };
  }
  const url = usagesURL(config.baseURL);
  try {
    const response = await upstreamFetch(url, apiKey, undefined, undefined, config.timeoutSec);
    // CodexBar's codeAPIError mapping: 401 is a bad key; 403 is permission or
    // quota denial (not necessarily the key); anything else is a plain API
    // error carrying the server's message.
    if (response.status === 401) throw new QuotaAuthError("Kimi Code");
    const text = await response.text();
    if (!response.ok) {
      throw new QuotaApiError(
        extractServerErrorMessage(text)
          ?? (response.status === 403 ? "permission or quota denied" : ""),
        response.status,
        "Kimi Code",
      );
    }
    const now = Date.now();
    const parsed = parseKimiUsage(text, now);
    return {
      snapshot: { ...parsed, fetchedAt: new Date(now).toISOString() },
      error: null,
    };
  } catch (error) {
    if (error instanceof QuotaAuthError || error instanceof QuotaApiError || error instanceof QuotaParseError) {
      return { snapshot: null, error: { code: error.code, message: error.message } };
    }
    logger?.warn?.("[quota-badges] kimi upstream fetch failed:", error);
    return {
      snapshot: null,
      error: { code: "network-error", message: error?.message ?? String(error) },
    };
  }
}

// ── adapter export ──────────────────────────────────────────────────────────

/** The Kimi For Coding provider adapter (API-key path only, as scoped). */
export const kimiProvider = {
  id: "kimi",
  displayName: "Kimi Code",
  usageUrl: (baseURL) => usagesURL(baseURL),

  config(merged) {
    const nested = merged?.providers?.kimi;
    return {
      apiKey: nested?.apiKey ?? "",
      // Kimi Code's env var is provider-specific; never inherit the opencode
      // top-level apiKeyEnvVar compatibility key.
      apiKeyEnvVar: nested?.apiKeyEnvVar ?? "KIMI_CODE_API_KEY",
      baseURL: nested?.baseURL ?? DEFAULT_BASE_URL,
      timeoutSec: merged?.timeoutSec ?? 10,
      syncWithModel: merged?.syncWithModel ?? true,
    };
  },

  fetchUsage(ctx) {
    return fetchKimiUsage(ctx);
  },
};
