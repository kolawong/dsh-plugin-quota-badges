/**
 * ClinePass provider tests (API-key path).
 *
 * Fixtures mirror the payload CodexBar's clinepass.ts script validates
 * (Sources/CodexBarCore/Resources/Plugins/clinepass.ts): a success boolean, a
 * data object, and data.limits[] entries carrying a `type`
 * (five_hour / weekly / monthly), a numeric `percentUsed`, and an optional
 * ISO `resetsAt`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseClinePassUsage,
  clinepassProvider,
  ALTERNATE_ENV_VAR,
} from "../providers/clinepass.js";
import { QuotaAuthError, QuotaApiError, QuotaParseError } from "../providers/opencode.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");

/** The documented CodexBar-shaped usage-limits payload. */
function fixturePayload(overrides = {}) {
  const payload = {
    success: true,
    data: {
      limits: [
        { type: "five_hour", percentUsed: 42.5, resetsAt: "2026-09-29T15:30:00Z" },
        { type: "weekly", percentUsed: 12, resetsAt: "2026-10-04T00:00:00Z" },
        { type: "monthly", percentUsed: 61, resetsAt: null },
      ],
    },
  };
  return { ...payload, ...overrides };
}

test("docs fixture: five_hour/weekly/monthly map to rolling/weekly/monthly", () => {
  const snapshot = parseClinePassUsage(JSON.stringify(fixturePayload()), NOW);
  assert.equal(snapshot.rolling.percent, 42.5);
  assert.equal(snapshot.weekly.percent, 12);
  assert.equal(snapshot.monthly.percent, 61);
  // Reset countdowns relative to NOW.
  assert.equal(
    snapshot.rolling.resetInSec,
    Math.round((Date.parse("2026-09-29T15:30:00Z") - NOW) / 1000),
  );
  assert.equal(
    snapshot.weekly.resetInSec,
    Math.round((Date.parse("2026-10-04T00:00:00Z") - NOW) / 1000),
  );
  // A null resetsAt is a known window with no countdown, not a missing window.
  assert.equal(snapshot.monthly.resetInSec, 0);
  // Diagnostics keep the unclamped report plus CodexBar's window lengths.
  assert.deepEqual(snapshot.extra.reportedPercent, { rolling: 42.5, weekly: 12, monthly: 61 });
  assert.deepEqual(snapshot.extra.windowMinutes, {
    five_hour: 300,
    weekly: 10080,
    monthly: 43200,
  });
  assert.equal(snapshot.extra.resetsAt.rolling, "2026-09-29T15:30:00Z");
});

test("percentUsed is clamped into 0..100 (overage caps at 100)", () => {
  const payload = fixturePayload({
    data: {
      limits: [
        { type: "five_hour", percentUsed: 150, resetsAt: null },
        { type: "weekly", percentUsed: -8, resetsAt: null },
      ],
    },
  });
  const snapshot = parseClinePassUsage(JSON.stringify(payload), NOW);
  assert.equal(snapshot.rolling.percent, 100);
  assert.equal(snapshot.weekly.percent, 0);
  // The unclamped source value stays available for diagnostics.
  assert.equal(snapshot.extra.reportedPercent.rolling, 150);
  assert.equal(snapshot.monthly, null);
});

test("unmapped limit types are skipped, not fatal", () => {
  const payload = fixturePayload({
    data: {
      limits: [
        { type: "daily", percentUsed: 5, resetsAt: null },
        { type: "weekly", percentUsed: 20, resetsAt: null },
      ],
    },
  });
  const snapshot = parseClinePassUsage(JSON.stringify(payload), NOW);
  assert.equal(snapshot.rolling, null);
  assert.equal(snapshot.weekly.percent, 20);
  assert.equal(snapshot.monthly, null);
});

test("a response with no usable window is rejected", () => {
  const payload = fixturePayload({ data: { limits: [{ type: "daily", percentUsed: 5 }] } });
  assert.throws(
    () => parseClinePassUsage(JSON.stringify(payload), NOW),
    (err) => err instanceof QuotaParseError && /no usable quota window/.test(err.message),
  );
  assert.throws(
    () => parseClinePassUsage(JSON.stringify(fixturePayload({ data: { limits: [] } })), NOW),
    (err) => err instanceof QuotaParseError,
  );
});

