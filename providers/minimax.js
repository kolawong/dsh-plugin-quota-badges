/**
 * dsh-plugin-quota-badges — MiniMax provider adapter (API Token / JSON path).
 *
 * Simplified port of CodexBar's MiniMax fetcher (Sources/CodexBarCore/Providers/
 * MiniMax/MiniMaxUsageFetcher.swift): only the API-token, JSON "coding plan
 * remains" path — no cookie header, no HTML scrape, no billing history. That
 * keeps this adapter lean while sharing CodexBar's parsing semantics:
 *
 *   - GET {apiBase}/v1/api/openplatform/coding_plan/remains
 *   - Authorization: Bearer <token>, accept: application/json
 *   - data.modelRemains[] per model: interval (rolling) + weekly lanes;
 *     current_interval_usage_count is REMAINING quota,
 *     current_interval_remaining_percent is a remaining fraction of 100.
 *   - usedPercent = 100 - remainingPercent (or used/limit when counts only).
 *
 * The snapshot is normalized to the plugin's shared wire shape (rolling /
 * weekly / monthly + renewsAt + fetchedAt), with MiniMax-specific detail
 * (plan name, points balance, per-service lanes) carried under `extra` for
 * the client's detail popover.
 *
 * @license MIT
 */

import { upstreamFetch, extractServerErrorMessage } from "./opencode.js";
import { QuotaAuthError, QuotaApiError, QuotaParseError } from "./opencode.js";

/** API base per region; mirrors CodexBar MiniMaxAPIRegion. */
const REGION_API_BASES = {
  global: "https://api.minimax.io",
  cn: "https://api.minimaxi.com",
};

const REMAINS_PATH = "/v1/api/openplatform/coding_plan/remains";

/** Model-name → service display mapping (CodexBar mapModelNameToServiceType). */
function mapModelNameToServiceType(modelName) {
  const lower = String(modelName).trim().toLowerCase();
  if (lower === "general" || lower === "video") return lower;
  if (isTextGenerationModelName(lower)) return "text-generation";
  if (lower.includes("speech")) return "text-to-speech";
  if (lower.includes("hailuo") && lower.includes("fast")) return "image-to-video";
  if (lower.includes("hailuo")) return "text-to-video";
  if (lower.startsWith("image-")) return "image-generation";
  if (lower.includes("music")) return "music-generation";
  return String(modelName);
}

/** Legacy text model names (minimax-m*, M2.*) plus the general bucket. */
function isTextGenerationModelName(lower) {
  return lower === "general" || lower.includes("minimax-m") || lower.startsWith("m2.");
}

/** Weekly lanes only exist for the text lane (CodexBar shouldRenderWeeklyWindow). */
function shouldRenderWeeklyWindow(modelName) {
  return isTextGenerationModelName(String(modelName).trim().toLowerCase());
}

/** Epoch seconds-or-millis → ms; mirrors CodexBar dateFromEpoch. */
function toDateMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value > 1_000_000_000_000) return value;
  if (value > 1_000_000_000) return value * 1000;
  return undefined;
}

/** Window minutes from start/end epoch, when both are present and sane. */
function windowMinutes(startMs, endMs) {
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined;
  return Math.round((endMs - startMs) / 60000);
}

/** Reset instant: end-of-window when in the future, else now + remains seconds. */
function resetsAt(endMs, remainsTime, nowMs) {
  if (endMs !== undefined && endMs > nowMs) return endMs;
  if (typeof remainsTime === "number" && remainsTime > 0) {
    const seconds = remainsTime > 1_000_000 ? remainsTime / 1000 : remainsTime;
    return nowMs + seconds * 1000;
  }
  return undefined;
}

/** usedPercent clamp helper. */
function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

/**
 * Read one model-remains item into a normalized window, or null when the lane
 * is an unavailable placeholder. Mirrors CodexBar makeServiceUsage. The API
 * answers snake_case JSON keys (see MiniMaxModelRemains.swift CodingKeys).
 */
