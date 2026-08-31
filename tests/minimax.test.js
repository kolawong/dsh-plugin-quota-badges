/**
 * MiniMax provider parser tests. Fixtures mirror the real coding-plan
 * remains JSON structure (see CodexBar MiniMaxUsageFetcher.swift): a payload
 * envelope with baseResp, data.modelRemains[] lanes carrying interval + weekly
 * quota, and data.pointsBalance. current_interval_usage_count is REMAINING
 * quota; current_interval_remaining_percent is a remaining fraction of 100.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseMiniMaxUsage, remainsURL, minimaxProvider } from "../providers/minimax.js";
import { QuotaAuthError, QuotaApiError, QuotaParseError } from "../providers/opencode.js";

const NOW = Date.parse("2026-08-27T08:00:00Z");

/** Typical CN payload: a single text lane with interval + weekly windows. */
function fixturePayload(overrides = {}) {
  const payload = {
    base_resp: { status_code: 0, status_message: "success" },
    data: {
      base_resp: { status_code: 0, status_message: "success" },
      current_subscribe_title: "Coding Plan Plus",
      points_balance: 188.5,
      model_remains: [
        {
          model_name: "minimax-m2",
          current_interval_total_count: 200,
          current_interval_usage_count: 60, // remaining
          current_interval_remaining_percent: 30,
          current_interval_status: 0,
          start_time: 1724664000,
          end_time: 1724684400,
          remains_time: 3600,
          interval_boost_permill: 1000,
          current_weekly_total_count: 1000,
          current_weekly_usage_count: 250, // remaining
          current_weekly_remaining_percent: 25,
          current_weekly_status: 0,
          weekly_start_time: 1724486400,
          weekly_end_time: 1725091200,
          weekly_remains_time: 600000,
        },
      ],
    },
  };
  return deepMerge(payload, overrides);
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object") {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

test("remainsURL selects the CN api base by default and global on request", () => {
  assert.equal(remainsURL("cn"), "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");
  assert.equal(remainsURL("global"), "https://api.minimax.io/v1/api/openplatform/coding_plan/remains");
  assert.equal(remainsURL("unknown-region"), remainsURL("cn"));
});

test("parses interval + weekly from a text lane (remaining-percent path)", () => {
  const snapshot = parseMiniMaxUsage(JSON.stringify(fixturePayload()), NOW);
  assert.equal(snapshot.rolling.percent, 70); // 100 - 30 remaining
  assert.ok(snapshot.rolling.resetInSec > 0);
  // Weekly: 100 - 25 = 75 used, reset in > 0.
  assert.ok(snapshot.weekly);
  assert.equal(snapshot.weekly.percent, 75);
  assert.equal(snapshot.monthly, null);
  assert.equal(snapshot.extra.planName, "Coding Plan Plus");
  assert.equal(snapshot.extra.pointsBalance, 188.5);
  assert.equal(snapshot.extra.services.length, 1);
  assert.equal(snapshot.extra.services[0].displayName, "text-generation");
});

test("counts-only lane (no remainingPercent) derives used/limit percent", () => {
  const payload = fixturePayload();
  payload.data.model_remains[0].current_interval_remaining_percent = undefined;
  payload.data.model_remains[0].current_interval_usage_count = 60; // remaining 60/200
  const snapshot = parseMiniMaxUsage(JSON.stringify(payload), NOW);
  assert.equal(snapshot.rolling.percent, 70); // (200-60)/200
});

test("unavailable placeholder lane (status 3, zero counts, full remaining) is skipped", () => {
  const payload = fixturePayload();
  payload.data.model_remains = [
    payload.data.model_remains[0],
    {
      model_name: "video",
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      current_interval_remaining_percent: 100,
      current_interval_status: 3,
    },
  ];
  const snapshot = parseMiniMaxUsage(JSON.stringify(payload), NOW);
  // video placeholder must not produce a lane; text lane stays primary.
  assert.equal(snapshot.extra.services.length, 1);
  assert.equal(snapshot.extra.services[0].model, "minimax-m2");
});

test("statusCode !== 0 with login/cookie message → invalid-credentials", () => {
  const payload = fixturePayload({
    data: { base_resp: { status_code: 1004, status_message: "Please log in" } },
  });
  assert.throws(
    () => parseMiniMaxUsage(JSON.stringify(payload), NOW),
    (err) => err instanceof QuotaAuthError,
  );
});

test("statusCode !== 0 generic → api-error", () => {
  const payload = fixturePayload({
    data: { base_resp: { status_code: 500, status_message: "server exploded" } },
  });
  assert.throws(
    () => parseMiniMaxUsage(JSON.stringify(payload), NOW),
    (err) => err instanceof QuotaApiError && err.code === "api-error",
  );
});

test("non-JSON body → parse-failed", () => {
  assert.throws(
    () => parseMiniMaxUsage("<html>not json</html>", NOW),
    (err) => err instanceof QuotaParseError,
  );
});

test("missing modelRemains → parse-failed", () => {
  const payload = fixturePayload({ data: { model_remains: [] } });
  assert.throws(
    () => parseMiniMaxUsage(JSON.stringify(payload), NOW),
    (err) => err instanceof QuotaParseError,
  );
});

test("weekly window only for text lanes (video has no weekly lane)", () => {
  const payload = fixturePayload();
  payload.data.model_remains[0].model_name = "video";
  payload.data.model_remains[0].current_interval_total_count = 10;
  payload.data.model_remains[0].current_interval_usage_count = 5;
  payload.data.model_remains[0].current_interval_remaining_percent = 50;
  const snapshot = parseMiniMaxUsage(JSON.stringify(payload), NOW);
  assert.ok(snapshot.rolling);
  assert.equal(snapshot.weekly, null);
});

test("adapter contract: id/displayName/config(merged)", () => {
  assert.equal(minimaxProvider.id, "minimax");
  assert.equal(minimaxProvider.displayName, "MiniMax");
  assert.equal(typeof minimaxProvider.fetchUsage, "function");
  const cfg = minimaxProvider.config({
    timeoutSec: 7,
    providers: { minimax: { apiKey: "mm", region: "global" } },
  });
  assert.equal(cfg.apiKey, "mm");
  assert.equal(cfg.region, "global");
  assert.equal(cfg.timeoutSec, 7);
  assert.equal(cfg.apiKeyEnvVar, "MINIMAX_CN_API_KEY");
});