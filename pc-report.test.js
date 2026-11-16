const assert = require("node:assert/strict");
const test = require("node:test");
const { createReportCommand, parseReportCommand, formatReportResult, createReportPrompt } = require("./pc-report");

test("PC report command is fixed and bound to the allowed private chat", () => {
  assert.equal(createReportCommand(5068822444), "dsh-report:v1:5068822444");
  assert.deepEqual(parseReportCommand("dsh-report:v1:5068822444", 5068822444), { chatId: 5068822444 });
  assert.equal(parseReportCommand("dsh-report:v1:2", 5068822444), null);
  assert.equal(parseReportCommand("dsh-report:v1:5068822444:extra", 5068822444), null);
  assert.equal(parseReportCommand("status", 5068822444), null);
  assert.throws(() => createReportCommand(-42), /positive safe integer/);
});

test("report formatter returns only the requested fields and strips URL paths", () => {
  const result = formatReportResult(JSON.stringify({
    total: "128",
    rango: "2026-10-01 a 2026-10-31",
    pagina_origen: "https://reports.example.test/monthly/123?session=private",
  }));
  assert.equal(result, "Total: 128\nRango: 2026-10-01 a 2026-10-31\nPágina de origen: https://reports.example.test");
});

test("report formatter fails closed on extra content or unsafe origins", () => {
  assert.throws(() => formatReportResult("No JSON"), /invalid report response/);
  assert.throws(() => formatReportResult(JSON.stringify({
    total: "128", rango: "octubre", pagina_origen: "https://reports.example.test", details: "private",
  })), /only the requested fields/);
  assert.throws(() => formatReportResult(JSON.stringify({
    total: "128", rango: "octubre", pagina_origen: "javascript:alert(1)",
  })), /invalid page origin/);
  assert.throws(() => formatReportResult(JSON.stringify({
    total: "128", rango: "octubre", pagina_origen: "https://user:secret@reports.example.test/",
  })), /invalid page origin/);
});

test("fixed task prompt limits CUA to the active Edge report and read-only fields", () => {
  const prompt = createReportPrompt();
  assert.match(prompt, /pestaña activa de Microsoft Edge/);
  assert.match(prompt, /no navegues, no hagas clic ni escribas/);
  assert.match(prompt, /No incluyas texto adicional/);
});