function laneWindow(item, { weekly = false, nowMs } = {}) {
  const total = weekly ? item.current_weekly_total_count : item.current_interval_total_count;
  const remaining = weekly ? item.current_weekly_usage_count : item.current_interval_usage_count;
  const remainingPercent = weekly ? item.current_weekly_remaining_percent : item.current_interval_remaining_percent;
  const status = weekly ? item.current_weekly_status : item.current_interval_status;
  const startMs = toDateMs(weekly ? item.weekly_start_time : item.start_time);
  const endMs = toDateMs(weekly ? item.weekly_end_time : item.end_time);
  const remainsTime = weekly ? item.weekly_remains_time : item.remains_time;
  const boostPermille = weekly
    ? item.weekly_boost_permill ?? item.weekly_boost_permille
    : item.interval_boost_permill ?? item.interval_boost_permille;

  // Unavailable placeholder: status 3 with zero counts and full remaining.
  if (status === 3 && (total ?? 0) === 0 && (remaining ?? 0) === 0 && (remainingPercent ?? 0) >= 100) {
    return null;
  }

  let percent;
  let limit;
  let used;
  if (typeof remainingPercent === "number" && Number.isFinite(remainingPercent)) {
    percent = 100 - remainingPercent;
    // Percent-quota limit derived from the boost permille (CodexBar percentQuotaLimit).
    limit = boostPermille && boostPermille > 0 ? Math.max(1, Math.round(boostPermille / 10)) : 100;
    used = Math.round((percent * limit) / 100);
  } else if (typeof total === "number" && total > 0 && typeof remaining === "number") {
    used = Math.max(0, total - remaining);
    percent = (used / total) * 100;
    limit = total;
  } else {
    return null;
  }

  return {
    percent: clampPercent(percent),
    resetInSec: Math.max(0, Math.round(((resetsAt(endMs, remainsTime, nowMs) ?? nowMs) - nowMs) / 1000)),
    windowMinutes: windowMinutes(startMs, endMs),
    isUnlimited: false,
  };
}

