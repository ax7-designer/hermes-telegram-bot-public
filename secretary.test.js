const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyText,
  createSecretaryState,
  addCapture,
  getNextAction,
  formatTodayAscii,
  formatCloseAscii,
  formatProjectsAscii,
  updateProject,
  setProfile,
  getProfile,
  detectSecretaryIntent,
  formatVoiceStatusAscii
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

test("formatProjectsAscii orders projects by last modification and limits progress to top three", () => {
  const state = createSecretaryState();
  updateProject(state, 1, "Hijo de Hermes", {
    status: "activo",
    progress: ["Bot Telegram creado"],
    pending: ["Revisar polling"],
    ssPlus: ["Abrir Render"],
    updatedAt: "2026-06-09T12:00:00.000Z"
  });
  updateProject(state, 1, "MAE Wellness Club", {
    status: "pendiente",
    progress: ["Health-check existe"],
    pending: ["Conectar alertas"],
    ssPlus: ["Abrir carpeta monitor"],
    updatedAt: "2026-06-09T11:00:00.000Z"
  });
  updateProject(state, 1, "EcoVanguard", {
    status: "activo",
    progress: ["Wise Pipeline documentado"],
    pending: ["Definir tablero visual"],
    updatedAt: "2026-06-09T10:00:00.000Z"
  });
  updateProject(state, 1, "Sheldon Bot Finanzas", {
    status: "idea",
    progress: ["Persona definida en backlog"],
    pending: ["Crear prompt"],
    updatedAt: "2026-06-09T09:00:00.000Z"
  });

  const output = formatProjectsAscii(state, 1);

  assert.match(output, /1\. \[PIN-1 CYAN\] HIJO DE HERMES/);
  assert.match(output, /2\. \[PIN-2 VERDE\] MAE WELLNESS CLUB/);
  assert.match(output, /SS\+:/);
  assert.equal((output.match(/Progreso:/g) || []).length, 3);
  assert.doesNotMatch(output, /SHELDON BOT FINANZAS[\s\S]*Progreso:/);
});

test("formatProjectsAscii exposes Codex Antigravity folder view without chats", () => {
  const state = createSecretaryState();
  updateProject(state, 1, "Codex + Antigravity Workspace", {
    status: "activo",
    folder: "D:/AI",
    agents: ["Codex", "Antigravity"],
    sync: ["Codex: D:/AI", "Antigravity: D:/AI/Hermes/telegram-bot"],
    chatScope: "fuera del tablero",
    updatedAt: "2026-06-10T12:00:00.000Z"
  });

  const output = formatProjectsAscii(state, 1);

  assert.match(output, /1\. \[PIN-1 CYAN\] CODEX \+ ANTIGRAVITY WORKSPACE/);
  assert.match(output, /Carpeta: D:\/AI/);
  assert.match(output, /Agentes: Codex \+ Antigravity/);
  assert.match(output, /Sincronia:/);
  assert.match(output, /Codex: D:\/AI/);
  assert.match(output, /Antigravity: D:\/AI\/Hermes\/telegram-bot/);
  assert.match(output, /Chats: fuera del tablero/);
});

test("formatProjectsAscii marks only the five most recent projects as pinned with ascii colors", () => {
  const state = createSecretaryState();
  for (let i = 1; i <= 6; i++) {
    updateProject(state, 1, `Proyecto ${i}`, {
      status: "activo",
      updatedAt: `2026-06-10T0${i}:00:00.000Z`
    });
  }

  const output = formatProjectsAscii(state, 1);

  assert.match(output, /1\. \[PIN-1 CYAN\] PROYECTO 6/);
  assert.match(output, /2\. \[PIN-2 VERDE\] PROYECTO 5/);
  assert.match(output, /3\. \[PIN-3 AMBAR\] PROYECTO 4/);
  assert.match(output, /4\. \[PIN-4 MAGENTA\] PROYECTO 3/);
  assert.match(output, /5\. \[PIN-5 GRIS\] PROYECTO 2/);
  assert.match(output, /6\. PROYECTO 1/);
  assert.doesNotMatch(output, /6\. \[PIN-/);
});

test("profile helpers keep a voice-first default and support switching roles", () => {
  const state = createSecretaryState();

  assert.equal(getProfile(state, 1).id, "secretario");
  assert.equal(setProfile(state, 1, "tecnico").id, "tecnico");
  assert.equal(getProfile(state, 1).label, "TECNICO");
  assert.equal(setProfile(state, 1, "director").id, "director");
  assert.equal(getProfile(state, 1).label, "DIRECTOR HIBRIDO");
});

test("detectSecretaryIntent maps natural voice phrases to secretary actions", () => {
  assert.deepEqual(detectSecretaryIntent("Hermes, proyectos"), { type: "PROJECTS" });
  assert.deepEqual(detectSecretaryIntent("Hermes, siguiente microaccion"), { type: "NEXT" });
  assert.deepEqual(detectSecretaryIntent("Hermes, perfil tecnico"), { type: "SET_PROFILE", profileId: "tecnico" });
  assert.deepEqual(detectSecretaryIntent("Hermes, modo director"), { type: "SET_PROFILE", profileId: "director" });
  assert.deepEqual(detectSecretaryIntent("Hermes, perfil video"), { type: "SET_PROFILE", profileId: "director" });
  assert.deepEqual(detectSecretaryIntent("Hermes, voz"), { type: "VOICE_STATUS" });

  const capture = detectSecretaryIntent("Hermes, captura tarea: revisar Render");
  assert.equal(capture.type, "CAPTURE");
  assert.equal(capture.text, "tarea: revisar Render");
});

test("formatVoiceStatusAscii explains current no-extra-cost voice path", () => {
  const output = formatVoiceStatusAscii();

  assert.match(output, /HERMES \/ VOZ/);
  assert.match(output, /Entrada/);
  assert.match(output, /Gemini/);
  assert.match(output, /TTS/);
});
