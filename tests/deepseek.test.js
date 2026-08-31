/**
 * DeepSeek provider tests (balance model). Fixtures mirror the documented
 * GET https://api.deepseek.com/user/balance shape: is_available + a
 * balance_infos[] array with per-currency string balances. Unlike the window
 * providers, DeepSeek has no quota windows - the snapshot carries a `balance`
 * block and null windows.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseDeepSeekBalance, deepseekProvider } from "../providers/deepseek.js";
import { QuotaApiError, QuotaParseError } from "../providers/opencode.js";

/** Documented balance payload with a funded USD row and a CNY row. */
function fixturePayload(overrides = {}) {
  const payload = {
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
      { currency: "USD", total_balance: "27.50", granted_balance: "0.00", topped_up_balance: "27.50" },
    ],
  };
  return { ...payload, ...overrides };
}

test("docs fixture: balance block with funded-USD preference", () => {
  const snapshot = parseDeepSeekBalance(JSON.stringify(fixturePayload()));
  assert.ok(snapshot.balance);
  // USD is funded, so it wins even though CNY appears first.
  assert.equal(snapshot.balance.currency, "USD");
  assert.equal(snapshot.balance.total, 27.5);
  assert.equal(snapshot.balance.granted, 0);
  assert.equal(snapshot.balance.toppedUp, 27.5);
  assert.equal(snapshot.balance.isAvailable, true);
  // No windows for a balance-model vendor.
  assert.equal(snapshot.rolling, null);
  assert.equal(snapshot.weekly, null);
  assert.equal(snapshot.monthly, null);
  assert.equal(snapshot.extra.kind, "balance");
});

test("empty USD row does not hide a funded CNY row", () => {
  const snapshot = parseDeepSeekBalance(
    JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency: "USD", total_balance: "0", granted_balance: "0", topped_up_balance: "0" },
        { currency: "CNY", total_balance: "88.00", granted_balance: "0", topped_up_balance: "88.00" },
      ],
    }),
  );
  assert.equal(snapshot.balance.currency, "CNY");
  assert.equal(snapshot.balance.total, 88);
});

test("unfunded rows still select USD last-resort and report isAvailable", () => {
  const snapshot = parseDeepSeekBalance(
    JSON.stringify({
      is_available: false,
      balance_infos: [
        { currency: "USD", total_balance: "0", granted_balance: "0", topped_up_balance: "0" },
      ],
    }),
  );
  assert.equal(snapshot.balance.currency, "USD");
  assert.equal(snapshot.balance.total, 0);
  assert.equal(snapshot.balance.isAvailable, false);
});

test("empty balance_infos -> zeroed USD balance, isAvailable false", () => {
  const snapshot = parseDeepSeekBalance(JSON.stringify({ is_available: false, balance_infos: [] }));
  assert.deepEqual(snapshot.balance, {
    currency: "USD",
    total: 0,
    granted: 0,
    toppedUp: 0,
    isAvailable: false,
  });
});

test("numeric (non-string) balances are tolerated", () => {
  const snapshot = parseDeepSeekBalance(
    JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: 12.5, granted_balance: 0, topped_up_balance: 12.5 }],
    }),
  );
  assert.equal(snapshot.balance.total, 12.5);
});

test("non-numeric balance -> parse-failed", () => {
  assert.throws(
    () => parseDeepSeekBalance(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "abc" }] })),
    (err) => err instanceof QuotaParseError,
  );
});

test("non-JSON body -> parse-failed", () => {
  assert.throws(
    () => parseDeepSeekBalance("<html>not json</html>"),
    (err) => err instanceof QuotaParseError,
  );
});

test("adapter contract: id/displayName/config(merged)", () => {
  assert.equal(deepseekProvider.id, "deepseek");
  assert.equal(deepseekProvider.displayName, "DeepSeek");
  assert.equal(typeof deepseekProvider.fetchUsage, "function");
  const cfg = deepseekProvider.config({ timeoutSec: 7, providers: { deepseek: { apiKey: "dk" } } });
  assert.equal(cfg.apiKey, "dk");
  assert.equal(cfg.timeoutSec, 7);
  assert.equal(cfg.apiKeyEnvVar, "DEEPSEEK_API_KEY");
  const bare = deepseekProvider.config({});
  assert.equal(bare.apiKey, "");
});

test("unconfigured error mentions both env vars, without upstream traffic", async () => {
  const result = await deepseekProvider.fetchUsage({
    config: () => deepseekProvider.config({}),
    resolveApiKey: () => "",
  });
  assert.equal(result.snapshot, null);
  assert.equal(result.error.code, "unconfigured");
  assert.match(result.error.message, /DEEPSEEK_API_KEY|DEEPSEEK_KEY/);
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

test("HTTP 401 maps to invalid-credentials with the DeepSeek label", async () => {
  const result = await withStubbedFetch(
    async () => ({ status: 401, ok: false, text: async () => '{"message":"bad key"}' }),
    () =>
      deepseekProvider.fetchUsage({
        config: () => deepseekProvider.config({ providers: { deepseek: { apiKey: "k" } } }),
        resolveApiKey: (c) => c.apiKey,
      }),
  );
  assert.equal(result.snapshot, null);
  assert.equal(result.error.code, "invalid-credentials");
  assert.match(result.error.message, /^DeepSeek API key/);
});

test("a 200 body parses into a balance snapshot with fetchedAt", async () => {
  const result = await withStubbedFetch(
    async () => ({ status: 200, ok: true, text: async () => JSON.stringify(fixturePayload()) }),
    () =>
      deepseekProvider.fetchUsage({
        config: () => deepseekProvider.config({ providers: { deepseek: { apiKey: "k" } } }),
        resolveApiKey: (c) => c.apiKey,
      }),
  );
  assert.equal(result.error, null);
  assert.ok(result.snapshot.fetchedAt);
  assert.equal(result.snapshot.balance.currency, "USD");
  assert.equal(result.snapshot.rolling, null);
});

test("shared error class labels DeepSeek", () => {
  const api = new QuotaApiError("boom", 500, "DeepSeek");
  assert.equal(api.code, "api-error");
  assert.match(api.message, /^DeepSeek API error \(HTTP 500\)/);
});