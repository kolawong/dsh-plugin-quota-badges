/**
 * dsh-plugin-quota-badges - ClinePass provider adapter (API key path).
 *
 * Port of CodexBar's ClinePass provider
 * (Sources/CodexBarCore/Resources/Plugins/clinepass.ts and
 * Sources/CodexBarCore/Providers/ClinePass/ClinePassProviderDescriptor.swift):
 * only the API-key path - no `cline auth` CLI session reuse, no
 * `~/.cline/data/settings/providers.json` credential import (CodexBar's
 * ClinePassSettingsReader does that, but this plugin deliberately keeps every
 * adapter on "explicit key + environment variable" so no vendor adapter reads
 * local credential files).
 *
 *   - GET https://api.cline.bot/api/v1/users/me/plan/usage-limits
 *   - Authorization: Bearer <API key>, Accept: application/json
 *   - { success: true, data: { limits: [ { type, percentUsed, resetsAt } ] } }
 *   - limit `type` five_hour -> rolling (5-hour rate window), weekly -> weekly,
 *     monthly -> monthly; any other type is ignored (CodexBar `continue`s on an
 *     unmapped window kind rather than failing the whole response).
 *   - `percentUsed` is a 0..100 percentage (clamped, like CodexBar);
 *     `resetsAt` is an optional ISO-8601 timestamp.
 *
 * CodexBar labels the three ClinePass lanes "5-hour" / "Weekly" / "Monthly"
 * (PluginProviderSpec sessionLabel/weeklyLabel/opusLabel), which is exactly
 * this plugin's rolling/weekly/monthly wire shape - so the client needs no new
 * window rendering, only the provider registration and its settings block.
 *
 * The provider id is `cline` (not `clinepass`) on purpose: the client's
 * model-follow match is a case-insensitive substring test of the vendor id
 * against the selected model's provider id, so `cline` covers `cline`,
 * `clinepass` and `cline-bot` alike; the display name stays CodexBar's
 * "ClinePass".
 *
 * @license MIT
 */

import { upstreamFetch, extractServerErrorMessage } from "./opencode.js";
import { QuotaAuthError, QuotaApiError, QuotaParseError } from "./opencode.js";

/** Fixed protocol address of the ClinePass usage-limits API (CodexBar plugin). */
const USAGE_URL = "https://api.cline.bot/api/v1/users/me/plan/usage-limits";

/** ClinePass limit `type` -> this plugin's window slot. */
const WINDOW_SLOTS = {
  five_hour: "rolling",
  weekly: "weekly",
  monthly: "monthly",
};

/** Window lengths in minutes, reported through `extra` (CodexBar windowMinutes). */
const WINDOW_MINUTES = {
  five_hour: 5 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
};

/** Primary environment variable (CodexBar spec.environmentKey). */
const PRIMARY_ENV_VAR = "CLINE_API_KEY";
/** Alias consulted when the primary variable is the one in force but unset. */
export const ALTERNATE_ENV_VAR = "CLINEPASS_API_KEY";

/** clamp helper. */
function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

/**
 * Parse a ClinePass usage-limits JSON body into the shared snapshot shape
 * (rolling/weekly/monthly windows). Exported for tests. Throws Quota* errors
 * on unusable bodies, mirroring the validation order of CodexBar's
 * clinepass.ts script (payload -> success -> data -> limits -> per-limit field
 * types). A response with no usable window at all is rejected rather than
 * rendered as an empty gauge.
 *
 * @param {string} text - response body.
 * @param {number} nowMs - epoch ms (for determinism in tests).
 */
