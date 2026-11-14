const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const https = require("node:https");

test("PC poller offline", async (suite) => {
  let networkAttempts = 0;
  function forbidNetwork() {
    networkAttempts++;
    throw new Error("Network forbidden by PC poller tests");
  }
  suite.mock.method(globalThis, "fetch", forbidNetwork);
  for (const transport of [http, https]) {
    suite.mock.method(transport, "request", forbidNetwork);
    suite.mock.method(transport, "get", forbidNetwork);
  }
  suite.after(() => assert.equal(networkAttempts, 0));

  const { createPcPoller } = require("./pc-poller");
  const plain = { chat_id: 42, message_id: 7 };
  const markdown = { ...plain, parse_mode: "Markdown" };
  const result = "raw_text\n```markdown\nKeep this fence\n```";
  const completedText = "✅ *Acción Local (status) — ID 3*\n\n" + result;

  function setup({ job = { status: "completed", result }, pollError = null,
    rejection, editErrors = [] } = {}) {
    const edits = [];
    const cleared = [];
    let polls = 0;
    let tick;
    const poller = createPcPoller({
      chatId: 42, messageId: 7, actionName: "status", jobId: 3,
      supabase: {
        from(table) {
          assert.equal(table, "antigravity_local_queue");
          return this;
        },
        select(columns) {
          assert.equal(columns, "status, result");
          return this;
        },
        eq(column, value) {
          assert.deepEqual([column, value], ["id", 3]);
          return this;
        },
        async single() {
          polls++;
          if (rejection) throw rejection;
          return { data: job, error: pollError };
        },
      },
      async editMessageText(text, options) {
        assert.deepEqual(cleared, [19]);
        edits.push([text, options]);
        const error = editErrors[edits.length - 1];
        if (error) throw new Error(error);
      },
      timers: {
        setInterval(callback, ms) {
          assert.equal(ms, 1500);
          tick = callback;
          return 19;
        },
        clearInterval(id) {
          cleared.push(id);
        },
      },
      logger: { error() {} },
    });
    poller.start();
    return { edits, cleared, tick, polls: () => polls };
  }

  await suite.test("completed preserves header and result with Markdown", async () => {
    const run = setup();
    await run.tick();
    assert.deepEqual(run.edits, [[completedText, markdown]]);
    assert.deepEqual(run.cleared, [19]);
  });

  await suite.test("failed preserves the failure indicator and result", async () => {
    const run = setup({ job: { status: "failed", result } });
    await run.tick();
    assert.deepEqual(run.edits, [["❌ *Acción Local (status) — ID 3*\n\n" + result, markdown]]);
    assert.deepEqual(run.cleared, [19]);
  });

  await suite.test("parse rejection retries identical content once without parse mode", async () => {
    const run = setup({ editErrors: ["Bad Request: can't parse entities"] });
    await run.tick();
    assert.deepEqual(run.edits, [[completedText, markdown], [completedText, plain]]);
  });

  await suite.test("other edit errors report without retrying content", async () => {
    const run = setup({ editErrors: ["message to edit not found"] });
    await run.tick();
    assert.equal(run.edits.length, 2);
    assert.deepEqual(run.edits[0], [completedText, markdown]);
    assert.deepEqual(run.edits[1][1], plain);
    assert.match(run.edits[1][0], /message to edit not found/);
  });

  await suite.test("failed fallback reports once and clears the interval", async () => {
    const run = setup({ editErrors: ["can't parse entities", "fallback failed", "report failed"] });
    await run.tick();
    assert.equal(run.edits.length, 3);
    assert.deepEqual(run.edits.slice(0, 2), [[completedText, markdown], [completedText, plain]]);
    assert.match(run.edits[2][0], /fallback failed/);
    assert.deepEqual(run.edits[2][1], plain);
    assert.deepEqual(run.cleared, [19]);
  });

  await suite.test("rejected query clears the interval and reports in plain text", async () => {
    const run = setup({ rejection: new Error("query rejected") });
    await run.tick();
    assert.equal(run.edits.length, 1);
    assert.match(run.edits[0][0], /query rejected/);
    assert.deepEqual(run.edits[0][1], plain);
    assert.deepEqual(run.cleared, [19]);
  });

  await suite.test("returned poll error retains the original Markdown message", async () => {
    const run = setup({ pollError: { message: "query error" } });
    await run.tick();
    assert.deepEqual(run.edits, [["❌ *Error al consultar estatus de la acción:*\n`query error`", markdown]]);
    assert.deepEqual(run.cleared, [19]);
  });

  await suite.test("missing job reports in plain text and stops", async () => {
    const run = setup({ job: null });
    await run.tick();
    assert.equal(run.edits.length, 1);
    assert.match(run.edits[0][0], /No se encontró la acción/);
    assert.deepEqual(run.edits[0][1], plain);
    assert.deepEqual(run.cleared, [19]);
  });

  await suite.test("timeout preserves the original Markdown message after 20 polls", async () => {
    const run = setup({ job: { status: "pending" } });
    for (let i = 0; i < 20; i++) await run.tick();
    assert.equal(run.polls(), 20);
    assert.deepEqual(run.edits, [[
      "⚠️ *Tiempo de espera agotado.*\nEl PC local no respondió a la acción en 30 segundos. Verifica que `node antigravity-bridge.js` esté corriendo en tu PC.",
      markdown,
    ]]);
    assert.deepEqual(run.cleared, [19]);
  });

  await suite.test("first pending poll neither edits nor stops", async () => {
    const run = setup({ job: { status: "pending" } });
    await run.tick();
    assert.equal(run.polls(), 1);
    assert.deepEqual(run.edits, []);
    assert.deepEqual(run.cleared, []);
  });
});
