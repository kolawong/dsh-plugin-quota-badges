/**
 * dsh-plugin-quota-badges — dependency-free usage-window parser.
 *
 * Ported from ~/CodexBar's Swift implementation
 * (Sources/CodexBarCore/Providers/OpenCodeGo/OpenCodeGoUsageFetcher.swift):
 * the tolerant extraction of rolling (5-hour) / weekly / monthly windows from
 * the https://opencode.ai/zen/go/v1/usage JSON response. This module must stay
 * import-free so both the plugin entry and the node:test suite can load it
 * without any dependency install.
 *
 * All take/return times are epoch milliseconds (`now` parameter) so parsing is
 * deterministic under test; seconds-since-epoch values are converted at the
 * edges by toDateMs.
 */

/** Candidate key names for a direct percent field, tried in order. */
const PERCENT_KEYS = [
  "usagePercent",
  "usedPercent",
  "percentUsed",
  "percent",
  "usage_percent",
  "used_percent",
  "utilization",
  "utilizationPercent",
  "utilization_percent",
  "usage",
];

/** Candidate key names for a relative-reset duration in seconds. */
const RESET_IN_KEYS = [
  "resetInSec",
  "resetInSeconds",
  "resetSeconds",
  "reset_sec",
  "reset_in_sec",
  "resetsInSec",
  "resetsInSeconds",
  "resetIn",
  "resetSec",
];

/** Candidate key names for an absolute reset timestamp. */
const RESET_AT_KEYS = [
  "resetAt",
  "resetsAt",
  "reset_at",
  "resets_at",
  "nextReset",
  "next_reset",
  "renewAt",
  "renew_at",
];

/** Top-level subscription renewal timestamp keys. */
const RENEW_AT_KEYS = ["renewAt", "renew_at"];

const ROLLING_KEYS = ["rollingUsage", "rolling", "rolling_usage", "rollingWindow", "rolling_window"];
const WEEKLY_KEYS = ["weeklyUsage", "weekly", "weekly_usage", "weeklyWindow", "weekly_window"];
const MONTHLY_KEYS = ["monthlyUsage", "monthly", "monthly_usage", "monthlyWindow", "monthly_window"];

/**
 * Read one window object into { percent, resetInSec }, or null when no usable
 * percent can be derived. Direct percent fields strictly inside 0..1 scale to
 * 0..100 (exactly 1 stays "1% used" — the live API sends integer percents);
 * a direct value above 100 is a raw usage count, not a percentage, and is
 * re-derived from the used/limit pair or drops the window. A computed
 * used/limit percent is already 0..100 and never rescales.
 * @param {Record<string, unknown>} dict - one window object from the payload.
 * @param {number} now - epoch ms used to turn absolute reset timestamps into relative seconds.
 * @returns {{ percent: number, resetInSec: number } | null}
 */
export function parseWindow(dict, now) {
  let percent;
  let percentIsDirect = false;
  for (const key of PERCENT_KEYS) {
    const value = doubleValue(dict[key]);
    if (value !== undefined) {
      percent = value;
      percentIsDirect = true;
      break;
    }
  }

  // A direct "percent" above 100 is a raw usage count that landed under a
  // percent-ish key (e.g. `usage: 4250` tokens): clamping it to the ceiling
  // would present a healthy window as "0% remaining". Discard the value and
  // re-derive from the used/limit pair when one exists; drop the window
  // otherwise — an absent bar beats a false empty one.
  if (percentIsDirect && percent > 100) {
    percent = undefined;
    percentIsDirect = false;
  }

  if (percent === undefined) {
    const used = firstNumber(dict, ["used", "usage", "consumed", "count", "usedTokens"]);
    const limit = firstNumber(dict, ["limit", "total", "quota", "max", "cap", "tokenLimit"]);
    if (used !== undefined && limit !== undefined && limit > 0) {
      percent = (used / limit) * 100;
    }
  }

  if (percent === undefined || !Number.isFinite(percent)) return null;
  // Legacy payloads may express a direct percent as a 0..1 fraction, but the
  // live endpoint sends integer percents (observed: percent 4 / 17 / 1), so
  // the scale-up applies only strictly inside 0..1: exactly 1 stays "1% used".
  // Reading it as the fraction 1.0 flipped a 1%-used monthly window into
  // "0% remaining" the moment usage crossed the 1% mark. The computed
  // used/limit path is already 0..100 and never rescales.
  let resolved = percentIsDirect && percent > 0 && percent < 1 ? percent * 100 : percent;
  resolved = Math.max(0, Math.min(100, resolved));

  let resetInSec;
  for (const key of RESET_IN_KEYS) {
    const value = intValue(dict[key]);
    if (value !== undefined) {
      resetInSec = value;
      break;
    }
  }
  if (resetInSec === undefined) {
    for (const key of RESET_AT_KEYS) {
      const atMs = toDateMs(dict[key]);
      if (atMs !== undefined) {
        resetInSec = Math.max(0, Math.round((atMs - now) / 1000));
        break;
      }
    }
  }

  return { percent: resolved, resetInSec: Math.max(0, resetInSec ?? 0) };
}

