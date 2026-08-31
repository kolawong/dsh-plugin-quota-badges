/**
 * dsh-plugin-quota-badges - DeepSeek provider adapter (API-key balance path).
 *
 * Port of CodexBar's DeepSeek fetcher
 * (Sources/CodexBarCore/Providers/DeepSeek/DeepSeekUsageFetcher.swift):
 * only the API-key balance endpoint - no platform session, no Chrome token
 * import, no amount/cost detail endpoints (those need the private dashboard
 * session an API key cannot authenticate).
 *
 * DeepSeek exposes NO per-window quota (no 5-hour / weekly / monthly windows),
 * only an account balance, so the adapter answers the plugin's shared snapshot
 * with a new `balance` field and null windows:
 *
 *   - GET https://api.deepseek.com/user/balance
 *   - Authorization: Bearer <API key>, Accept: application/json
 *   - is_available: boolean; balance_infos[] per currency with
 *     total_balance / granted_balance / topped_up_balance (string values).
 *   - Currency selection (CodexBar): prefer a funded USD entry, then any
 *     funded entry, then USD, then the first entry.
 *
 * The client renders balance lanes (amount + availability bar) instead of
 * percent windows for this provider; window-based providers are unchanged.
 *
 * @license MIT
 */

import { upstreamFetch, extractServerErrorMessage } from "./opencode.js";
import { QuotaAuthError, QuotaApiError, QuotaParseError } from "./opencode.js";

/** API-key balance endpoint (documented public endpoint). */
const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** Coerce a balance that may arrive as a string, number, or be absent. */
function toCount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

const emptyBalance = {
  currency: "USD",
  total: 0,
  granted: 0,
  toppedUp: 0,
  isAvailable: false,
};

/**
 * Parse a DeepSeek user/balance JSON body into the shared snapshot shape:
 * a `balance` block (currency, total/granted/toppedUp, isAvailable) and null
 * windows. Exported for tests. Throws Quota* errors on unusable bodies.
 * @param {string} text - response body.
 */
export function parseDeepSeekBalance(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new QuotaParseError("DeepSeek balance response is not JSON", "DeepSeek");
  }
  if (body === null || typeof body !== "object") {
    throw new QuotaParseError("DeepSeek balance response is not an object", "DeepSeek");
  }

  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const parsed = [];
  for (const info of infos) {
    if (info === null || typeof info !== "object") continue;
    const currency = typeof info.currency === "string" ? info.currency : "";
    if (currency === "") continue;
    const total = toCount(info.total_balance);
    const granted = toCount(info.granted_balance);
    const toppedUp = toCount(info.topped_up_balance);
    if (total === undefined || granted === undefined || toppedUp === undefined) {
      throw new QuotaParseError("Non-numeric balance value in response", "DeepSeek");
    }
    parsed.push({ currency, total, granted, toppedUp });
  }

  const isAvailable = body.is_available === true;
  if (parsed.length === 0) {
    return {
      balance: emptyBalance,
      rolling: null,
      weekly: null,
      monthly: null,
      extra: { kind: "balance" },
    };
  }

  // CodexBar's selection: a funded USD row (it must not be hidden behind an
  // empty USD entry the API sometimes returns), then any funded currency,
  // then USD, then the first entry.
  const selected =
    parsed.find((b) => b.currency === "USD" && b.total > 0)
    ?? parsed.find((b) => b.total > 0)
    ?? parsed.find((b) => b.currency === "USD")
    ?? parsed[0];

  return {
    balance: {
      currency: selected.currency,
      total: selected.total,
      granted: selected.granted,
      toppedUp: selected.toppedUp,
      isAvailable: isAvailable,
    },
    rolling: null,
    weekly: null,
    monthly: null,
    extra: { kind: "balance" },
  };
}

/** Fetch and parse one DeepSeek balance snapshot. */
export async function fetchDeepSeekUsage(ctx) {
  const { logger, resolveApiKey } = ctx;
  /** ctx.config is always a function returning the current provider config. */
  const config = typeof ctx.config === "function" ? ctx.config() : ctx.config;
  let apiKey = resolveApiKey(config);
  // CodexBar also accepts the DEEPSEEK_KEY alias when the primary env var is
  // unset (mirrors the MiniMax alternate-name handling).
  if (apiKey === "" && config.apiKeyEnvVar === "DEEPSEEK_API_KEY") {
    apiKey = (process.env.DEEPSEEK_KEY ?? "").trim();
  }
  if (apiKey === "") {
    return {
      snapshot: null,
      error: {
        code: "unconfigured",
        message: "No DeepSeek API key: set providers.deepseek.apiKey or export DEEPSEEK_API_KEY / DEEPSEEK_KEY",
      },
    };
  }
  try {
    const response = await upstreamFetch(BALANCE_URL, apiKey, undefined, undefined, config.timeoutSec);
    if (response.status === 401 || response.status === 403) throw new QuotaAuthError("DeepSeek");
    const text = await response.text();
    if (!response.ok) {
      throw new QuotaApiError(extractServerErrorMessage(text) ?? "", response.status, "DeepSeek");
    }
    const now = Date.now();
    const parsed = parseDeepSeekBalance(text);
    return {
      snapshot: { ...parsed, fetchedAt: new Date(now).toISOString() },
      error: null,
    };
  } catch (error) {
    if (error instanceof QuotaAuthError || error instanceof QuotaApiError || error instanceof QuotaParseError) {
      return { snapshot: null, error: { code: error.code, message: error.message } };
    }
    logger?.warn?.("[quota-badges] deepseek upstream fetch failed:", error);
    return {
      snapshot: null,
      error: { code: "network-error", message: error?.message ?? String(error) },
    };
  }
}

// ── adapter export ──────────────────────────────────────────────────────────

/** The DeepSeek provider adapter (API-key balance path only, as scoped). */
export const deepseekProvider = {
  id: "deepseek",
  displayName: "DeepSeek",
  usageUrl: BALANCE_URL,

  config(merged) {
    const nested = merged?.providers?.deepseek;
    return {
      apiKey: nested?.apiKey ?? "",
      // DeepSeek's env var is provider-specific; never inherit the opencode
      // top-level apiKeyEnvVar compatibility key.
      apiKeyEnvVar: nested?.apiKeyEnvVar ?? "DEEPSEEK_API_KEY",
      timeoutSec: merged?.timeoutSec ?? 10,
      syncWithModel: merged?.syncWithModel ?? true,
    };
  },

  fetchUsage(ctx) {
    return fetchDeepSeekUsage(ctx);
  },
};