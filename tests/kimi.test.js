/**
 * Kimi Code provider tests. Fixtures mirror the real /coding/v1/usages JSON
 * documented by CodexBar (docs/kimi.md): string counters, a top-level weekly
 * `usage` detail, and an optional `limits[0]` 5-hour rate lane (window
 * duration 300 TIME_UNIT_MINUTE).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseKimiUsage, usagesURL, kimiProvider } from "../providers/kimi.js";
import { QuotaAuthError, QuotaApiError, QuotaParseError } from "../providers/opencode.js";

const NOW = Date.parse("2026-08-27T12:00:00Z");

/** The documented Code API payload. */
function fixturePayload(overrides = {}) {
  const payload = {
    usage: {
      limit: "2048",
      used: "214",
      remaining: "1834",
      resetTime: "2026-08-28T15:23:13.716839300Z",
    },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: {
          limit: "200",
          used: "139",
          remaining: "61",
          resetTime: "2026-08-27T13:33:02.717479433Z",
        },
      },
    ],
  };
  return { ...payload, ...overrides };
}

test("docs fixture: weekly pool + 5h rate lane percents and reset countdowns", () => {
  const snapshot = parseKimiUsage(JSON.stringify(fixturePayload()), NOW);
  // Weekly: 214/2048 = 10.449...%
  assert.ok(snapshot.weekly);
  assert.ok(Math.abs(snapshot.weekly.percent - 10.45) < 0.01);
  // Rolling rate lane: 139/200 = 69.5%
  assert.ok(snapshot.rolling);
  assert.ok(Math.abs(snapshot.rolling.percent - 69.5) < 0.01);
  // Reset countdowns relative to NOW, floored at zero.
  assert.equal(snapshot.rolling.resetInSec, Math.round((Date.parse("2026-08-27T13:33:02.717Z") - NOW) / 1000));
  assert.equal(snapshot.weekly.resetInSec, Math.round((Date.parse("2026-08-28T15:23:13.716Z") - NOW) / 1000));
  assert.equal(snapshot.monthly, null);
  assert.equal(snapshot.extra.windowMinutes, 300);
  assert.deepEqual(snapshot.extra.weekly, { used: 214, limit: 2048 });
  assert.deepEqual(snapshot.extra.rolling, { used: 139, limit: 200 });
});

test("numeric counters are tolerated alongside strings", () => {
  const payload = fixturePayload({
    usage: { limit: 1000, used: 250, resetTime: "2026-08-28T15:23:13Z" },
  });
  const snapshot = parseKimiUsage(JSON.stringify(payload), NOW);
  assert.equal(snapshot.weekly.percent, 25);
});

test("used is authoritative and may exceed the limit (overage clamps at 100)", () => {
  const payload = fixturePayload({
    usage: { limit: "200", used: "250", remaining: "0", resetTime: "2026-08-28T15:23:13Z" },
  });
  const snapshot = parseKimiUsage(JSON.stringify(payload), NOW);
  assert.equal(snapshot.weekly.percent, 100);
});

test("missing used derives from remaining (limit - remaining)", () => {
  const payload = fixturePayload({
    usage: { limit: "2048", remaining: "1834", resetTime: "2026-08-28T15:23:13Z" },
  });
  const snapshot = parseKimiUsage(JSON.stringify(payload), NOW);
  // (2048 - 1834) / 2048 = 10.45%
  assert.ok(Math.abs(snapshot.weekly.percent - 10.45) < 0.01);
});

test("no usable counters -> no window; unusable weekly detail -> parse-failed", () => {
  // Rate lane without counters is simply omitted.
  const payload = fixturePayload({
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "200" } }],
  });
  const snapshot = parseKimiUsage(JSON.stringify(payload), NOW);
  assert.equal(snapshot.rolling, null);
  assert.ok(snapshot.weekly);

  // A weekly detail that cannot produce counts fails the whole parse.
  assert.throws(
    () => parseKimiUsage(JSON.stringify({ usage: { limit: "0" } }), NOW),
    (err) => err instanceof QuotaParseError,
  );
});

test("limits array may be absent (weekly-only snapshot)", () => {
  const payload = fixturePayload();
  delete payload.limits;
  const snapshot = parseKimiUsage(JSON.stringify(payload), NOW);
  assert.equal(snapshot.rolling, null);
  assert.ok(snapshot.weekly);
  assert.equal(snapshot.extra.windowMinutes, 300);
  assert.equal(snapshot.extra.rolling, undefined);
});

test("past resetTime floors the countdown at zero", () => {
  const payload = fixturePayload({
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "200", used: "10", resetTime: "2026-08-27T11:00:00Z" },
      },
    ],
  });
  const snapshot = parseKimiUsage(JSON.stringify(payload), NOW);
  assert.equal(snapshot.rolling.resetInSec, 0);
});

test("non-JSON body -> parse-failed", () => {
  assert.throws(
    () => parseKimiUsage("<html>not json</html>", NOW),
    (err) => err instanceof QuotaParseError,
  );
});