/**
 * Parse a full usage payload object into the snapshot this plugin serves.
 * Three passes mirror the Swift fetcher: direct rolling/weekly/monthly key
 * lookup, a bounded nested walk matching key-name substrings, then a
 * whole-tree window-candidate scan classified by its key path.
 * @param {unknown} object - the parsed JSON body.
 * @param {number} now - epoch ms.
 * @returns {{ rolling: Window|null, weekly: Window|null, monthly: Window|null, renewsAt: string|null } | null}
 */
export function parseSubscriptionObject(object, now) {
  if (object === null || typeof object !== "object") return null;
  const root = /** @type {Record<string, unknown>} */ (object);
  const renewsAtMs = toDateMs(firstDefined(root, RENEW_AT_KEYS));

  // Pass 1: well-known sibling keys at one level.
  const direct = fromSiblingWindows(root, now, renewsAtMs);
  if (direct) return finish(direct, renewsAtMs);

  // Pass 2: bounded recursive walk classifying sub-objects by key substring.
  const nested = fromNestedWalk(root, now, renewsAtMs, 0);
  if (nested) return finish(nested, renewsAtMs);

  // Pass 3: collect every window-shaped object with its key path, classify,
  // then prefer the shortest-reset candidate for rolling and the longest-reset
  // ones for weekly/monthly (the Swift candidate heuristic).
  const candidates = [];
  collectCandidates(root, [], candidates);
  if (candidates.length > 0) {
    const rollingList = candidates.filter((c) =>
      /rolling|hour|5h|5-hour/.test(c.pathLower));
    const weeklyList = candidates.filter((c) => /weekly|week/.test(c.pathLower));
    const monthlyList = candidates.filter((c) => /monthly|month/.test(c.pathLower));
    const nonRollingIds = new Set([...weeklyList, ...monthlyList].map((c) => c.id));
    const rollingFallback = candidates.filter((c) => !nonRollingIds.has(c.id));
    const rolling = pickCandidate(rollingList, true) ?? pickCandidate(rollingFallback, true);
    const weekly = pickCandidate(
      weeklyList.filter((c) => rolling === undefined || c.id !== rolling.id),
      false,
    );
    const monthly = pickCandidate(
      monthlyList.filter((c) =>
        (rolling === undefined || c.id !== rolling.id)
        && (weekly === undefined || c.id !== weekly.id)),
      false,
    );
    if (rolling !== undefined) {
      return finish({ rolling, weekly: weekly ?? null, monthly: monthly ?? null }, renewsAtMs);
    }
  }

  return null;
}

/** Final snapshot shape: windows plus an ISO renewal stamp when known. */
function finish(windows, renewsAtMs) {
  return {
    rolling: windows.rolling,
    weekly: windows.weekly,
    monthly: windows.monthly,
    ...(renewsAtMs !== undefined ? { renewsAt: new Date(renewsAtMs).toISOString() } : {}),
  };
}

