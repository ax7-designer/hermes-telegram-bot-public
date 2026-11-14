const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const http = require("node:http");
const https = require("node:https");
const { createQueueHandler } = require("./queue-consumer");

const source = fs.readFileSync(require.resolve("./bot"), "utf8");
const qwen = "qwen/qwen3-coder-next";
const selected = "deepseek-v4-pro";
const fallback = qwen;
const gemini = "google/gemini-2.5-flash";
const deepseek = "deepseek-flash";

test("model persistence offline", async (suite) => {
  let attempts = 0;
  function block() {
    attempts++;
    throw new Error("Unexpected network");
  }
  suite.mock.method(globalThis, "fetch", block);
  for (const transport of [http, https]) {
    suite.mock.method(transport, "get", block);
    suite.mock.method(transport, "request", block);
  }
  suite.after(() => assert.equal(attempts, 0));

  // ponytail: evaluate only the real handlers and history functions so bot startup
  // stays out of the test. If these boundaries move, update the source anchors.
  function extract(regexp) {
    const match = source.match(regexp);
    assert.ok(match, String(regexp));
    return match[0];
  }

  function setup({ saved = selected, google = false, reject = false, readError = false } = {}) {
    const activeModels = new Map();
    const selectedModels = new Map();
    const conversations = new Map();
    const old = { role: "assistant", content: "old" };
    const writes = [];
    const calls = [];
    const handlers = {};
    let reads = 0;
    const MODELS_CONFIG = Object.fromEntries([gemini, selected, deepseek, qwen].map(
      (id) => [id, { name: id, short: id, inputPrice: 0, outputPrice: 0 }],
    ));
    const response = { choices: [{ message: { content: "answer" } }] };
    function client(isFallback = false) {
      return { chat: { completions: { async create(params) {
        calls.push(params.model);
        assert.ok(params.messages.every((message) => !Object.hasOwn(message, "model")));
        if (reject && !isFallback) throw Object.assign(new Error("upstream"), { status: 503 });
        if (params.stream) return [{ choices: [{ delta: { content: "answer" } }] }];
        return response;
      } } } };
    }
    const context = {
      activeModels, selectedModels, conversations, MODELS_CONFIG,
      MODEL: deepseek, MAX_HISTORY: 20, SYSTEM_PROMPT: "test",
      chalk: { gray: String, green: String, red: String, blue: String, yellow: String },
      console: { log() {}, error() {} },
      supabase: { from(table) {
        assert.equal(table, "telegram_chat_history");
        return {
          select(columns) {
            assert.equal(columns, "history, active_model");
            return this;
          },
          eq(column, id) {
            assert.equal(column, "chat_id");
            assert.equal(id, 42);
            return this;
          },
          async maybeSingle() {
            reads++;
            if (readError) throw new Error("read failed");
            return { data: { history: [{ ...old }], active_model: saved } };
          },
          async upsert(payload) { writes.push(structuredClone(payload)); return {}; },
        };
      } },
      googleGenAI: google ? { getGenerativeModel({ model }) {
        calls.push(model);
        return { startChat: () => ({ sendMessage: async () => ({ response: { text: () => "answer" } }) }) };
      } } : null,
      clientFor: () => client(),
      openai: client(true),
      isDeepSeekModel: (id) => id.startsWith("deepseek-"),
      proxyChatIdFrom: () => 42,
      getEffectiveSystemPrompt: () => "test",
      fetchBalance: async () => "",
      fetchDSBalance: async () => "",
      getRandomHermesNote: () => "",
      shortModel: String,
      recordUsage() {},
      usageCost: () => 0,
      buildBalanceLines: () => "",
      buildModelKeyboard: () => [],
      isAllowed: () => true,
      onAuthorizedText: (_, handler) => { handlers.reset = handler; },
      bot: { on: (event, handler) => { handlers[event] = handler; },
        answerCallbackQuery() {}, editMessageText() {}, sendMessage() {} },
    };
    vm.runInNewContext([
      ...["getModelConfig", "trimHistory", "loadHistory", "saveHistory", "askAI", "handleHermesProxy"].map(
        (name) => extract(new RegExp("^(?:async )?function " + name + "\\([\\s\\S]*?^\\}", "m")),
      ),
      extract(/^onAuthorizedText\(\/\\\/reset\/,[\s\S]*?^\}\);/m),
      extract(/^bot\.on\("callback_query",[\s\S]*?^\}\);/m),
      extract(/^bot\.on\("message",[\s\S]*?^\}\);/m),
    ].join("\n"), context);

    async function proxy(params = {}) {
      await context.handleHermesProxy({}, { writeHead() {}, write() {}, end() {} },
        JSON.stringify({ messages: [{ role: "user", content: "prompt" }], ...params }));
    }
    function assertTurn(model) {
      const history = writes.at(-1).history;
      assert.deepEqual(history[0], old);
      assert.deepEqual(history.at(-2), { role: "user", content: "prompt" });
      assert.deepEqual(history.at(-1), { role: "assistant", content: "answer", model });
    }
    return { context, handlers, activeModels, selectedModels, conversations,
      writes, calls, proxy, assertTurn, reads: () => reads };
  }

  for (const [name, options, run, expected, upstream] of [
    ["Telegram Google", { saved: gemini, google: true }, "chat", gemini, ["gemini-2.5-flash"]],
    ["Telegram DeepSeek fallback", { reject: true }, "chat", fallback, [selected, fallback]],
    ["proxy stream fallback", { reject: true }, "stream", fallback, [selected, fallback]],
    ["proxy stream", {}, "stream", selected, [selected]],
    ["proxy non-stream fallback", { reject: true }, "proxy", fallback, [selected, fallback]],
  ]) {
    await suite.test(name + " stores the effective model and leaves legacy turns intact", async () => {
      const state = setup(options);
      if (run === "chat") await state.context.askAI(42, "prompt");
      else await state.proxy({ stream: run === "stream" });
      assert.deepEqual(state.calls, upstream);
      state.assertTurn(expected);
    });
  }

  await suite.test("cold selection replaces the stored model in both maps and upsert", async () => {
    const state = setup();
    await state.handlers.callback_query({ from: { id: 42 }, message: { chat: { id: 42 } }, data: "set_model:flash" });
    assert.equal(state.selectedModels.get(42), qwen);
    assert.equal(state.activeModels.get(42), qwen);
    assert.equal(state.writes.at(-1).active_model, qwen);
  });

  await suite.test("restart restores selection and a history cache hit preserves the current model", async () => {
    const state = setup();
    await state.context.loadHistory(42);
    assert.equal(state.context.getModelConfig(42).name, selected);
    state.selectedModels.set(42, qwen);
    await state.context.loadHistory(42);
    assert.equal(state.context.getModelConfig(42).name, qwen);
    assert.equal(state.reads(), 1);
  });

  for (const cold of [false, true]) {
    await suite.test("real queue override preserves the persisted selection, cold=" + cold, async () => {
      const state = setup({ saved: deepseek });
      state.context.MODEL = qwen;
      if (!cold) {
        state.selectedModels.set(42, deepseek);
        state.activeModels.set(42, deepseek);
      }
      const handler = createQueueHandler({
        activeModels: state.activeModels,
        modelsConfig: state.context.MODELS_CONFIG,
        askAI: state.context.askAI,
        queueAuthorizes: () => ({ ok: true }),
        safeSendMessage: async () => {},
        handleHTMLExtraction: async () => {},
        logger: { log() {}, warn() {}, error() {} },
        supabase: { from: () => ({
          update() { return this; }, eq() { return this; }, select() { return this; },
          single: async () => ({ data: { id: 1 } }),
        }) },
      });
      await handler({ new: { id: 1, chat_id: 42, status: "pending", model: qwen, text: "prompt" } });
      state.assertTurn(qwen);
      assert.equal(state.writes[0].active_model, deepseek);
      assert.equal(state.activeModels.get(42), cold ? undefined : deepseek);
      await state.context.askAI(42, "next");
      assert.deepEqual(state.calls, [qwen, deepseek]);
    });
  }

  for (const explicit of [false, true]) {
    await suite.test("first proxy request after restart, explicit=" + explicit, async () => {
      const state = setup();
      await state.proxy(explicit ? { model: qwen } : {});
      assert.deepEqual(state.calls, [explicit ? qwen : selected]);
      state.assertTurn(explicit ? qwen : selected);
      assert.equal(state.writes[0].active_model, selected);
      assert.equal(state.reads(), 1);
    });
  }

  for (const cleanup of ["reset", "message"]) {
    await suite.test("cold " + cleanup + " clears history and preserves selection", async () => {
      const state = setup({ saved: deepseek });
      // Use a different default to detect a missing restore in the next turn.
      state.context.MODEL = qwen;
      await state.handlers[cleanup]({ chat: { id: 42 }, from: { id: 42 }, text: "🔄 Limpiar Historial" });
      assert.deepEqual(state.writes[0].history, []);
      assert.equal(state.writes[0].active_model, deepseek);
      await state.context.askAI(42, "next");
      assert.deepEqual(state.calls, [deepseek]);
    });
  }

  await suite.test("failed read omits unknown column, then includes a known selection", async () => {
    const state = setup({ readError: true });
    await state.context.loadHistory(42);
    await state.context.saveHistory(42, []);
    assert.equal(Object.hasOwn(state.writes[0], "active_model"), false);
    state.selectedModels.set(42, qwen);
    await state.context.saveHistory(42, []);
    assert.equal(state.writes[1].active_model, qwen);
  });
});