test("payload validation order: success, data, limits", () => {
  assert.throws(
    () => parseClinePassUsage(JSON.stringify({ success: false, data: { limits: [] } }), NOW),
    (err) => err instanceof QuotaParseError && /success: false/.test(err.message),
  );
  assert.throws(
    () => parseClinePassUsage(JSON.stringify({ data: { limits: [] } }), NOW),
    (err) => err instanceof QuotaParseError && /no boolean success/.test(err.message),
  );
  assert.throws(
    () => parseClinePassUsage(JSON.stringify({ success: true }), NOW),
    (err) => err instanceof QuotaParseError && /no data object/.test(err.message),
  );
  assert.throws(
    () => parseClinePassUsage(JSON.stringify({ success: true, data: {} }), NOW),
    (err) => err instanceof QuotaParseError && /no limits array/.test(err.message),
  );
  assert.throws(
    () => parseClinePassUsage(JSON.stringify([{ success: true }]), NOW),
    (err) => err instanceof QuotaParseError && /not an object/.test(err.message),
  );
});

test("malformed limits fail the parse with the offending field named", () => {
  const cases = [
    {
      limit: "not-an-object",
      re: /non-object limit/,
    },
    {
      limit: { percentUsed: 10 },
      re: /type is not a string/,
    },
    {
      limit: { type: "weekly", percentUsed: "20" },
      re: /no numeric percentUsed/,
    },
    {
      limit: { type: "weekly", percentUsed: Number.NaN },
      re: /no numeric percentUsed/,
    },
    {
      limit: { type: "weekly", percentUsed: 10, resetsAt: "not-a-date" },
      re: /invalid resetsAt timestamp/,
    },
    {
      limit: { type: "weekly", percentUsed: 10, resetsAt: 1759000000 },
      re: /invalid resetsAt timestamp/,
    },
  ];
  for (const { limit, re } of cases) {
    assert.throws(
      () => parseClinePassUsage(JSON.stringify({ success: true, data: { limits: [limit] } }), NOW),
      (err) => err instanceof QuotaParseError && re.test(err.message),
      `expected ${JSON.stringify(limit)} to be rejected`,
    );
  }
});

test("non-JSON body -> parse-failed", () => {
  assert.throws(
    () => parseClinePassUsage("<html>not json</html>", NOW),
    (err) => err instanceof QuotaParseError,
  );
});

test("past resetsAt floors the countdown at zero", () => {
  const payload = fixturePayload({
    data: { limits: [{ type: "five_hour", percentUsed: 10, resetsAt: "2026-09-29T09:00:00Z" }] },
  });
  const snapshot = parseClinePassUsage(JSON.stringify(payload), NOW);
  assert.equal(snapshot.rolling.resetInSec, 0);
});

test("adapter contract: id/displayName/config(merged)", () => {
  assert.equal(clinepassProvider.id, "cline");
  assert.equal(clinepassProvider.displayName, "ClinePass");
  assert.equal(typeof clinepassProvider.fetchUsage, "function");
  assert.equal(ALTERNATE_ENV_VAR, "CLINEPASS_API_KEY");

  const cfg = clinepassProvider.config({
    timeoutSec: 7,
    providers: { cline: { apiKey: "ck" } },
  });
  assert.equal(cfg.apiKey, "ck");
  assert.equal(cfg.apiKeyEnvVar, "CLINE_API_KEY");
  assert.equal(cfg.timeoutSec, 7);

  // Defaults without any nested block; never inherits the opencode flat key.
  const bare = clinepassProvider.config({ apiKey: "flat-opencode-key", timeoutSec: 10 });
  assert.equal(bare.apiKey, "");
  assert.equal(bare.apiKeyEnvVar, "CLINE_API_KEY");
});