export function parseClinePassUsage(text, nowMs = Date.now()) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new QuotaParseError("ClinePass usage response is not JSON", "ClinePass");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new QuotaParseError("ClinePass usage response is not an object", "ClinePass");
  }
  if (body.success !== true) {
    throw new QuotaParseError(
      body.success === false
        ? "ClinePass usage response reported success: false"
        : "ClinePass usage response has no boolean success field",
      "ClinePass",
    );
  }
  const data = body.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new QuotaParseError("ClinePass usage response has no data object", "ClinePass");
  }
  if (!Array.isArray(data.limits)) {
    throw new QuotaParseError("ClinePass usage response has no limits array", "ClinePass");
  }

  const snapshot = {
    rolling: null,
    weekly: null,
    monthly: null,
    extra: { reportedPercent: {} },
  };

  for (const rawLimit of data.limits) {
    if (rawLimit === null || typeof rawLimit !== "object" || Array.isArray(rawLimit)) {
      throw new QuotaParseError("ClinePass usage response contains a non-object limit", "ClinePass");
    }
    if (typeof rawLimit.type !== "string") {
      throw new QuotaParseError("ClinePass limit type is not a string", "ClinePass");
    }
    const slot = WINDOW_SLOTS[rawLimit.type];
    // An unmapped window kind is not an error: CodexBar skips it (skip-if-unknown),
    // so a future plan tier cannot blank out the windows we do understand.
    if (slot === undefined) continue;

    const percent = rawLimit.percentUsed;
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      throw new QuotaParseError(
        `ClinePass limit "${rawLimit.type}" has no numeric percentUsed`,
        "ClinePass",
      );
    }

    let resetInSec = 0;
    let resetsAt = null;
    if (rawLimit.resetsAt !== null && rawLimit.resetsAt !== undefined) {
      const ms = typeof rawLimit.resetsAt === "string" ? Date.parse(rawLimit.resetsAt) : NaN;
      if (typeof rawLimit.resetsAt !== "string" || Number.isNaN(ms)) {
        throw new QuotaParseError(
          `ClinePass limit "${rawLimit.type}" has an invalid resetsAt timestamp`,
          "ClinePass",
        );
      }
      resetsAt = rawLimit.resetsAt;
      // A just-rolled window may report an imminent or past reset; floor at 0.
      resetInSec = Math.max(0, Math.round((ms - nowMs) / 1000));
    }

    snapshot[slot] = { percent: clampPercent(percent), resetInSec };
    snapshot.extra.reportedPercent[slot] = percent;
    snapshot.extra.windowMinutes = {
      ...(snapshot.extra.windowMinutes ?? {}),
      [rawLimit.type]: WINDOW_MINUTES[rawLimit.type],
    };
    if (resetsAt !== null) {
      snapshot.extra.resetsAt = { ...(snapshot.extra.resetsAt ?? {}), [slot]: resetsAt };
    }
  }

  if (snapshot.rolling === null && snapshot.weekly === null && snapshot.monthly === null) {
    throw new QuotaParseError("ClinePass usage response has no usable quota window", "ClinePass");
  }
  return snapshot;
}

/** Fetch and parse one ClinePass usage snapshot. */
export async function fetchClinePassUsage(ctx) {
  const { logger, resolveApiKey } = ctx;
  /** ctx.config is always a function returning the current provider config. */
  const config = typeof ctx.config === "function" ? ctx.config() : ctx.config;
  let apiKey = resolveApiKey(config);
  // CodexBar also accepts the CLINEPASS_API_KEY alias when the primary env var
  // is unset (mirrors the DeepSeek DEEPSEEK_KEY / MiniMax alternate handling).
  if (apiKey === "" && config.apiKeyEnvVar === PRIMARY_ENV_VAR) {
    apiKey = (process.env[ALTERNATE_ENV_VAR] ?? "").trim();
  }
  if (apiKey === "") {
    return {
      snapshot: null,
      error: {
        code: "unconfigured",
        message:
          "No ClinePass API key: set providers.cline.apiKey or export " +
          PRIMARY_ENV_VAR + " / " + ALTERNATE_ENV_VAR,
      },
    };
  }
  try {
    const response = await upstreamFetch(USAGE_URL, apiKey, undefined, undefined, config.timeoutSec);
    // CodexBar's clinepass.ts status mapping: 401/403 invalid credentials,
    // 429 rate limited, >=500 provider unavailable, any other non-200 a plain
    // API failure carrying the server's message.
    if (response.status === 401 || response.status === 403) throw new QuotaAuthError("ClinePass");
    const text = await response.text();
    if (!response.ok) {
      const fallback =
        response.status === 429
          ? "rate limited"
          : response.status >= 500
            ? "provider unavailable"
            : "";
      throw new QuotaApiError(
        extractServerErrorMessage(text) ?? fallback,
        response.status,
        "ClinePass",
      );
    }
    const now = Date.now();
    const parsed = parseClinePassUsage(text, now);
    return {
      snapshot: { ...parsed, fetchedAt: new Date(now).toISOString() },
      error: null,
    };
  } catch (error) {
    if (error instanceof QuotaAuthError || error instanceof QuotaApiError || error instanceof QuotaParseError) {
      return { snapshot: null, error: { code: error.code, message: error.message } };
    }
    logger?.warn?.("[quota-badges] clinepass upstream fetch failed:", error);
    return {
      snapshot: null,
      error: { code: "network-error", message: error?.message ?? String(error) },
    };
  }
}

// ── adapter export ──────────────────────────────────────────────────────────

/** The ClinePass provider adapter (API-key path only, as scoped). */
export const clinepassProvider = {
  id: "cline",
  displayName: "ClinePass",
  usageUrl: USAGE_URL,

  config(merged) {
    const nested = merged?.providers?.cline;
    return {
      apiKey: nested?.apiKey ?? "",
      // ClinePass's env var is provider-specific; never inherit the opencode
      // top-level apiKeyEnvVar compatibility key.
      apiKeyEnvVar: nested?.apiKeyEnvVar ?? PRIMARY_ENV_VAR,
      timeoutSec: merged?.timeoutSec ?? 10,
      syncWithModel: merged?.syncWithModel ?? true,
    };
  },

  fetchUsage(ctx) {
    return fetchClinePassUsage(ctx);
  },
};
