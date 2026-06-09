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

const PROFILES = {
  secretario: {
    id: "secretario",
    label: "SECRETARIO ESTRATEGICO ADHD",
    purpose: "Captura, ordena, resume y microdosifica."
  },
  estratega: {
    id: "estratega",
    label: "ESTRATEGA",
    purpose: "Convierte ideas en rutas, decisiones y prioridades."
  },
  tecnico: {
    id: "tecnico",
    label: "TECNICO",
    purpose: "Diagnostica codigo, deploys, APIs y errores."
  },
  creativo: {
    id: "creativo",
    label: "CREATIVO",
    purpose: "Explora conceptos visuales, campanas, UX y narrativa."
  },
  auditor: {
    id: "auditor",
    label: "AUDITOR",
    purpose: "Detecta riesgos, costos, deuda tecnica y seguridad."
  },
  operador: {
    id: "operador",
    label: "OPERADOR",
    purpose: "Coordina acciones sobre la PC local con confirmacion."
  }
};

const PROFILE_ALIASES = {
  secretaria: "secretario",
  secretario: "secretario",
  adhd: "secretario",
  estrategia: "estratega",
  estratega: "estratega",
  tecnico: "tecnico",
  tecnica: "tecnico",
  tech: "tecnico",
  codigo: "tecnico",
  creativo: "creativo",
  creativa: "creativo",
  diseno: "creativo",
  auditor: "auditor",
  auditoria: "auditor",
  seguridad: "auditor",
  operador: "operador",
  pc: "operador",
  computadora: "operador"
};

const DEFAULT_PROJECTS = [
  {
    name: "Hijo de Hermes",
    status: "activo, revisar estabilidad cloud",
    progress: [
      "Bot Telegram creado",
      "Modelos OpenRouter/Gemini activos",
      "Secretario ADHD inicial agregado"
    ],
    pending: [
      "Confirmar polling vivo en Render",
      "Persistir memoria de secretario"
    ],
    ssPlus: [
      "Abrir Render logs",
      "Enviar /status",
      "Anotar si pending_update_count sube"
    ]
  },
  {
    name: "Antigravity Local Bridge",
    status: "construido, pendiente prueba E2E",
    progress: [
      "antigravity-bridge.js existe",
      "START_ANTIGRAVITY_BRIDGE.bat existe"
    ],
    pending: [
      "Probar comando desde Telegram",
      "Confirmar regreso de resultado"
    ],
    ssPlus: [
      "Encender el .bat",
      "Enviar cmd: dir",
      "Leer una linea del resultado"
    ]
  },
  {
    name: "Supabase / Seguridad RLS",
    status: "pendiente critico",
    progress: [
      "SQL de remediacion preparado",
      "Riesgo anon key identificado"
    ],
    pending: [
      "Cambiar SUPABASE_KEY a service_role/secret",
      "Aplicar RLS sin romper Hermes"
    ],
    ssPlus: [
      "Abrir Supabase SQL Editor",
      "Copiar 1 bloque SQL",
      "Verificar rowsecurity true"
    ]
  },
  {
    name: "MAE Wellness Club",
    status: "pendiente de integracion",
    progress: [
      "Health-check mencionado",
      "TELEGRAM_CHAT_ID validado"
    ],
    pending: [
      "Conectar alertas a Telegram",
      "Crear comando /mae"
    ],
    ssPlus: [
      "Ubicar carpeta monitor",
      "Leer health-check.mjs",
      "Agregar una variable al .env"
    ]
  },
  {
    name: "EcoVanguard / UX ADHD-Friendly",
    status: "marco estrategico activo",
    progress: [
      "Wise Pipeline documentado",
      "Formato ASCII adoptado"
    ],
    pending: [
      "Convertir proyectos en tablero visual",
      "Definir fichas tipo Trello"
    ],
    ssPlus: [
      "Elegir 1 color por proyecto",
      "Nombrar 1 columna",
      "Guardar 1 referencia visual"
    ]
  },
  {
    name: "Sheldon Bot Finanzas",
    status: "idea pendiente",
    progress: [
      "Idea de persona detectada"
    ],
    pending: [
      "Crear prompt/persona",
      "Evaluar voz ElevenLabs"
    ],
    ssPlus: [
      "Escribir 1 frase de Sheldon",
      "Listar 1 contrato tipo",
      "Decidir si usa voz"
    ]
  }
];

