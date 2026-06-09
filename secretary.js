const TYPE_LABELS = {
  TASK: "TAREA",
  IDEA: "IDEA",
  DECISION: "DECISION",
  QUESTION: "DUDA",
  REMINDER: "RECORDATORIO",
  PROJECT: "PROYECTO",
  BLOCKER: "BLOQUEO",
  NOTE: "NOTA"
};

const TYPE_ORDER = ["BLOCKER", "TASK", "REMINDER", "DECISION", "QUESTION", "PROJECT", "IDEA", "NOTE"];

function createSecretaryState() {
  return {
    capturesByChat: new Map(),
    nextId: 1
  };
}

function classifyText(input) {
  const raw = String(input || "").trim();
  const lower = raw.toLowerCase();
  const patterns = [
    ["BLOCKER", /^(bloqueo|bloqueador|atasco|freno)\s*:/],
    ["TASK", /^(tarea|todo|pendiente|hacer)\s*:/],
    ["IDEA", /^(idea|concepto|propuesta)\s*:/],
    ["DECISION", /^(decision|decisión|decidido)\s*:/],
    ["QUESTION", /^(duda|pregunta)\s*:/],
    ["REMINDER", /^(recordatorio|recuerda|reminder)\s*:/],
    ["PROJECT", /^(proyecto|project)\s*:/]
  ];

  for (const [type, pattern] of patterns) {
    if (pattern.test(lower)) {
      return { type, text: raw.replace(pattern, "").trim() || raw };
    }
  }

  if (/\b(tengo que|hay que|pendiente|hacer|revisar|enviar|publicar)\b/.test(lower)) {
    return { type: "TASK", text: raw };
  }
  if (/\b(no puedo|falta|bloqueado|no funciona|error|atascado)\b/.test(lower)) {
    return { type: "BLOCKER", text: raw };
  }
  if (/\b(idea|podriamos|podríamos|seria bueno|sería bueno)\b/.test(lower)) {
    return { type: "IDEA", text: raw };
  }

  return { type: "NOTE", text: raw };
}

function getChatItems(state, chatId) {
  const key = String(chatId);
  if (!state.capturesByChat.has(key)) {
    state.capturesByChat.set(key, []);
  }
  return state.capturesByChat.get(key);
}

function addCapture(state, chatId, input) {
  const classified = classifyText(input);
  const item = {
    id: state.nextId++,
    type: classified.type,
    text: classified.text,
    status: "open",
    createdAt: new Date().toISOString()
  };

  getChatItems(state, chatId).push(item);
  return item;
}

function countByType(items) {
  return TYPE_ORDER.reduce((acc, type) => {
    acc[type] = items.filter((item) => item.type === type && item.status === "open").length;
    return acc;
  }, {});
}

function getNextAction(state, chatId) {
  const items = getChatItems(state, chatId).filter((item) => item.status === "open");
  return items.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.id - b.id)[0] || null;
}

function formatCounts(counts) {
  return TYPE_ORDER
    .filter((type) => counts[type] > 0)
    .map((type) => `${type.padEnd(9)} ${counts[type]}`)
    .join("\n") || "SIN CAPTURAS ABIERTAS";
}

function formatItemList(items) {
  const openItems = items.filter((item) => item.status === "open").slice(-8);
  if (!openItems.length) return "Nada abierto por ahora.";

  return openItems
    .map((item) => `[${item.id}] ${TYPE_LABELS[item.type]} :: ${item.text}`)
    .join("\n");
}

function formatTodayAscii(state, chatId) {
  const items = getChatItems(state, chatId);
  const counts = countByType(items);
  const next = getNextAction(state, chatId);

  return [
    "```",
    "HERMES / HOY",
    "==============================",
    formatCounts(counts),
    "",
    "ULTIMAS CAPTURAS",
    "------------------------------",
    formatItemList(items),
    "",
    "SIGUIENTE",
    "------------------------------",
    next ? `[${next.id}] ${TYPE_LABELS[next.type]} :: ${next.text}` : "Captura una idea o tarea para priorizar.",
    "```"
  ].join("\n");
}

function formatCloseAscii(state, chatId) {
  const items = getChatItems(state, chatId);
  const counts = countByType(items);
  const next = getNextAction(state, chatId);

  return [
    "```",
    "HERMES / CIERRE",
    "==============================",
    formatCounts(counts),
    "",
    "SIGUIENTE ACCION",
    "------------------------------",
    next ? `[${next.id}] ${TYPE_LABELS[next.type]} :: ${next.text}` : "Sin pendientes abiertos.",
    "",
    "REGLA ADHD",
    "------------------------------",
    "Una accion visible. Un avance pequeno. Cero ruido.",
    "```"
  ].join("\n");
}

function formatCaptureAscii(item) {
  return [
    "```",
    "HERMES / CAPTURA",
    "==============================",
    `ID      ${item.id}`,
    `TIPO    ${TYPE_LABELS[item.type]}`,
    `ESTADO  ${item.status.toUpperCase()}`,
    "",
    item.text,
    "```"
  ].join("\n");
}

module.exports = {
  classifyText,
  createSecretaryState,
  addCapture,
  getNextAction,
  formatTodayAscii,
  formatCloseAscii,
  formatCaptureAscii
};