test("reset-time key aliases are accepted (reset_at / reset_time)", () => {
  const payload = fixturePayload({
    usage: { limit: "100", used: "10", reset_time: "2026-08-28T15:23:13Z" },
    limits: [
      {
        window: { duration: 1, timeUnit: "TIME_UNIT_HOUR" },
        detail: { limit: "100", used: "50", reset_at: "2026-08-27T13:00:00Z" },
      },
    ],
  });
  const snapshot = parseKimiUsage(JSON.stringify(payload), NOW);
  assert.equal(snapshot.weekly.resetInSec, Math.round((Date.parse("2026-08-28T15:23:13Z") - NOW) / 1000));
  assert.equal(snapshot.rolling.resetInSec, 3600);
  assert.equal(snapshot.extra.windowMinutes, 60);
});

test("usagesURL mirrors CodexBar endpoint normalization", () => {
  assert.equal(usagesURL(), "https://api.kimi.com/coding/v1/usages");
  assert.equal(usagesURL("https://proxy.example.com"), "https://proxy.example.com/coding/v1/usages");
  assert.equal(usagesURL("https://proxy.example.com/coding"), "https://proxy.example.com/coding/v1/usages");
  assert.equal(usagesURL("https://proxy.example.com/coding/v1"), "https://proxy.example.com/coding/v1/usages");
  assert.equal(usagesURL("https://proxy.example.com/coding/v1/"), "https://proxy.example.com/coding/v1/usages");
  assert.equal(usagesURL(""), "https://api.kimi.com/coding/v1/usages");
});

test("adapter contract: id/displayName/config(merged)", () => {
  assert.equal(kimiProvider.id, "kimi");
  assert.equal(kimiProvider.displayName, "Kimi Code");
  assert.equal(typeof kimiProvider.fetchUsage, "function");
  const cfg = kimiProvider.config({
    timeoutSec: 7,
    providers: { kimi: { apiKey: "kk", baseURL: "https://proxy.example.com/coding/v1" } },
  });
  assert.equal(cfg.apiKey, "kk");
  assert.equal(cfg.baseURL, "https://proxy.example.com/coding/v1");
  assert.equal(cfg.timeoutSec, 7);
  assert.equal(cfg.apiKeyEnvVar, "KIMI_CODE_API_KEY");
  // Defaults without any nested block.
  const bare = kimiProvider.config({ timeoutSec: 10 });
  assert.equal(bare.apiKey, "");
  assert.equal(bare.baseURL, "https://api.kimi.com");
});

test("unconfigured error mentions the env var, without upstream traffic", async () => {
  const result = await kimiProvider.fetchUsage({
    config: () => kimiProvider.config({}),
    resolveApiKey: () => "",
  });
  assert.equal(result.snapshot, null);
  assert.equal(result.error.code, "unconfigured");
  assert.match(result.error.message, /KIMI_CODE_API_KEY/);
});

/** Stub the global fetch that upstreamFetch ultimately calls. */
async function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("HTTP 401 maps to invalid-credentials with the Kimi label", async () => {
  const result = await withStubbedFetch(
    async () => ({ status: 401, ok: false, text: async () => '{"message":"bad key"}' }),
    () =>
      kimiProvider.fetchUsage({
        config: () => kimiProvider.config({ providers: { kimi: { apiKey: "k" } } }),
        resolveApiKey: (c) => c.apiKey,
      }),
  );
  assert.equal(result.snapshot, null);
  assert.equal(result.error.code, "invalid-credentials");
  assert.match(result.error.message, /^Kimi Code API key/);
});

test("HTTP 403 stays an api-error carrying the permission message", async () => {
  const result = await withStubbedFetch(
    async () => ({ status: 403, ok: false, text: async () => "" }),
    () =>
      kimiProvider.fetchUsage({
        config: () => kimiProvider.config({ providers: { kimi: { apiKey: "k" } } }),
        resolveApiKey: (c) => c.apiKey,
      }),
  );
  assert.equal(result.snapshot, null);
  assert.equal(result.error.code, "api-error");
  assert.match(result.error.message, /HTTP 403.*permission or quota denied/);
});

test("a 200 body parses into a snapshot with fetchedAt", async () => {
  const result = await withStubbedFetch(
    async () => ({ status: 200, ok: true, text: async () => JSON.stringify(fixturePayload()) }),
    () =>
      kimiProvider.fetchUsage({
        config: () => kimiProvider.config({ providers: { kimi: { apiKey: "k" } } }),
        resolveApiKey: (c) => c.apiKey,
      }),
  );
  assert.equal(result.error, null);
  assert.ok(result.snapshot.fetchedAt);
  assert.ok(result.snapshot.rolling);
  assert.ok(result.snapshot.weekly);
  assert.ok(Math.abs(result.snapshot.rolling.percent - 69.5) < 0.01);
});

test("shared error classes label the vendor that threw", () => {
  const auth = new QuotaAuthError("Kimi Code");
  assert.equal(auth.code, "invalid-credentials");
  assert.match(auth.message, /^Kimi Code API key/);
  const api = new QuotaApiError("permission or quota denied", 403, "Kimi Code");
  assert.equal(api.code, "api-error");
  assert.match(api.message, /^Kimi Code API error \(HTTP 403\)/);
  // No-arg call sites keep the OpenCode wording.
  assert.match(new QuotaAuthError().message, /^OpenCode API key/);
});