/** Pass 1 body: the documented sibling-key layout. */
function fromSiblingWindows(root, now, renewsAtMs) {
  const rollingDict = firstDict(root, ROLLING_KEYS);
  if (!rollingDict) return null;
  const rolling = parseWindow(rollingDict, now);
  if (!rolling) return null;
  const weeklyDict = firstDict(root, WEEKLY_KEYS);
  const monthlyDict = firstDict(root, MONTHLY_KEYS);
  let weekly = null;
  if (weeklyDict) {
    weekly = parseWindow(weeklyDict, now);
    if (!weekly) return null;
  }
  let monthly = null;
  if (monthlyDict) {
    monthly = parseWindow(monthlyDict, now);
    if (!monthly) return null;
  }
  return { rolling, weekly, monthly };
}

/** Pass 2 body: recursive key-substring classification, depth-capped at 3. */
function fromNestedWalk(dict, now, renewsAtMs, depth) {
  if (depth > 3) return null;
  let rolling;
  let weekly;
  let monthly;
  for (const [key, value] of Object.entries(dict)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const lower = key.toLowerCase();
    const sub = /** @type {Record<string, unknown>} */ (value);
    if (/rolling|hour|5h|5-hour/.test(lower)) rolling = sub;
    else if (/weekly|week/.test(lower)) weekly = sub;
    else if (/monthly|month/.test(lower)) monthly = sub;
  }
  if (rolling) {
    const parsedRolling = parseWindow(rolling, now);
    if (parsedRolling) {
      const parsedWeekly = weekly ? parseWindow(weekly, now) : null;
      const parsedMonthly = monthly ? parseWindow(monthly, now) : null;
      return {
        rolling: parsedRolling,
        weekly: weekly ? parsedWeekly : null,
        monthly: monthly ? parsedMonthly : null,
      };
    }
  }
  for (const value of Object.values(dict)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const found = fromNestedWalk(
        /** @type {Record<string, unknown>} */ (value),
        now,
        renewsAtMs,
        depth + 1,
      );
      if (found) return found;
    }
  }
  return null;
}

let candidateSeq = 0;

/** Recursively gather every parseable window with the key path that reached it. */
function collectCandidates(object, path, out) {
  if (object === null || typeof object !== "object") return;
  if (!Array.isArray(object)) {
    const dict = /** @type {Record<string, unknown>} */ (object);
    const window = parseWindow(dict, Date.now());
    if (window) {
      out.push({ id: ++candidateSeq, ...window, pathLower: path.join(".").toLowerCase() });
    }
    for (const [key, value] of Object.entries(dict)) {
      collectCandidates(value, [...path, key], out);
    }
    return;
  }
  object.forEach((value, index) => collectCandidates(value, [...path, `[${index}]`], out));
}

/** Shortest reset wins when pickShorter (rolling); otherwise the longest. Ties favor the larger percent. */
function pickCandidate(candidates, pickShorter) {
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => {
    if (a.resetInSec !== b.resetInSec) {
      return pickShorter ? a.resetInSec - b.resetInSec : b.resetInSec - a.resetInSec;
    }
    return b.percent - a.percent;
  })[0];
}

/** Parse a JSON usage body; returns null when the body is not a usable JSON object. */
export function parseUsageText(text, now) {
  let object;
  try {
    object = JSON.parse(text);
  } catch {
    return null;
  }
  return parseSubscriptionObject(object, now);
}

// ── scalar coercion helpers ────────────────────────────────────────────────

function doubleValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function intValue(value) {
  const number = doubleValue(value);
  return number === undefined ? undefined : Math.round(number);
}

function firstNumber(dict, keys) {
  for (const key of keys) {
    const value = doubleValue(dict[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstDefined(dict, keys) {
  for (const key of keys) {
    if (dict[key] !== undefined) return dict[key];
  }
  return undefined;
}

function firstDict(dict, keys) {
  for (const key of keys) {
    const value = dict[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return /** @type {Record<string, unknown>} */ (value);
    }
  }
  return null;
}

/**
 * Coerce epoch seconds, epoch milliseconds, numeric strings, or ISO-8601 text
 * into epoch ms (the Swift dateValue heuristic).
 * @returns {number | undefined}
 */
export function toDateMs(value) {
  const number = doubleValue(value);
  if (number !== undefined) {
    if (number > 1_000_000_000_000) return number;
    if (number > 1_000_000_000) return number * 1000;
    return undefined;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value.trim());
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}
