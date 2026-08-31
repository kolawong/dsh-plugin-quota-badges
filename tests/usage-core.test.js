/**
 * Tests for the dependency-free usage-window parser (usage-core.js).
 * Fixtures mirror the payload shapes CodexBar's Swift fetcher accepts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseUsageText, parseSubscriptionObject, parseWindow, toDateMs } from "../usage-core.js";

const NOW = Date.parse("2026-08-25T12:00:00Z");

test("direct sibling windows: rolling + weekly with percents and resetInSec", () => {
  const snapshot = parseSubscriptionObject(
    {
      rollingUsage: { usagePercent: 32.4, resetInSec: 11520 },
      weeklyUsage: { usagePercent: 45, resetInSec: 200000 },
    },
    NOW,
  );
  assert.deepEqual(snapshot, {
    rolling: { percent: 32.4, resetInSec: 11520 },
    weekly: { percent: 45, resetInSec: 200000 },
    monthly: null,
  });
});

test("fraction percents scale to 0..100 only on direct fields", () => {
  const direct = parseWindow({ percent: 0.42, resetInSec: 60 }, NOW);
  assert.equal(direct.percent, 42);
  const computed = parseWindow({ used: 30, limit: 100, resetInSec: 60 }, NOW);
  assert.equal(computed.percent, 30);
});

test("used/limit fallback computes percent without a direct field", () => {
  const window = parseWindow({ usedTokens: 250, tokenLimit: 1000, resetSeconds: 5 }, NOW);
  assert.equal(window.percent, 25);
  assert.equal(window.resetInSec, 5);
});

test("resetAt ISO timestamp becomes relative seconds, floored at zero", () => {
  const future = parseWindow({ usagePercent: 10, reset_at: "2026-08-25T13:00:00Z" }, NOW);
  assert.equal(future.resetInSec, 3600);
  const past = parseWindow({ usagePercent: 10, resetAt: NOW - 5000 }, NOW);
  assert.equal(past.resetInSec, 0);
});

test("nested data.usage walk finds rolling by key substring", () => {
  const snapshot = parseSubscriptionObject(
    {
      data: {
        usage: {
          fiveHourWindow: { usagePercent: 66, resetInSec: 900 },
          week: { usagePercent: 12, reset_in_sec: 345600 },
        },
      },
    },
    NOW,
  );
  assert.ok(snapshot, "nested walk should find the rolling window");
  assert.equal(snapshot.rolling.percent, 66);
  assert.equal(snapshot.weekly.percent, 12);
});

test("candidate scan classifies by key path when names are exotic", () => {
  const snapshot = parseSubscriptionObject(
    {
      billing: {
        sessionRateLimits: { utilization: 0.8, resets_in_sec: 1200 },
        planWeeklyCap: { utilization: 20, resets_in_sec: 400000 },
      },
    },
    NOW,
  );
  assert.ok(snapshot, "candidate scan should find windows");
  // Rolling prefers the shortest reset among candidates.
  assert.equal(snapshot.rolling.percent, 80);
  assert.equal(snapshot.weekly.percent, 20);
});

test("top-level renewAt lands on the snapshot as ISO", () => {
  const snapshot = parseSubscriptionObject(
    { renewAt: "2026-09-01T00:00:00Z", rolling: { usagePercent: 5, resetInSec: 60 } },
    NOW,
  );
  assert.equal(snapshot.renewsAt, "2026-09-01T00:00:00.000Z");
});

test("unparseable weekly falls back to a rolling-only snapshot (candidate scan)", () => {
  const snapshot = parseSubscriptionObject(
    { rollingUsage: { usagePercent: 5, resetInSec: 60 }, weeklyUsage: { nonsense: true } },
    NOW,
  );
  // Pass 1 declines the pair, then the candidate scan still rescues rolling
  // alone — the same outcome CodexBar's fetcher produces for this shape.
  assert.ok(snapshot);
  assert.deepEqual(snapshot.rolling, { percent: 5, resetInSec: 60 });
  assert.equal(snapshot.weekly, null);
});

test("non-JSON text returns null instead of throwing", () => {
  assert.equal(parseUsageText("<html>404</html>", NOW), null);
});

test("toDateMs distinguishes epoch seconds from milliseconds", () => {
  assert.equal(toDateMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toDateMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toDateMs("2026-08-25T12:00:00Z"), NOW);
});
