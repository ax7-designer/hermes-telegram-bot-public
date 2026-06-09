const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyText,
  createSecretaryState,
  addCapture,
  getNextAction,
  formatTodayAscii,
  formatCloseAscii
} = require("./secretary");

test("classifyText detects tasks, ideas, blockers and reminders", () => {
  assert.equal(classifyText("tarea: publicar el reel de MAE").type, "TASK");
  assert.equal(classifyText("idea: crear un mapa visual de EcoVanguard").type, "IDEA");
  assert.equal(classifyText("bloqueo: falta la clave service_role").type, "BLOCKER");
  assert.equal(classifyText("recordatorio: revisar Render mañana").type, "REMINDER");
});

test("addCapture stores normalized captures by chat", () => {
  const state = createSecretaryState();
  const item = addCapture(state, 5068822444, "tarea: revisar RLS");

  assert.equal(item.id, 1);
  assert.equal(item.type, "TASK");
  assert.equal(state.capturesByChat.get("5068822444").length, 1);
});

test("getNextAction prioritizes blockers before tasks and ideas", () => {
  const state = createSecretaryState();
  addCapture(state, 1, "idea: nuevo dashboard");
  addCapture(state, 1, "tarea: enviar propuesta");
  addCapture(state, 1, "bloqueo: falta acceso a Supabase");

  const next = getNextAction(state, 1);

  assert.equal(next.type, "BLOCKER");
  assert.equal(next.text, "falta acceso a Supabase");
});

test("formatTodayAscii renders compact ADHD-friendly ASCII tracking", () => {
  const state = createSecretaryState();
  addCapture(state, 1, "tarea: limpiar backlog");
  addCapture(state, 1, "idea: sistema de etiquetas");

  const output = formatTodayAscii(state, 1);

  assert.match(output, /HERMES \/ HOY/);
  assert.match(output, /TASK\s+1/);
  assert.match(output, /IDEA\s+1/);
  assert.match(output, /limpiar backlog/);
});

test("formatCloseAscii includes one next action", () => {
  const state = createSecretaryState();
  addCapture(state, 1, "tarea: preparar cierre diario");

  const output = formatCloseAscii(state, 1);

  assert.match(output, /HERMES \/ CIERRE/);
  assert.match(output, /SIGUIENTE ACCION/);
  assert.match(output, /preparar cierre diario/);
});
