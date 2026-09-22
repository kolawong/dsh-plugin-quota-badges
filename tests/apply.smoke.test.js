/**
 * Apply-level smoke tests for the multi-provider assembly (index.js).
 *
 * These do not boot Cordis: they hand apply() a minimal mock context and
 * assert the assembly wires up without throwing — provider registry, per-
 * provider state, route registration, settings registration, and the
 * provider-context hand-off. They catch shape errors (wrong ctx keys, broken
 * effect binding, adapter contract drift) that unit tests of the leaf modules
 * cannot see.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { apply, Config, name, inject } from "../index.js";
import { opencodeProvider } from "../providers/opencode.js";

/** Minimal mock ctx exercising the exact surface apply() touches. */
function makeMockCtx() {
  const routes = [];
  const registered = [];
  const effects = [];
  const settingsSections = {};
  let refreshCalls = 0;

  const ctx = {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    effect(fn, label) {
      // Run setup immediately, capture disposer.
      const disposer = fn();
      effects.push({ label, disposer });
      return disposer;
    },
    inject(names, callback) {
      callback({
        settings: {
          register(ns, schema, options) {
            registered.push({ ns, hasSchema: typeof schema === "function", base: options?.base });
            const section = settingsSections[ns] ?? {};
            return {
              get: () => ({ ...(options?.base ?? {}), ...section }),
              watch: (cb) => {
                ctx._watch = cb;
                return () => {};
              },
              update: async (patch) => Object.assign(section, patch),
              replace: async (next) => {
                for (const key of Object.keys(section)) delete section[key];
                Object.assign(section, next);
              },
            };
          },
          get: () => undefined,
          update: async () => {},
          describe: () => [],
        },
        llm: {
          listProviders: () => [{ id: "opencode-go" }],
          listModels: async () => [{ id: "deepseek-v4-flash" }],
        },
      });
    },
    webServer: {
      register(spec) {
        routes.push(spec);
        return () => {};
      },
    },
  };

  return {
    ctx,
    get routes() {
      return routes;
    },
    get registered() {
      return registered;
    },
    get effects() {
      return effects;
    },
  };
}

test("module surface: name, inject, Config, apply", () => {
  assert.equal(name, "quota-badges");
  assert.deepEqual(inject, ["webServer", "settings"]);
  assert.equal(typeof apply, "function");
  assert.equal(typeof Config, "function");
  const parsed = Config({});
  assert.ok(parsed.providers !== undefined);
  assert.equal(parsed.modelsVision, undefined, "model-sync config moved to dsh-plugin-toolkit");
});

test("apply registers the settings namespace quota-badges", () => {
  const mock = makeMockCtx();
  apply(mock.ctx, { intervalSec: 60, timeoutSec: 10 });
  const quota = mock.registered.find((r) => r.ns === "quota-badges");
  assert.ok(quota, "quota-badges namespace registered");
  assert.equal(quota.hasSchema, true);
  assert.equal(quota.base.apiKey, "");
});

test("apply mounts the two quota routes", () => {
  const mock = makeMockCtx();
  apply(mock.ctx, {
    statusPath: "/api/quota-badges/status",
    refreshPath: "/api/quota-badges/refresh",
  });
  const paths = mock.routes.map((r) => r.path);
  assert.ok(paths.includes("/api/quota-badges/status"));
  assert.ok(paths.includes("/api/quota-badges/refresh"));
  assert.equal(paths.length, 2, "the model-sync route moved to dsh-plugin-toolkit");
  // Both are exact-kind (no prefix ambiguity).
  assert.ok(mock.routes.every((r) => r.kind === "exact"));
});

test("apply installs the opencode provider (startup behavior)", () => {
  const mock = makeMockCtx();
  apply(mock.ctx, {});
  const poller = mock.effects.find((e) => e.label.includes("poller"));
  assert.ok(poller, "poller effect registered");
  assert.equal(typeof poller.disposer, "function");
});

