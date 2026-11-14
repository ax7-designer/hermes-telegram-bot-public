const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const https = require("node:https");

test("queue consumer offline", async (suite) => {
  let attempts = 0;
  function forbidNetwork() {
    attempts++;
    throw new Error("Network forbidden by queue consumer tests");
  }
  suite.mock.method(globalThis, "fetch", forbidNetwork);
  for (const transport of [http, https]) {
    suite.mock.method(transport, "request", forbidNetwork);
    suite.mock.method(transport, "get", forbidNetwork);
  }
  suite.after(() => assert.equal(attempts, 0));

  const { createQueueHandler } = require("./queue-consumer");
  const row = { id: 1, status: "pending", chat_id: 42, text: "prompt", model: "temporary" };

  function fixture(overrides = {}) {
    const events = [];
    const logs = [];
    const activeModels = new Map();
    let claimed = false;
    const deps = {
      activeModels,
      modelsConfig: { temporary: {} },
      queueAuthorizes(chatId) {
        events.push(["auth", chatId]);
        return { ok: true };
      },
      supabase: {
        from(table) {
          assert.equal(table, "qoder_hermes_queue");
          return {
            update({ updated_at, ...fields }) {
              assert.equal(new Date(updated_at).toISOString(), updated_at);
              const filters = [];
              events.push(["update", fields, filters]);
              return {
                eq(column, value) {
                  filters.push([column, value]);
                  return this;
                },
                select(columns) {
                  events.push(["select", columns]);
                  return this;
                },
                async single() {
                  events.push(["claim"]);
                  if (claimed) return { data: null, error: new Error("lost") };
                  claimed = true;
                  return { data: { id: row.id, status: "processing" }, error: null };
                },
              };
            },
          };
        },
      },
      instanceId: "test",
      async askAI(chatId, text) {
        events.push(["askAI", chatId, text, activeModels.get(chatId)]);
        return "r".repeat(4100);
      },
      async safeSendMessage(chatId, reply) {
        events.push(["send", chatId, reply]);
      },
      async handleHTMLExtraction() {},
      logger: {
        log: (message) => logs.push(["log", message]),
        warn: (message) => logs.push(["warn", message]),
        error: (message) => logs.push(["error", message]),
      },
      ...overrides,
    };
    return { events, logs, deps, activeModels, handle: createQueueHandler(deps) };
  }

  await suite.test("ignores missing and non-pending rows", async () => {
    const { handle, events, logs } = fixture();
    await handle({});
    await handle({ new: { ...row, status: "done" } });
    assert.deepEqual(events, []);
    assert.deepEqual(logs, []);
  });

  await suite.test("rejects unauthorized rows before claiming", async () => {
    const { handle, events } = fixture({
      queueAuthorizes: () => ({ ok: false, reason: "outside policy" }),
    });
    await handle({ new: row });
    assert.deepEqual(events, [
      ["update", { status: "failed", result: "authz denied: outside policy" }, [
        ["id", row.id], ["status", "pending"],
      ]],
    ]);
  });

  await suite.test("claims atomically and persists a truncated reply after sending", async () => {
    const { handle, events } = fixture();
    await handle({ new: row });
    assert.deepEqual(events, [
      ["auth", row.chat_id],
      ["update", { status: "processing" }, [["id", row.id], ["status", "pending"]]],
      ["select", "id, status"],
      ["claim"],
      ["askAI", row.chat_id, row.text, row.model],
      ["send", row.chat_id, "r".repeat(4100)],
      ["update", { status: "done", result: "r".repeat(4000) }, [["id", row.id]]],
    ]);
  });

  await suite.test("two consumers race and the loser only logs the lost claim", async () => {
    const { handle, deps, events, logs } = fixture();
    const other = createQueueHandler(deps);
    await Promise.all([handle({ new: row }), other({ new: row })]);
    for (const event of ["askAI", "send"]) {
      assert.equal(events.filter(([kind]) => kind === event).length, 1);
    }
    assert.equal(events.filter(([kind]) => kind === "claim").length, 2);
    assert.deepEqual(logs.filter(([, message]) => message.includes("otra instancia")), [
      ["log", "[QODER QUEUE] fila 1 ya la tomó otra instancia."],
    ]);
  });

  await suite.test("HTML extraction failure still completes the row", async () => {
    let extractionCalls = 0;
    const { handle, events } = fixture({
      async handleHTMLExtraction() {
        extractionCalls++;
        throw new Error("HTML failure");
      },
    });
    await handle({ new: row });
    assert.equal(extractionCalls, 1);
    assert.equal(events.at(-1)[1].status, "done");
  });

  for (const hadPrevious of [false, true]) {
    for (const fails of [false, true]) {
      await suite.test(`cleans up temporary model with prior=${hadPrevious} and AI failure=${fails}`, async () => {
        const setup = fixture();
        if (hadPrevious) setup.activeModels.set(row.chat_id, "previous");
        const originalAsk = setup.deps.askAI;
        setup.deps.askAI = async (...args) => {
          await originalAsk(...args);
          if (fails) throw new Error("e".repeat(600));
          return "ok";
        };
        await createQueueHandler(setup.deps)({ new: row });
        assert.deepEqual(setup.events.find(([kind]) => kind === "askAI"), [
          "askAI", row.chat_id, row.text, row.model,
        ]);
        assert.equal(setup.activeModels.has(row.chat_id), hadPrevious);
        assert.equal(setup.activeModels.get(row.chat_id), hadPrevious ? "previous" : undefined);

        const terminal = setup.events.filter(([kind, fields]) =>
          kind === "update" && ["failed", "done"].includes(fields.status));
        assert.deepEqual(terminal, [["update", fails
          ? { status: "failed", result: "e".repeat(500) }
          : { status: "done", result: "ok" },
        [["id", row.id]]]]);
        assert.equal(setup.events.some(([kind]) => kind === "send"), !fails);
      });
    }
  }
});