function createSecretaryState() {
  return {
    capturesByChat: new Map(),
    projectsByChat: new Map(),
    profilesByChat: new Map(),
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

function normalizeText(input) {
  return String(input || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function getProjectItems(state, chatId, seedDefaults = true) {
  const key = String(chatId);
  if (!state.projectsByChat.has(key)) {
    state.projectsByChat.set(key, []);
  }

  const projects = state.projectsByChat.get(key);
  if (seedDefaults && projects.length === 0) {
    const now = Date.now();
    DEFAULT_PROJECTS.forEach((project, index) => {
      projects.push({
        ...project,
        updatedAt: new Date(now - index * 60000).toISOString()
      });
    });
  }

  return projects;
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

function updateProject(state, chatId, name, updates = {}) {
  const projects = getProjectItems(state, chatId, false);
  const normalizedName = normalizeText(name);
  let project = projects.find((item) => normalizeText(item.name) === normalizedName);

  if (!project) {
    project = {
      name,
      status: "inbox",
      progress: [],
      pending: [],
      ssPlus: [],
      updatedAt: new Date().toISOString()
    };
    projects.push(project);
  }

  Object.assign(project, updates, {
    name: updates.name || project.name,
    progress: updates.progress || project.progress || [],
    pending: updates.pending || project.pending || [],
    ssPlus: updates.ssPlus || project.ssPlus || [],
    updatedAt: updates.updatedAt || new Date().toISOString()
  });

  return project;
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

function formatDate(isoDate) {
  if (!isoDate) return "sin fecha";
  return String(isoDate).replace("T", " ").slice(0, 16);
}

function formatBullets(items, fallback) {
  if (!items || items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function suggestSSPlus(project) {
  if (project.ssPlus && project.ssPlus.length) return project.ssPlus;
  const pending = (project.pending && project.pending[0]) || "dar el primer paso";
  return [
    "Abrir el lugar donde vive la tarea",
    `Mirar solo esto: ${pending}`,
    "Marcar una microvictoria visible"
  ];
}

function formatProjectsAscii(state, chatId) {
  const projects = [...getProjectItems(state, chatId)]
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  const lines = [
    "```",
    "HERMES / PROYECTOS",
    "==============================",
    "Orden: ultima modificacion",
    ""
  ];

  projects.forEach((project, index) => {
    lines.push(`${index + 1}. ${project.name.toUpperCase()}`);
    lines.push(`Estado: ${project.status || "sin estado"}`);
    lines.push(`Modificado: ${formatDate(project.updatedAt)}`);

    if (index < 3) {
      lines.push("Progreso:");
      lines.push(formatBullets(project.progress, "Aun sin progreso registrado"));
    }

    lines.push("Pendientes:");
    lines.push(formatBullets(project.pending, "Definir el siguiente pendiente"));
    lines.push("SS+:");
    lines.push(formatBullets(suggestSSPlus(project), "Hacer una accion de 30 segundos"));
    lines.push("");
  });

  lines.push("```");
  return lines.join("\n");
}

function resolveProfileId(input) {
  const normalized = normalizeText(input).split(/\s+/).find((token) => PROFILE_ALIASES[token]);
  return normalized ? PROFILE_ALIASES[normalized] : null;
}

function getProfile(state, chatId) {
  const key = String(chatId);
  const profileId = state.profilesByChat.get(key) || "secretario";
  return PROFILES[profileId] || PROFILES.secretario;
}

function setProfile(state, chatId, input) {
  const profileId = resolveProfileId(input) || "secretario";
  state.profilesByChat.set(String(chatId), profileId);
  return getProfile(state, chatId);
}

function formatProfilesAscii(state, chatId) {
  const active = getProfile(state, chatId);
  const lines = [
    "```",
    "HERMES / PERFILES",
    "==============================",
    `Activo: ${active.label}`,
    "",
    ...Object.values(PROFILES).map((profile) => `${profile.label} :: ${profile.purpose}`),
    "",
    "Voz:",
    "Hermes, perfil tecnico",
    "Hermes, modo creativo",
    "```"
  ];
  return lines.join("\n");
}

function detectSecretaryIntent(input) {
  const raw = String(input || "").trim();
  const normalized = normalizeText(raw).replace(/^hermes[\s,:-]*/, "").trim();

  if (!normalized) return null;
  if (/^(proyectos|mis proyectos|tablero|estado de proyectos)\b/.test(normalized)) {
    return { type: "PROJECTS" };
  }
  if (/^(siguiente|siguiente accion|siguiente microaccion|microaccion)\b/.test(normalized)) {
    return { type: "NEXT" };
  }
  if (/^(perfiles|roles|modos)\b/.test(normalized)) {
    return { type: "PROFILES" };
  }
  if (/^(perfil|modo)\b/.test(normalized)) {
    return { type: "SET_PROFILE", profileId: resolveProfileId(normalized) || "secretario" };
  }

  const captureMatch = raw.match(/^(?:hermes[\s,:-]*)?(?:captura|capturar|guarda|guardar)\s+([\s\S]+)/i);
  if (captureMatch) {
    return { type: "CAPTURE", text: captureMatch[1].trim() };
  }

  return null;
}

module.exports = {
  classifyText,
  createSecretaryState,
  addCapture,
  getNextAction,
  formatTodayAscii,
  formatCloseAscii,
  formatCaptureAscii,
  formatProjectsAscii,
  formatProfilesAscii,
  updateProject,
  setProfile,
  getProfile,
  detectSecretaryIntent
};
