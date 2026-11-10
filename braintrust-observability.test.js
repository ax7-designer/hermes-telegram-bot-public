"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_PROJECT_NAME,
  createBraintrustObservability,
} = require("./braintrust-observability");

function silentLogger() {
  return { log() {}, warn() {} };
}

function fakeSdk() {
  const state = { initOptions: null, wrappedClient: null, spans: [] };
  state.sdk = {
    initLogger(options) {
      state.initOptions = options;
      return {
        async traced(callback, spanArgs) {
          const payloads = [];
          const span = {
            log(payload) {
              payloads.push(payload);
            },
          };
          const result = await callback(span);
          state.spans.push({ args: spanArgs, payloads });
          return result;
        },
        async flush() {},
      };
    },
    wrapOpenAI(client) {
      state.wrappedClient = client;
      return { ...client, tracedByBraintrust: true };
    },
  };
  return state;
}

test("Braintrust remains fully disabled without an API key", () => {
  let sdkRequested = false;
  const obs = createBraintrustObservability({
    apiKey: "",
    sdkFactory: () => {
      sdkRequested = true;
      throw new Error("must not load");
    },
    logger: silentLogger(),
  });

  const client = { chat: {} };
  assert.equal(obs.enabled, false);
  assert.equal(obs.wrapClient(client), client);
  assert.equal(sdkRequested, false);
});

test("an explicit project name is used and the DeepSeek client is wrapped", () => {
  const state = fakeSdk();
  const obs = createBraintrustObservability({
    apiKey: "test-key",
    projectName: "Hermes DeepSeek",
    sdkFactory: () => state.sdk,
    logger: silentLogger(),
  });
  const client = { chat: {} };
  const wrapped = obs.wrapClient(client);

  assert.equal(obs.enabled, true);
  assert.equal(state.initOptions.projectName, "Hermes DeepSeek");
  assert.equal(state.initOptions.apiKey, "test-key");
  assert.equal(state.wrappedClient, client);
  assert.equal(wrapped.tracedByBraintrust, true);
});

test("an explicit project ID takes precedence over the project name", () => {
  const state = fakeSdk();
  createBraintrustObservability({
    apiKey: "test-key",
    projectName: "Ignored name",
    projectId: "project-id-123",
    sdkFactory: () => state.sdk,
    logger: silentLogger(),
  });

  assert.equal(state.initOptions.projectId, "project-id-123");
  assert.equal(state.initOptions.projectName, undefined);
});

test("defaults to the existing Braintrust project and fails open on SDK errors", () => {
  const obs = createBraintrustObservability({
    apiKey: "test-key",
    sdkFactory: () => {
      throw new Error("SDK unavailable");
    },
    logger: silentLogger(),
  });
  const client = { chat: {} };

  assert.equal(obs.projectName, DEFAULT_PROJECT_NAME);
  assert.equal(obs.enabled, false);
  assert.equal(obs.wrapClient(client), client);
});

test("successful DeepSeek balances are logged with native credit metrics", async () => {
  const state = fakeSdk();
  const obs = createBraintrustObservability({
    apiKey: "test-key",
    sdkFactory: () => state.sdk,
    logger: silentLogger(),
    now: () => Date.parse("2026-11-10T12:00:00.000Z"),
  });
  const recorded = await obs.recordDeepSeekBalance(
    {
      ok: true,
      currency: "CNY",
      totalBalance: 110,
      grantedBalance: 10,
      toppedUpBalance: 100,
      fetchedAt: "2026-11-10T11:59:00.000Z",
    },
    { source: "telegram" },
  );

  assert.equal(recorded, true);
  assert.equal(state.spans.length, 1);
  assert.deepEqual(state.spans[0].args, { name: "deepseek.credit_balance", type: "task" });
  assert.deepEqual(state.spans[0].payloads[0], {
    input: { source: "telegram" },
    metadata: {
      provider: "deepseek",
      source: "telegram",
      currency: "CNY",
      fetched_at: "2026-11-10T11:59:00.000Z",
      endpoint: "GET /user/balance",
    },
    metrics: {
      balance_total: 110,
      balance_granted: 10,
      balance_topped_up: 100,
    },
    tags: ["deepseek", "billing"],
  });
});

test("balance snapshots are throttled unless explicitly forced", async () => {
  const state = fakeSdk();
  let clock = 1_000_000;
  const obs = createBraintrustObservability({
    apiKey: "test-key",
    sdkFactory: () => state.sdk,
    logger: silentLogger(),
    now: () => clock,
    balanceSnapshotMinMs: 60_000,
  });
  const balance = {
    ok: true,
    currency: "USD",
    totalBalance: 5,
    grantedBalance: 0,
    toppedUpBalance: 5,
    fetchedAt: "2026-11-10T12:00:00.000Z",
  };

  assert.equal(await obs.recordDeepSeekBalance(balance), true);
  clock += 30_000;
  assert.equal(await obs.recordDeepSeekBalance(balance), false);
  clock += 30_001;
  assert.equal(await obs.recordDeepSeekBalance(balance), true);
  assert.equal(await obs.recordDeepSeekBalance(balance, { force: true }), true);
  assert.equal(state.spans.length, 3);
});

test("failed balance responses are never sent as credit metrics", async () => {
  const state = fakeSdk();
  const obs = createBraintrustObservability({
    apiKey: "test-key",
    sdkFactory: () => state.sdk,
    logger: silentLogger(),
  });

  assert.equal(await obs.recordDeepSeekBalance({ ok: false, reason: "HTTP 401" }), false);
  assert.equal(state.spans.length, 0);
});
