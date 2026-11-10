"use strict";

// Optional environment contract:
// BRAINTRUST_API_KEY            enables direct DeepSeek tracing (unset = no-op)
// BRAINTRUST_PROJECT_NAME       defaults to "My Project"
// BRAINTRUST_PROJECT_ID         optional; takes precedence over the project name
// BRAINTRUST_ORG_NAME           optional for keys that can access multiple orgs
// BRAINTRUST_BALANCE_MIN_MS     minimum gap between credit snapshots (15 min)
const DEFAULT_PROJECT_NAME = "My Project";
const DEFAULT_BALANCE_SNAPSHOT_MIN_MS = 15 * 60 * 1000;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function balanceMetrics(balance) {
  const metrics = {};
  const fields = {
    balance_total: balance.totalBalance,
    balance_granted: balance.grantedBalance,
    balance_topped_up: balance.toppedUpBalance,
  };
  for (const [name, value] of Object.entries(fields)) {
    const number = Number(value);
    if (value !== null && value !== undefined && Number.isFinite(number)) {
      metrics[name] = number;
    }
  }
  return metrics;
}

function createBraintrustObservability({
  apiKey = process.env.BRAINTRUST_API_KEY,
  projectName = process.env.BRAINTRUST_PROJECT_NAME || DEFAULT_PROJECT_NAME,
  projectId = process.env.BRAINTRUST_PROJECT_ID || undefined,
  orgName = process.env.BRAINTRUST_ORG_NAME || undefined,
  sdkFactory = () => require("braintrust"),
  logger = console,
  now = Date.now,
  balanceSnapshotMinMs = process.env.BRAINTRUST_BALANCE_MIN_MS,
} = {}) {
  let sdk = null;
  let projectLogger = null;
  let lastBalanceSnapshotAt = 0;
  const minimumSnapshotInterval = positiveNumber(
    balanceSnapshotMinMs,
    DEFAULT_BALANCE_SNAPSHOT_MIN_MS,
  );

  if (apiKey) {
    try {
      sdk = sdkFactory();
      projectLogger = sdk.initLogger({
        apiKey,
        ...(projectId ? { projectId } : { projectName }),
        ...(orgName ? { orgName } : {}),
        onFlushError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`[BRAINTRUST] background flush failed: ${message}`);
        },
      });
      logger.log(`[BRAINTRUST] DeepSeek tracing enabled for project "${projectId || projectName}"`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[BRAINTRUST] disabled after initialization failure: ${message}`);
      projectLogger = null;
    }
  }

  function wrapClient(client) {
    if (!client || !projectLogger || !sdk || typeof sdk.wrapOpenAI !== "function") {
      return client;
    }
    try {
      return sdk.wrapOpenAI(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[BRAINTRUST] client tracing disabled: ${message}`);
      return client;
    }
  }

  async function recordDeepSeekBalance(balance, { source = "unknown", force = false } = {}) {
    if (!projectLogger || !balance || !balance.ok) return false;

    const timestamp = now();
    if (!force && timestamp - lastBalanceSnapshotAt < minimumSnapshotInterval) {
      return false;
    }

    const metrics = balanceMetrics(balance);
    try {
      await projectLogger.traced(
        async (span) => {
          span.log({
            input: { source },
            metadata: {
              provider: "deepseek",
              source,
              currency: balance.currency || "unknown",
              fetched_at: balance.fetchedAt || new Date(timestamp).toISOString(),
              endpoint: "GET /user/balance",
            },
            metrics,
            tags: ["deepseek", "billing"],
          });
        },
        { name: "deepseek.credit_balance", type: "task" },
      );
      lastBalanceSnapshotAt = timestamp;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[BRAINTRUST] balance snapshot skipped: ${message}`);
      return false;
    }
  }

  async function flush() {
    if (!projectLogger || typeof projectLogger.flush !== "function") return;
    await projectLogger.flush();
  }

  return {
    get enabled() {
      return Boolean(projectLogger);
    },
    projectName,
    wrapClient,
    recordDeepSeekBalance,
    flush,
  };
}

module.exports = {
  DEFAULT_PROJECT_NAME,
  DEFAULT_BALANCE_SNAPSHOT_MIN_MS,
  createBraintrustObservability,
};