/** Pull the plan name from the coding-plan payload (CodexBar parsePlanName). */
function planName(data) {
  // API answers snake_case; camelCase kept as a tolerant fallback.
  for (const key of [
    "current_subscribe_title",
    "currentSubscribeTitle",
    "plan_name",
    "planName",
    "combo_title",
    "comboTitle",
    "current_plan_title",
    "currentPlanTitle",
  ]) {
    const value = data?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** Read points balance across the several aliases CodexBar accepts. */
function pointsBalance(data) {
  for (const key of [
    "points_balance",
    "point_balance",
    "credits_balance",
    "credit_balance",
    "balance",
    "pointsBalance",
  ]) {
    const value = data?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Parse one coding-plan remains JSON body into the shared snapshot shape.
 * Exported for tests. Throws Quota* errors on unusable bodies.
 *
 * The live API answers a FLAT payload — `model_remains` and `base_resp` at the
 * top level. Some fixtures (and CodexBar's HTML-scrape JSON) wrap them in a
 * `data` object; both shapes are accepted, mirroring CodexBar's payload
 * decoder which falls back to the top level when no `data` key exists.
 */
export function parseMiniMaxUsage(text, nowMs = Date.now()) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new QuotaParseError("MiniMax usage response is not JSON");
  }
  if (body === null || typeof body !== "object") {
    throw new QuotaParseError("MiniMax usage response is not an object");
  }
  // Flat payload: model_remains + base_resp at the top level. Nested: under data.
  const hasFlat = Array.isArray(body.model_remains ?? body.modelRemains);
  const data = hasFlat ? body : body?.data;
  if (data === null || typeof data !== "object") {
    throw new QuotaParseError('MiniMax usage response has no "model_remains" and no "data" object');
  }
  // base_resp lives beside model_remains (top level in the flat shape, inside
  // data in the nested shape); the other fallbacks cover the older fixtures.
  const baseResp = data.base_resp ?? data.baseResp ?? body.base_resp ?? body.baseResp;
  if (baseResp?.status_code !== undefined && baseResp.status_code !== 0 && baseResp.status_code !== null) {
    const status = baseResp.status_code;
    const message = baseResp.status_msg ?? baseResp.status_message ?? `status_code ${status}`;
    if (status === 1004 || /cookie|log in|login/i.test(String(message))) {
      throw new QuotaAuthError("MiniMax");
    }
    throw new QuotaApiError(String(message) || "HTTP error", status, "MiniMax");
  }
  const modelRemains = data.model_remains ?? data.modelRemains;
  if (!Array.isArray(modelRemains) || modelRemains.length === 0) {
    throw new QuotaParseError('MiniMax usage response has no "model_remains" array');
  }

  const lanes = [];
  for (const item of modelRemains) {
    const modelName = item?.model_name ?? item?.modelName;
    if (typeof modelName !== "string" || modelName === "") continue;
    const interval = laneWindow(item, { nowMs });
    const weekly = shouldRenderWeeklyWindow(modelName) ? laneWindow(item, { weekly: true, nowMs }) : null;
    // Skip lanes with no usable quota window (unavailable placeholders); a lane
    // that only has a weekly window still counts.
    if (interval === null && weekly === null) continue;
    lanes.push({ modelName, interval, weekly });
  }
  if (lanes.length === 0) throw new QuotaParseError("MiniMax usage response has no parseable model lanes");

  // Prefer the text lane (general / text-generation) for the primary window;
  // fall back to the first lane — CodexBar orders text lanes first.
  const textLane = lanes.find((l) => {
    const type = mapModelNameToServiceType(l.modelName).toLowerCase();
    return type === "general" || type === "text-generation";
  }) ?? lanes[0];

  return {
    rolling: textLane.interval,
    weekly: textLane.weekly,
    monthly: null,
    extra: {
      planName: planName(modelRemains) ?? planName(data),
      planTitle: planName(data) ?? planName(modelRemains),
      pointsBalance: pointsBalance(data),
      services: lanes.map((l) => ({
        model: l.modelName,
        displayName: mapModelNameToServiceType(l.modelName),
        interval: l.interval,
        weekly: l.weekly,
      })),
    },
  };
}

/** Build the remains URL for one region. */
export function remainsURL(region) {
  const base = REGION_API_BASES[region] ?? REGION_API_BASES.cn;
  return base + REMAINS_PATH;
}

/** Fetch and parse one MiniMax usage snapshot. */
export async function fetchMiniMaxUsage(ctx) {
  const { logger, resolveApiKey } = ctx;
  /** ctx.config is always a function returning the current provider config. */
  const config = typeof ctx.config === "function" ? ctx.config() : ctx.config;
  // Explicit config key wins; then try the configured env var, then the
  // alternate common name (some dsh llm routes reference MINIMAX_API_KEY).
  let apiKey = resolveApiKey(config);
  if (apiKey === "" && config.apiKeyEnvVar === "MINIMAX_CN_API_KEY") {
    apiKey = (process.env.MINIMAX_API_KEY ?? "").trim();
  }
  if (apiKey === "") {
    return {
      snapshot: null,
      error: {
        code: "unconfigured",
        message: "No MiniMax API key: set providers.minimax.apiKey or export " + config.apiKeyEnvVar + " / MINIMAX_API_KEY",
      },
    };
  }
  const region = config.region ?? "cn";
  const url = remainsURL(region);
  try {
    const response = await upstreamFetch(url, apiKey, undefined, undefined, config.timeoutSec);
    if (response.status === 401 || response.status === 403) throw new QuotaAuthError("MiniMax");
    const text = await response.text();
    if (!response.ok) {
      throw new QuotaApiError(extractServerErrorMessage(text) ?? "", response.status, "MiniMax");
    }
    const now = Date.now();
    const parsed = parseMiniMaxUsage(text, now);
    return {
      snapshot: { ...parsed, fetchedAt: new Date(now).toISOString() },
      error: null,
    };
  } catch (error) {
    if (error instanceof QuotaAuthError || error instanceof QuotaApiError || error instanceof QuotaParseError) {
      return { snapshot: null, error: { code: error.code, message: error.message } };
    }
    logger?.warn?.("[quota-badges] minimax upstream fetch failed:", error);
    return {
      snapshot: null,
      error: { code: "network-error", message: error?.message ?? String(error) },
    };
  }
}

// ── adapter export ──────────────────────────────────────────────────────────

/** The MiniMax provider adapter (API-token path only, as scoped). */
export const minimaxProvider = {
  id: "minimax",
  displayName: "MiniMax",
  usageUrl: (region) => remainsURL(region),

  config(merged) {
    const nested = merged?.providers?.minimax;
    return {
      apiKey: nested?.apiKey ?? "",
      // MiniMax's env var is provider-specific; never inherit the opencode
      // top-level apiKeyEnvVar compatibility key. Accept both common names.
      apiKeyEnvVar: nested?.apiKeyEnvVar ?? "MINIMAX_CN_API_KEY",
      timeoutSec: merged?.timeoutSec ?? 10,
      region: nested?.region ?? "cn",
      syncWithModel: merged?.syncWithModel ?? true,
    };
  },

  fetchUsage(ctx) {
    return fetchMiniMaxUsage(ctx);
  },
};