test("opencode adapter contract: id, displayName, config, fetchUsage", () => {
  assert.equal(opencodeProvider.id, "opencode");
  assert.equal(typeof opencodeProvider.displayName, "string");
  assert.equal(typeof opencodeProvider.config, "function");
  assert.equal(typeof opencodeProvider.fetchUsage, "function");
  assert.equal(opencodeProvider.syncModels, undefined, "model sync moved to dsh-plugin-toolkit");
  assert.equal(opencodeProvider.install, undefined, "startup healing moved to dsh-plugin-toolkit");
});

test("opencode adapter config(): flat compatibility + nested override", () => {
  const flat = opencodeProvider.config({ apiKey: "flat-key", timeoutSec: 7 });
  assert.equal(flat.apiKey, "flat-key");
  assert.equal(flat.timeoutSec, 7);
  assert.equal(flat.syncWithModel, true);

  const nested = opencodeProvider.config({
    apiKey: "flat",
    providers: { opencode: { apiKey: "nested-key" } },
  });
  assert.equal(nested.apiKey, "nested-key");
});

test("payload keeps the single-provider wire shape (rolling/weekly/monthly)", async () => {
  const mock = makeMockCtx();
  apply(mock.ctx, {});
  // Simulate one completed refresh by invoking the status handler.
  const statusRoute = mock.routes.find((r) => r.path === "/api/quota-badges/status");
  assert.ok(statusRoute, "status route mounted");
  assert.equal(typeof statusRoute.handler, "function");
  // A GET produces { ok, provider, displayName, data, error, fetchedAt, ageSec, providers }.
  const res = { writeHead() {}, end(body) { this.body = body; } };
  const req = { method: "GET" };
  await statusRoute.handler(req, res);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.provider, "opencode");
  assert.equal(body.displayName, "OpenCode");
  assert.deepEqual(body.providers, ["opencode", "minimax", "kimi", "deepseek"]);
  assert.ok("data" in body && "error" in body && "fetchedAt" in body && "ageSec" in body);
});

test("non-GET on status is rejected 405", async () => {
  const mock = makeMockCtx();
  apply(mock.ctx, {});
  const statusRoute = mock.routes.find((r) => r.path === "/api/quota-badges/status");
  let statusCode = 0;
  const res = {
    writeHead(code) {
      statusCode = code;
    },
    end() {},
  };
  await statusRoute.handler({ method: "POST" }, res);
  assert.equal(statusCode, 405);
});

test("adapter contract: ctx.config is a function returning the provider slice", async () => {
  // Route the fetch through the assembly layer's own providerCtx: index.js
  // hands every adapter { config: () => provider.config(currentConfig()) }.
  // The adapter must treat ctx.config as a FUNCTION — the flat-object reading
  // bug (ctx.config.apiKeyEnvVar === undefined on a function) regressed here.
  const mock = makeMockCtx();
  apply(mock.ctx, { apiKey: "sk-contract-test", apiKeyEnvVar: "OPENCODE_API_KEY" });

  // fetchUsageSnapshot resolves the key from the provider slice; a function
  // config passes it correctly, so the error must NOT be "unconfigured" with
  // an undefined env-var suffix — but the actual fetch will hit the network.
  // Instead verify upstreamFetch is invoked with the resolved key by stubbing
  // the adapter's fetch through a spy on the imported module? Simpler: assert
  // the unconfigured branch never leaks an "undefined" env var by calling the
  // adapter's fetchUsage with a function-shaped config and no key.
  const unconfigured = await opencodeProvider.fetchUsage({
    config: () => ({ apiKey: "", apiKeyEnvVar: "OPENCODE_API_KEY", timeoutSec: 10 }),
    resolveApiKey: (cfg) => (cfg.apiKey ?? "").trim(),
    logger: { warn: () => {} },
  });
  assert.equal(unconfigured.error.code, "unconfigured");
  assert.ok(
    !String(unconfigured.error.message).includes("undefined"),
    "message must not contain 'undefined' (flat-read bug): " + unconfigured.error.message,
  );
  assert.ok(String(unconfigured.error.message).includes("OPENCODE_API_KEY"));
});