test("unconfigured error mentions both env vars, without upstream traffic", async () => {
  const result = await clinepassProvider.fetchUsage({
    config: () => clinepassProvider.config({}),
    resolveApiKey: () => "",
  });
  assert.equal(result.snapshot, null);
  assert.equal(result.error.code, "unconfigured");
  assert.match(result.error.message, /CLINE_API_KEY \/ CLINEPASS_API_KEY/);
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

/** Call the adapter with a configured key, returning {result, calls}. */
async function fetchWithResponse(response, config = {}) {
  const calls = [];
  const result = await withStubbedFetch(
    async (url, options) => {
      calls.push({ url, options });
      return response;
    },
    () =>
      clinepassProvider.fetchUsage({
        config: () => clinepassProvider.config({ providers: { cline: { apiKey: "k" } }, ...config }),
        resolveApiKey: (c) => c.apiKey,
        logger: { warn: () => {} },
      }),
  );
  return { result, calls };
}

test("HTTP 401 maps to invalid-credentials with the ClinePass label", async () => {
  const { result, calls } = await fetchWithResponse({
    status: 401,
    ok: false,
    text: async () => '{"message":"bad key"}',
  });
  assert.equal(result.snapshot, null);
  assert.equal(result.error.code, "invalid-credentials");
  assert.match(result.error.message, /^ClinePass API key/);
  assert.equal(calls[0].url, "https://api.cline.bot/api/v1/users/me/plan/usage-limits");
  assert.equal(calls[0].options.headers.Authorization, "Bearer k");
});

test("HTTP 403 is also invalid-credentials (CodexBar clinepass.ts)", async () => {
  const { result } = await fetchWithResponse({ status: 403, ok: false, text: async () => "" });
  assert.equal(result.error.code, "invalid-credentials");
  assert.match(result.error.message, /^ClinePass API key/);
});

test("HTTP 429 stays an api-error carrying the rate-limit wording", async () => {
  const { result } = await fetchWithResponse({ status: 429, ok: false, text: async () => "" });
  assert.equal(result.snapshot, null);
  assert.equal(result.error.code, "api-error");
  assert.match(result.error.message, /HTTP 429.*rate limited/);
});

test("HTTP 5xx reports provider unavailable; other codes carry the server message", async () => {
  const serverDown = await fetchWithResponse({ status: 503, ok: false, text: async () => "" });
  assert.equal(serverDown.result.error.code, "api-error");
  assert.match(serverDown.result.error.message, /HTTP 503.*provider unavailable/);

  const badRequest = await fetchWithResponse({
    status: 400,
    ok: false,
    text: async () => '{"message":"plan not found"}',
  });
  assert.equal(badRequest.result.error.code, "api-error");
  assert.match(badRequest.result.error.message, /plan not found/);
});

test("a 200 body parses into a snapshot with fetchedAt", async () => {
  const { result } = await fetchWithResponse({
    status: 200,
    ok: true,
    text: async () => JSON.stringify(fixturePayload()),
  });
  assert.equal(result.error, null);
  assert.ok(result.snapshot.fetchedAt);
  assert.equal(result.snapshot.rolling.percent, 42.5);
  assert.equal(result.snapshot.monthly.percent, 61);
});

test("a rejected fetch (network/TLS) becomes network-error", async () => {
  const result = await withStubbedFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    () =>
      clinepassProvider.fetchUsage({
        config: () => clinepassProvider.config({ providers: { cline: { apiKey: "k" } } }),
        resolveApiKey: (c) => c.apiKey,
        logger: { warn: () => {} },
      }),
  );
  assert.equal(result.snapshot, null);
  assert.equal(result.error.code, "network-error");
  assert.match(result.error.message, /ECONNREFUSED/);
});

test("CLINEPASS_API_KEY alias is used only when the primary env var is in force", async () => {
  const previous = process.env[ALTERNATE_ENV_VAR];
  process.env[ALTERNATE_ENV_VAR] = "alias-key";
  try {
    const calls = [];
    const stub = async (url, options) => {
      calls.push({ url, options });
      return { status: 200, ok: true, text: async () => JSON.stringify(fixturePayload()) };
    };
    // Default env-var name -> the alias supplies the key.
    const aliased = await withStubbedFetch(stub, () =>
      clinepassProvider.fetchUsage({
        config: () => clinepassProvider.config({}),
        // Mimic index.js resolveApiKey: explicit config key, then process.env.
        resolveApiKey: (c) => (c.apiKey ?? "").trim() || (process.env[c.apiKeyEnvVar] ?? "").trim(),
      }),
    );
    assert.equal(aliased.error, null);
    assert.equal(calls[0].options.headers.Authorization, "Bearer alias-key");

    // A custom env-var name opts out of the alias (CodexBar behavior).
    const custom = await withStubbedFetch(stub, () =>
      clinepassProvider.fetchUsage({
        config: () => clinepassProvider.config({ providers: { cline: { apiKeyEnvVar: "MY_CLINE_KEY" } } }),
        resolveApiKey: (c) => (c.apiKey ?? "").trim() || (process.env[c.apiKeyEnvVar] ?? "").trim(),
      }),
    );
    assert.equal(custom.snapshot, null);
    assert.equal(custom.error.code, "unconfigured");
  } finally {
    if (previous === undefined) delete process.env[ALTERNATE_ENV_VAR];
    else process.env[ALTERNATE_ENV_VAR] = previous;
  }
});

test("shared error classes label the vendor that threw", () => {
  const auth = new QuotaAuthError("ClinePass");
  assert.equal(auth.code, "invalid-credentials");
  assert.match(auth.message, /^ClinePass API key/);
  const api = new QuotaApiError("rate limited", 429, "ClinePass");
  assert.equal(api.code, "api-error");
  assert.match(api.message, /^ClinePass API error \(HTTP 429\)/);
  // A brand-new variable also proves the label is per-call, not a constant.
  assert.match(new QuotaApiError("provider unavailable", 503, "ClinePass").message, /^ClinePass API error/);
});
