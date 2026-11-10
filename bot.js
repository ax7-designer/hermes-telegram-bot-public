require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");
const chalk = require("chalk");
const http = require("http");
const {
  createSecretaryState,
  addCapture,
  getNextAction,
  formatTodayAscii,
  formatCloseAscii,
  formatCaptureAscii,
  formatProjectsAscii,
  formatProfilesAscii,
  formatVoiceStatusAscii,
  setProfile,
  getProfile,
  detectSecretaryIntent
} = require("./secretary");
const {
  isAllowedAction,
  normalizeActionName,
  listAllowedActions
} = require("./safe-actions");
const {
  createBraintrustObservability,
} = require("./braintrust-observability");
const { renderChatPage } = require("./web-chat");

const braintrustObs = createBraintrustObservability();

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const OR_KEY  = process.env.OPENROUTER_API_KEY;
const MODEL   = process.env.HERMES_MODEL || "deepseek-flash";
const ALLOWED = process.env.ALLOWED_USER_ID ? Number(process.env.ALLOWED_USER_ID) : null;
if (!Number.isSafeInteger(ALLOWED) || ALLOWED <= 0) {
  console.error(chalk.red("[AUTH] ALLOWED_USER_ID falta o no es válido; el bot rechazará todos los usuarios."));
}
// Hermes-as-head proxy: OpenAI-compatible endpoint that lets Qoder IDE BYOK (Custom →
// OpenAI Compatible) treat Hermes itself as the model. Enabled ONLY when HERMES_PROXY_TOKEN
// is set; existing deployments without the env var stay byte-identical. Sessions are keyed
// by a virtual chat_id in the range [HERMES_PROXY_CHAT_BASE, +1e6), persisted in the same
// telegram_chat_history table but never surfaced to the real Telegram chat.
const HERMES_PROXY_TOKEN = process.env.HERMES_PROXY_TOKEN || null;
const HERMES_PROXY_CHAT_BASE = Number(process.env.HERMES_PROXY_CHAT_BASE || 9000000001);
// Sliding-window rate limiter on the proxy endpoints (post-auth). Default 60 req/min = 1
// msg/seg sostenidos. Sube a 300 si vas a usar el proxy intensivamente en una ráfaga de
// código. El límite no distingue tokens distintos porque hoy solo hay un token global.
const HERMES_PROXY_RPM = Math.max(1, Number(process.env.HERMES_PROXY_RPM || 60));
const HERMES_PROXY_IP_ALLOWLIST = process.env.HERMES_PROXY_ALLOWED_IPS
  ? new Set(process.env.HERMES_PROXY_ALLOWED_IPS.split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const MAX_HISTORY = 60;
const HTTP_PORT = process.env.PORT || 10000;

// Obsidian vault access (optional — only when OBSIDIAN_VAULT_PATH is set)
const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || null;

function readObsidianFile(relativePath) {
  if (!OBSIDIAN_VAULT_PATH) {
    throw new Error("OBSIDIAN_VAULT_PATH not configured");
  }
  const fullPath = path.join(OBSIDIAN_VAULT_PATH, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }
  return fs.readFileSync(fullPath, "utf-8");
}

function listObsidianFiles(relativePath = "") {
  if (!OBSIDIAN_VAULT_PATH) {
    return [];
  }
  const fullPath = path.join(OBSIDIAN_VAULT_PATH, relativePath);
  if (!fs.existsSync(fullPath)) {
    return [];
  }
  return fs.readdirSync(fullPath).filter((f) => f.endsWith(".md"));
}

// Recursive .md index of the vault (60s cache keeps Telegram replies fast)
let obsidianIndexCache = { at: 0, files: [] };

function collectObsidianMarkdown() {
  if (!OBSIDIAN_VAULT_PATH) return [];
  const now = Date.now();
  if (now - obsidianIndexCache.at < 60000 && obsidianIndexCache.files.length) {
    return obsidianIndexCache.files;
  }
  const files = [];
  const walk = (relDir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(OBSIDIAN_VAULT_PATH, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // .git, .obsidian, .trash
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.toLowerCase().endsWith(".md")) files.push(rel);
    }
  };
  walk("");
  obsidianIndexCache = { at: now, files };
  return files;
}

function resolveObsidianPath(query) {
  if (!OBSIDIAN_VAULT_PATH) return null;
  const clean = String(query || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("..")) return null;
  const root = path.resolve(OBSIDIAN_VAULT_PATH);
  const direct = path.resolve(root, clean.endsWith(".md") ? clean : `${clean}.md`);
  if (!direct.startsWith(root + path.sep)) return null;
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  // Fallback: match by file name anywhere in the vault (shortest path wins)
  const target = clean.toLowerCase().replace(/\.md$/, "");
  const hits = collectObsidianMarkdown()
    .filter((rel) => path.basename(rel, ".md").toLowerCase() === target)
    .sort((a, b) => a.length - b.length);
  return hits.length ? path.resolve(root, hits[0]) : null;
}

function searchObsidianVault(term, maxFiles = 8) {
  const needle = String(term || "").toLowerCase().trim();
  if (!needle || !OBSIDIAN_VAULT_PATH) return [];
  const results = [];
  for (const rel of collectObsidianMarkdown()) {
    let content = "";
    try {
      content = fs.readFileSync(path.join(OBSIDIAN_VAULT_PATH, rel), "utf-8");
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    let idx = lower.indexOf(needle);
    if (idx === -1) continue;
    let total = 0;
    const snippets = [];
    while (idx !== -1) {
      total += 1;
      if (snippets.length < 2) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(content.length, idx + needle.length + 90);
        snippets.push(content.slice(start, end).replace(/\s+/g, " ").trim());
      }
      idx = lower.indexOf(needle, idx + needle.length);
    }
    results.push({ rel, total, snippets });
  }
  return results.sort((a, b) => b.total - a.total).slice(0, maxFiles);
}
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || (TOKEN ? TOKEN.split(":")[1].slice(0, 24) : "bot");
const WEBHOOK_PATH = `/telegram/${WEBHOOK_SECRET}`;
const WEBHOOK_BASE_URL = process.env.TELEGRAM_WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || "";
const USE_TELEGRAM_WEBHOOK = Boolean(WEBHOOK_BASE_URL);
const WEBHOOK_URL = `${WEBHOOK_BASE_URL.replace(/\/$/, "")}${WEBHOOK_PATH}`;

if (!TOKEN || !OR_KEY) {
  console.error(chalk.red("Falta TELEGRAM_BOT_TOKEN o OPENROUTER_API_KEY en el archivo .env"));
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: !USE_TELEGRAM_WEBHOOK });

// ─── Render Health Check Web Server ──────────────────────────────────────────
http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      mode: USE_TELEGRAM_WEBHOOK ? "webhook" : "polling",
      webhookConfigured: USE_TELEGRAM_WEBHOOK,
      braintrust: braintrustObs.enabled ? "enabled" : "disabled"
    }));
  } else if (USE_TELEGRAM_WEBHOOK && req.method === "POST" && req.url === WEBHOOK_PATH) {
    if (req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("FORBIDDEN");
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        bot.processUpdate(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      } catch (err) {
        console.error(chalk.red(`[WEBHOOK ERR] ${err.message}`));
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("BAD REQUEST");
      }
    });
  } else if (req.method === "GET" && (req.url === "/chat" || req.url.startsWith("/chat?"))) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderChatPage({ enabled: Boolean(HERMES_PROXY_TOKEN), model: shortModel(MODEL) }));
  } else if (req.method === "POST" && req.url === "/chat/api/message") {
    if (!HERMES_PROXY_TOKEN) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "web chat disabled: HERMES_PROXY_TOKEN not configured", type: "not_configured" } }));
      return;
    }
    const gate = proxyAuthorize(req);
    if (!gate.ok) {
      res.writeHead(gate.status, { "Content-Type": "application/json", ...(gate.headers || {}) });
      res.end(JSON.stringify(gate.body));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(raw || "{}"); }
      catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid JSON body", type: "bad_request" } }));
      }
      // The web chat reuses the OpenAI proxy's virtual chat range, so history
      // persists per browser session through the same RLS-allowed bucket.
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (!text || text.length > 4000) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "text required (1-4000 chars)", type: "bad_request" } }));
      }
      try {
        const reply = await askAI(proxyChatIdFrom(req), text);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ reply }));
      } catch (err) {
        console.error(chalk.red(`[WEB CHAT ERR] ${err.message}`));
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "chat_error" } }));
      }
    });
  } else if (HERMES_PROXY_TOKEN && req.method === "GET" && req.url.startsWith("/v1/models")) {
    const gate = proxyAuthorize(req);
    if (!gate.ok) {
      res.writeHead(gate.status, { "Content-Type": "application/json", ...(gate.headers || {}) });
      res.end(JSON.stringify(gate.body));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const list = Object.keys(MODELS_CONFIG).map((id) => ({
      id, object: "model", created: now, owned_by: "hermes-proxy",
    }));
    res.writeHead(200, { "Content-Type": "application/json", "X-RateLimit-Limit": String(HERMES_PROXY_RPM), "X-RateLimit-Remaining": String(gate.remaining) });
    res.end(JSON.stringify({ object: "list", data: list }));
  } else if (HERMES_PROXY_TOKEN && req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    const gate = proxyAuthorize(req);
    if (!gate.ok) {
      res.writeHead(gate.status, { "Content-Type": "application/json", ...(gate.headers || {}) });
      res.end(JSON.stringify(gate.body));
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        await handleHermesProxy(req, res, body);
      } catch (err) {
        console.error(chalk.red(`[PROXY ERR] ${err.message}`));
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: err.message, type: "hermes_proxy_error" } }));
        }
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(HTTP_PORT, () => {
  console.log(chalk.yellow(`[HTTP] Servidor activo en puerto ${HTTP_PORT} (${USE_TELEGRAM_WEBHOOK ? "webhook" : "polling"})`));
  if (HERMES_PROXY_TOKEN) {
    console.log(chalk.cyan(`[HTTP][PROXY] OpenAI-compatible endpoint habilitado en /v1/chat/completions y /v1/models (virtual chat base ${HERMES_PROXY_CHAT_BASE})`));
    console.log(chalk.cyan(`[HTTP][PROXY] rate limit: ${HERMES_PROXY_RPM} req/min · ip allowlist: ${HERMES_PROXY_IP_ALLOWLIST ? [...HERMES_PROXY_IP_ALLOWLIST].join(",") : "disabled"}`));
  } else {
    console.log(chalk.gray(`[HTTP][PROXY] deshabilitado (falta HERMES_PROXY_TOKEN)`));
  }
});


// OpenRouter Client (for Claude and Qwen)
const openai = new OpenAI({
  apiKey: OR_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/ax7/hermes-telegram-bot",
    "X-Title": "Qwen/Gemini Telegram Bot (ax7.createga)",
  },
});

// Native DeepSeek Client (direct API — OpenAI-compatible, billed off DeepSeek's own balance)
// Env: DEEPSEEK_API_KEY. When absent, DeepSeek routes and panel buttons are hidden so existing
// OpenRouter/Gemini behavior is unchanged.
const DS_KEY = process.env.DEEPSEEK_API_KEY;
const deepseekClient = DS_KEY ? new OpenAI({
  apiKey: DS_KEY,
  baseURL: "https://api.deepseek.com",
}) : null;
// Braintrust wraps the DeepSeek client directly. It records traces asynchronously and
// does not proxy inference traffic, so DeepSeek remains the sole billing authority.
const deepseek = deepseekClient ? braintrustObs.wrapClient(deepseekClient) : null;
function isDeepSeekModel(modelId) {
  return typeof modelId === "string" && modelId.startsWith("deepseek-");
}
function clientFor(modelId) {
  if (isDeepSeekModel(modelId)) {
    if (!deepseek) throw new Error("DEEPSEEK_API_KEY no está configurado en .env");
    return deepseek;
  }
  return openai;
}

// Native Google AI Studio Client (for 100% Free Gemini Routing)
const googleGenAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// Native Supabase Client (for Chat History Persistence)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// ─── System Prompt (Spanish & ax7.createga Synergy) ───────────────────────────
const SYSTEM_PROMPT = `Eres el asistente de inteligencia artificial definitivo de ax7 para su proyecto y marca personal "ax7.createga". 
Te comunicas exclusivamente en ESPAÑOL, con un tono sofisticado, directo, altamente analítico y adaptado al diseño multimedia y la estrategia digital vanguardista.

PERFIL DEL USUARIO (ax7):
- Nombre: ax7
- Profesión: Diseñador Multimedia y Estratega Digital.
- Intereses: Sinergia entre agentes IA (Gemini, Goose, Hermes, Claude), UI/UX de vanguardia (Luxury Dark, Glassmorphism, diseños orgánicos/fluidos) y optimización de tokens.
- Flujo de Trabajo: "The Wise Pipeline" (orquestación multi-modelo para conservación de créditos y máxima eficiencia).
- Perfil Cognitivo: TDAH (ADHD) Friendly. Requiere alta claridad visual, segmentación clara, respuestas estructuradas y feedback interactivo y estimulante.
- Creencias Clave: 
  * La IA debe ser un compañero autónomo y proactivo (Agente), no una simple herramienta de chat.
  * El marketing estratégico y el multimedia técnico son inseparables.

MÚSCULO ESTRATÉGICO Y CONOCIMIENTO (ax7.createga):
Tienes integrados los principios fundamentales del marketing de conversión y ventas del proyecto ax7.createga (extraídos del conocimiento estructurado del proyecto):
1. **Los 6 Detonantes del "SÍ" del Cliente**:
   - *Dolor/Urgencia*: Resolver problemas críticos inmediatos (el dolor de muelas).
   - *Aprobación Social*: Mostrar el círculo social y los resultados de otros.
   - *Educación (Marketing Educativo)*: Enseñar con valor simplificado para generar confianza y empatía.
   - *Reciprocidad (Cialdini)*: Aportar tanto valor genuino que el cliente sienta la necesidad natural de corresponder.
   - *Resultados Visibles*: Entrevistas y testimonios con números y transformaciones reales de antes y después.
   - *Conveniencia + Escasez*: Crear ofertas de alto valor agregado (con bonus/garantías potentes) limitadas por tiempo o stock.
2. **Las 6 Estrategias contra el "Lo voy a pensar"**:
   - Auditar el proceso de ventas para eliminar fricciones y responder rápido con coherencia.
   - Mostrar precios honestos y transparentes desde el inicio para madurar la oferta.
   - Entregar información completa y ultra-clara (el cliente debe llegar al 90% convencido por sí mismo).
   - Ofrecer garantías totales de satisfacción que disuelvan el riesgo.
   - Hacer sentir el costo de la inacción o de la oportunidad perdida.
   - Demostrar pruebas y testimonios irrefutables.
3. **Optimización de Nichos de Mercado**:
   - Enfoque vertical: Generar transformación, no solo viralidad.
   - Resolver un problema específico para un grupo preciso (ser el rey del nicho).
   - Especialización en productos de alta demanda basada en análisis riguroso de la competencia.

REGLAS DE INTERACCIÓN (Estilo Mobile y ADHD-Friendly):
1. **Claridad Extrema y Formato**: Utiliza negritas (**bold**), bloques de código (\`code\`), listas numeradas y viñetas limpias. Separa las ideas con espacios en blanco abundantes para no abrumar visualmente a ax7.
2. **Concisión**: En Telegram la pantalla es pequeña. Ve directo al grano, elimina la palabrería innecesaria y aporta valor inmediato.
3. **Agente Proactivo**: Sugiere el siguiente paso lógico. Haz preguntas de clarificación cortas y estimulantes. Actúa con la autonomía e iniciativa de un co-creador estratega.
4. **Idioma**: Responde siempre en español fluido, natural y con excelente ortografía.`;

const DIRECTOR_DIRECTIVE = `
────────────────────────────────────────────────────────────────
🎬 MODO ACTIVO: DIRECTOR DE CONTENIDO HÍBRIDO (ax7.createga)
────────────────────────────────────────────────────────────────
Tu misión es transformar notas de voz, ideas de video o conceptos de ax7 en GUIONES DE PRODUCCIÓN HÍBRIDOS (Grabación Humana + Activos IA / UI) de alto impacto.

REGLAS DE FORMATO (ADHD-Friendly, sin paja, listo para producción):
Cada vez que ax7 envíe una idea o hable sobre video/contenido, responde con la siguiente estructura limpia y segmentada:

1. 🎯 ÁNGULO & GANCHO CONCEPTUAL:
   • Dolor o deseo específico que ataca (Los 6 Detonantes del "SÍ").
   • Objetivo de conversión hacia el sitio web (maewellnessclub.com.mx o landing).

2. 📋 GUION TÉCNICO EN TABLA DE TIEMPOS (30-60s):
   Segmenta el video en 4 bloques:
   • [0:00 - 0:03] HOOK: Frase verbal exacta + estímulo visual de corte rápido.
   • [0:03 - 0:15] A-ROLL (ax7): Presencia humana en cámara/voz (empatía, autoridad, revelación).
   • [0:15 - 0:40] B-ROLL / IA / UI: Capturas del sitio web, interfaz Luxury Dark/Glassmorphism, o animaciones sintéticas.
   • [0:40 - 0:50] CTA (Llamado a la acción): Indicación clara para probar el sitio web o interactuar.

3. 🧪 HIPÓTESIS DE PRUEBA EN EL SITIO:
   • Qué elemento del sitio web (landing, registro, pricing, demo) medirá la respuesta de esta pieza.

4. 📦 LISTA DE ASSETS A PREPARAR:
   • Grabación de ax7 (toma A-Roll requerida).
   • Prompts / Capturas de pantalla necesarias para el B-Roll IA.
`;

function getEffectiveSystemPrompt(chatId) {
  if (!chatId) return SYSTEM_PROMPT;
  try {
    const profile = getProfile(secretaryState, chatId);
    if (profile && profile.id === "director") {
      return `${SYSTEM_PROMPT}\n\n${DIRECTOR_DIRECTIVE}`;
    }
  } catch {
    // Fallback seguro a SYSTEM_PROMPT base
  }
  return SYSTEM_PROMPT;
}

// ─── Hermes Feedback Bitácora ──────────────────────────────────────────────────
const HERMES_LEARNING_NOTES = [
  "DPO (Direct Preference Optimization): Hermes se pule eliminando intermediarios. En lugar de usar RLHF tradicional que entrena un modelo de recompensa complejo, se utiliza DPO para optimizar directamente la probabilidad de respuestas preferidas sobre las rechazadas.",
  "Generación de Datos Sintéticos: El combustible de Hermes es sintético pero de altísima pureza. Nous Research utiliza arquitecturas avanzadas para que modelos de gran tamaño generen y filtren instrucciones complejas de programación y lógica, creando datasets masivos libres de sesgos humanos.",
  "Agentic Workflows: Hermes 3 fue diseñado desde el núcleo para el uso de herramientas (Tool Calling) y razonamiento agéntico. Su entrenamiento incluye datasets masivos de llamadas de funciones en formato JSON, permitiéndole coordinar subagentes con precisión.",
  "Retroalimentación por IA (RLAF): A diferencia del feedback humano tradicional, Hermes aprovecha el RLAF. Modelos jueces evalúan la coherencia y precisión de las respuestas del modelo base, iterando miles de veces en ciclos automatizados de mejora continua.",
  "Doma de la Alucinación (System Prompt Jailbreak Resistance): Nous Research entrena a Hermes para respetar de forma implacable el rol del System Prompt. Utilizan técnicas de inyección adversarial durante el ajuste de instrucciones para que el modelo nunca rompa su personaje.",
  "Razonamiento Estructurado (CoT - Chain of Thought): Hermes aprende a 'pensar antes de hablar'. En lugar de saltar a la respuesta final, es entrenado para desglosar problemas en sub-tareas lógicas paso a paso, aumentando drásticamente la tasa de acierto en matemáticas y código.",
  "Evolución Abierta (Open-Source Core): El ecosistema Hermes se retroalimenta de la comunidad global. A través de plataformas abiertas, Nous recopila fallos del modelo real (failures) en casos de uso complejos de código y los utiliza para enriquecer la siguiente iteración.",
  "Representación de Identidad: Hermes sabe quién es. Su alineación de personalidad le permite mantener una autoconciencia clara de su arquitectura (Llama-based) sin pretender ser un bot genérico de OpenAI o Google, mejorando la transparencia.",
  "Curación Multilingüe Avanzada: En su última versión, Hermes expió su retroalimentación a múltiples lenguas estructurando equivalencias conceptuales. No solo traduce de forma literal; aprende los giros lingüísticos específicos del desarrollo digital y marketing internacional."
];

function getRandomHermesNote() {
  const idx = Math.floor(Math.random() * HERMES_LEARNING_NOTES.length);
  return HERMES_LEARNING_NOTES[idx];
}

// ─── Voice Note Helpers ────────────────────────────────────────────────────────
async function getVoiceBuffer(fileId) {
  const fileLink = await bot.getFileLink(fileId);
  const res = await fetch(fileLink);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function transcribeAudio(audioBuffer) {
  if (!googleGenAI) {
    throw new Error("GEMINI_API_KEY no está configurada para transcripción.");
  }
  const model = googleGenAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  
  const result = await model.generateContent([
    {
      inlineData: {
        data: audioBuffer.toString("base64"),
        mimeType: "audio/ogg"
      }
    },
    "Transcribe este audio con absoluta precisión. Devuelve ÚNICAMENTE el texto de la transcripción, sin introducciones ni explicaciones de ningún tipo."
  ]);
  
  return result.response.text().trim();
}


// ─── Plan A: Model Configurations & Hardcoded Pricing (per 1M tokens) ──────────
const MODELS_CONFIG = {
  "qwen/qwen3-max": {
    name: "Qwen 3 Max (Estrategia y Razonamiento)",
    short: "Qwen 3 Max",
    inputPrice: 0.78,
    outputPrice: 3.90
  },
  "anthropic/claude-sonnet-4.6": {
    name: "Claude Code / Sonnet 4.6 (Desarrollo y Código)",
    short: "Claude Sonnet 4.6",
    inputPrice: 3.00,
    outputPrice: 15.00
  },
  "google/gemini-2.5-flash": {
    name: "Gemini 2.5 Flash (Directo - Gratis/Google Premium)",
    short: "Gemini 2.5 Flash (GRATIS)",
    inputPrice: 0.00,
    outputPrice: 0.00
  },
  "qwen/qwen3-coder-next": {
    name: "Qwen 3 Coder Next (Código y Automatización)",
    short: "Qwen 3 Coder",
    inputPrice: 0.11,
    outputPrice: 0.80
  },
  // Direct DeepSeek routes — billed off DeepSeek balance, not OpenRouter.
  // Prices below are OFF-PEAK per 1M tokens (peak is 2×; peak hours: 01-04 UTC y 06-10 UTC Lun-Vie).
  // Source: https://api-docs.deepseek.com/quick_start/pricing (consultado 2026-11-06)
  "deepseek-flash": {
    name: "DeepSeek Flash V4.1 (Directo · off-peak $0.15/$0.60)",
    short: "DeepSeek Flash",
    inputPrice: 0.15,
    outputPrice: 0.60
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro (Directo · off-peak $0.66/$1.98)",
    short: "DeepSeek V4 Pro",
    inputPrice: 0.66,
    outputPrice: 1.98
  }
};

// State for active model per chat
const activeModels = new Map();
const secretaryState = createSecretaryState();

function getModelConfig(chatId) {
  const modelId = activeModels.get(chatId) || MODEL;
  return MODELS_CONFIG[modelId] || {
    name: shortModel(modelId),
    short: shortModel(modelId),
    inputPrice: 0.40,
    outputPrice: 1.20
  };
}

// ─── Persistent Chat History State (Supabase + Local Cache) ──────────────────
const conversations = new Map();

function trimHistory(history) {
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

async function loadHistory(chatId) {
  if (conversations.has(chatId)) {
    return conversations.get(chatId);
  }
  
  if (supabase) {
    try {
      console.log(chalk.gray(`[DB] Buscando historial para chat ${chatId} en Supabase...`));
      const { data, error } = await supabase
        .from('telegram_chat_history')
        .select('history')
        .eq('chat_id', chatId)
        .maybeSingle();
      
      if (data && data.history) {
        console.log(chalk.green(`[DB] Historial cargado (${data.history.length} mensajes)`));
        conversations.set(chatId, data.history);
        return data.history;
      }
    } catch (err) {
      console.error(chalk.red(`[DB ERROR] No se pudo cargar historial: ${err.message}`));
    }
  }
  
  conversations.set(chatId, []);
  return [];
}

async function saveHistory(chatId, history) {
  conversations.set(chatId, history);
  if (supabase) {
    try {
      const { error } = await supabase
        .from('telegram_chat_history')
        .upsert({ 
          chat_id: chatId, 
          history: history, 
          updated_at: new Date().toISOString() 
        });
      if (error) throw error;
    } catch (err) {
      console.error(chalk.red(`[DB ERROR] No se pudo guardar historial: ${err.message}`));
    }
  }
}

// ─── Auth guard ───────────────────────────────────────────────────────────────
function isAllowed(userId) {
  return Number.isSafeInteger(ALLOWED) && ALLOWED > 0 && userId === ALLOWED;
}

function onAuthorizedText(regex, handler) {
  bot.onText(regex, async (msg, match) => {
    if (!isAllowed(msg.from?.id)) return;
    await handler(msg, match);
  });
}

// ─── OpenRouter Credits Tracker ───────────────────────────────────────────────
async function fetchBalance() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${OR_KEY}`
      }
    });
    const json = await res.json();
    if (json && json.data) {
      const remaining = json.data.total_credits - json.data.total_usage;
      return `$${remaining.toFixed(4)}`;
    }
  } catch (err) {
    console.error("Error obteniendo creditos de OpenRouter:", err.message);
  } finally {
    clearTimeout(timeout);
  }

  return "N/A";
}

// ─── DeepSeek direct-API balance (only used when DS_KEY is set) ────────────────────
// Docs: GET https://api.deepseek.com/user/balance with Authorization: Bearer <key>
// Response shape (2026-11-06): { is_available: true, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }. Older docs used is_balance_set / balance_info; we accept either.
// DeepSeek consumes granted_balance FIRST; topped_up_balance is the money the user actually paid.
async function getDSBalanceRaw({ recordSnapshot = true } = {}) {
  if (!DS_KEY) return { ok: false, reason: "no_key" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${DS_KEY}` },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, httpStatus: res.status };
    const json = await res.json();
    const available = json && (json.is_available === true || json.is_balance_set === true);
    if (!available) return { ok: false, reason: "balance_unavailable", raw: json };
    const list = Array.isArray(json.balance_infos) ? json.balance_infos
               : Array.isArray(json.balance_info) ? json.balance_info : null;
    if (!list || list.length === 0) return { ok: false, reason: "no_balance_infos", raw: json };
    const info = list[0];
    const toNum = (v) => (v == null ? null : Number(v));
    const result = {
      ok: true,
      currency: info.currency || "USD",
      totalBalance: toNum(info.total_balance),
      grantedBalance: toNum(info.granted_balance),
      toppedUpBalance: toNum(info.topped_up_balance),
      fetchedAt: new Date().toISOString(),
    };
    if (recordSnapshot) {
      void braintrustObs.recordDeepSeekBalance(result, { source: "balance_fetch" });
    }
    return result;
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  } finally {
    clearTimeout(timeout);
  }
}

const BRAINTRUST_BALANCE_REFRESH_MS = (() => {
  const configured = Number(process.env.BRAINTRUST_BALANCE_REFRESH_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 6 * 60 * 60 * 1000;
})();
let braintrustBalanceSnapshotInFlight = false;

async function refreshBraintrustBalanceSnapshot() {
  if (!braintrustObs.enabled || !DS_KEY || braintrustBalanceSnapshotInFlight) return;
  braintrustBalanceSnapshotInFlight = true;
  try {
    const balance = await getDSBalanceRaw({ recordSnapshot: false });
    await braintrustObs.recordDeepSeekBalance(balance, { source: "scheduled", force: true });
  } catch (err) {
    console.error(chalk.yellow(`[BRAINTRUST] balance refresh failed: ${err.message}`));
  } finally {
    braintrustBalanceSnapshotInFlight = false;
  }
}

if (braintrustObs.enabled && DS_KEY) {
  setTimeout(() => void refreshBraintrustBalanceSnapshot(), 10_000).unref?.();
  setInterval(() => void refreshBraintrustBalanceSnapshot(), BRAINTRUST_BALANCE_REFRESH_MS).unref?.();
}

async function fetchDSBalance() {
  if (!DS_KEY) return null;
  const r = await getDSBalanceRaw();
  if (!r.ok) {
    if (r.httpStatus) return `HTTP ${r.httpStatus}`;
    return r.reason === "balance_not_set" ? "(sin saldo aún)" : "N/A";
  }
  return `$${(r.totalBalance ?? 0).toFixed(4)} ${r.currency}`;
}

// USD originally invested by the user. Used by /gasto to compute the real burn rate
// against DeepSeek's topped_up_balance (which excludes any granted credit).
const DS_INVESTED_USD = Number(process.env.DEEPSEEK_INVESTED_USD || 0);

function formatGasto(bal, invested) {
  if (!bal.ok) {
    return `\u26a0\ufe0f No pude consultar el saldo DeepSeek: \`${bal.reason}\`.` +
      (bal.httpStatus === 401 ? "\n\nRevisa que la API key est\u00e9 bien pegada en `.env`." : "");
  }
  const spentOwn = invested > 0 ? (invested - (bal.toppedUpBalance ?? 0)) : null;
  const spentPct = invested > 0 && spentOwn != null
    ? Math.max(0, Math.min(100, (spentOwn / invested) * 100))
    : null;
  const ccy = bal.currency;
  let s = `\ud83d\udcb0 *Gasto DeepSeek* (off-peak, flash)\n\n`;
  s += `\u2022 Invertido (top-up): \`${invested > 0 ? `$${invested.toFixed(2)}` : "desconocido"} ${ccy}\`\n`;
  s += `\u2022 Saldo disponible total: \`$${(bal.totalBalance ?? 0).toFixed(4)} ${ccy}\`\n`;
  s += `  \u2013 De tu bolsillo (topped_up): \`$${(bal.toppedUpBalance ?? 0).toFixed(4)} ${ccy}\`\n`;
  s += `  \u2013 De regalo (granted): \`$${(bal.grantedBalance ?? 0).toFixed(4)} ${ccy}\`\n`;
  if (spentOwn !== null && spentOwn >= 0) {
    s += `\u2022 *Gastado de tu bolsillo:* \`$${spentOwn.toFixed(4)} ${ccy}\``;
    if (spentPct !== null) s += ` \`(${spentPct.toFixed(1)}%)\``;
    s += `\n`;
  }
  if (bal.totalBalance != null) {
    const tokensAvail = Math.floor((bal.totalBalance / 0.60) * 1000000);
    const rafagasAvail = Math.floor(tokensAvail / 500000);
    s += `\u2022 Runway a flash off-peak: ~\`${tokensAvail.toLocaleString("en-US")}\` tokens de salida \u2192 ~\`${rafagasAvail}\` r\u00e1fagas de 500K\n`;
  }
  s += `\n_\u00daltima lectura: \`${bal.fetchedAt}\` \u00b7 Fuente: \`/user/balance\`_`;
  if (invested === 0) {
    s += `\n\n_Para calcular % gastado: define_ \`DEEPSEEK_INVESTED_USD=15\` _en_ \`.env\` _y reinicia el bot._`;
  }
  return s;
}

function buildBalanceLines(orStr, dsStr) {
  let s = `• *Saldo OpenRouter:* \`${orStr}\`\n`;
  if (dsStr !== null) s += `• *Saldo DeepSeek:*  \`${dsStr}\`\n`;
  return s + "\n";
}

// ─── Per-source USD spend attribution (hermes_proxy_usage) ───────────────────
// Append-only metric so /gasto can split burn by 'telegram' vs 'proxy' (Qoder).
// Fully best-effort: if the table is absent (proxy_usage.sql not applied yet) the
// insert/select fail quietly and nothing else changes. estUsd uses MODELS_CONFIG
// list prices; the authoritative total remains DeepSeek /user/balance.
async function recordUsage({ source, chatId, modelId, promptTokens = 0, completionTokens = 0, estUsd = 0, estimated = false }) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from("hermes_proxy_usage").insert({
      source,
      chat_id: chatId ?? null,
      model_id: modelId ?? null,
      prompt_tokens: Math.round(promptTokens) || 0,
      completion_tokens: Math.round(completionTokens) || 0,
      est_usd: Number(estUsd) || 0,
      estimated: !!estimated,
    });
    if (error) throw error;
  } catch (err) {
    console.error(chalk.gray(`[USAGE] registro omitido (¿falta proxy_usage.sql?): ${err.message}`));
  }
}

function usageCost(cfg, usage) {
  if (!cfg || !usage) return 0;
  return ((usage.prompt_tokens || 0) / 1e6) * (cfg.inputPrice || 0)
       + ((usage.completion_tokens || 0) / 1e6) * (cfg.outputPrice || 0);
}

async function fetchTodayUsageBreakdown() {
  if (!supabase) return null;
  try {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const { data, error } = await supabase
      .from("hermes_proxy_usage")
      .select("source, est_usd, prompt_tokens, completion_tokens, estimated")
      .gte("created_at", since.toISOString());
    if (error) return null; // table not created yet → caller omits the section
    const agg = {};
    for (const r of (data || [])) {
      const k = r.source || "unknown";
      agg[k] = agg[k] || { usd: 0, reqs: 0, tokens: 0, anyEst: false };
      agg[k].usd += Number(r.est_usd) || 0;
      agg[k].reqs += 1;
      agg[k].tokens += (Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0);
      if (r.estimated) agg[k].anyEst = true;
    }
    return { rows: data || [], agg, since: since.toISOString() };
  } catch (_) {
    return null;
  }
}


// ─── Core AI Router (Dual Engine: Google Native SDK / OpenRouter API) ────────
async function askAI(chatId, userMessage) {
  const history = await loadHistory(chatId);
  let modelId = activeModels.get(chatId) || MODEL;
  
  // Normalizar IDs antiguos
  if (modelId === "google/gemini-3.1-pro-preview") {
    modelId = "google/gemini-2.5-flash";
    activeModels.set(chatId, "google/gemini-2.5-flash");
  }

  const config = getModelConfig(chatId);

  // 1. Google Native SDK Execution Path (100% Free Gemini Routing with Silent Fallback)
  if (modelId === "google/gemini-2.5-flash" && googleGenAI) {
    try {
      console.log(chalk.blue("🤖 Intentando llamada directa a Google Gemini 2.5 Flash..."));
      
      const geminiModel = googleGenAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        systemInstruction: getEffectiveSystemPrompt(chatId)
      });

      const googleHistory = history.map(h => ({
        role: h.role === "assistant" ? "model" : "user",
        parts: [{ text: h.content }]
      }));

      const chat = geminiModel.startChat({
        history: googleHistory
      });

      const result = await chat.sendMessage(userMessage);
      const replyText = result.response.text() || "_(sin respuesta)_";

      // Guardar en el historial persistente de Supabase
      history.push({ role: "user", content: userMessage });
      history.push({ role: "assistant", content: replyText });
      trimHistory(history);
      await saveHistory(chatId, history);

      const balanceStr = await fetchBalance();
      const hermesNote = getRandomHermesNote();

      const footer = `\n\n` +
                     `─── *THE WISE PIPELINE (FREE)* ───\n` +
                     `💳 *Saldo OR:* \`${balanceStr}\` | 🪙 *Costo msg:* \`$0.000000 (Google Direct)\`\n` +
                     `🤖 *Modelo:* \`Gemini 2.5 Flash (Directo)\`\n` +
                     `🧠 *Bitácora Hermes:* _${hermesNote}_`;

      return replyText + footer;
    } catch (err) {
      console.error(chalk.yellow(`⚠️ Fallo en Gemini Nativo (${err.message}). Ejecutando fallback silencioso a OpenRouter...`));
    }
  }

  // 2. OpenRouter Execution Path (Qwen/Claude, o Fallback Activo de Gemini)
  const primaryModelId = (modelId === "google/gemini-2.5-flash") ? "qwen/qwen3-coder-next" : modelId;
  let finalModelId = primaryModelId;
  let finalConfig = MODELS_CONFIG[finalModelId] || config;
  let deepSeekFailed = false;

  console.log(chalk.blue(`🤖 Ejecutando enrutamiento OpenRouter/DeepSeek con modelo: ${finalModelId}...`));

  history.push({ role: "user", content: userMessage });
  trimHistory(history);

  const messages = [
    { role: "system", content: getEffectiveSystemPrompt(chatId) },
    ...history,
  ];

  const sdkParams = {
    model: finalModelId,
    messages,
    max_tokens: 1536,
    temperature: 0.7,
  };

  let response;
  try {
    response = await clientFor(finalModelId).chat.completions.create(sdkParams);
  } catch (err) {
    // Fallback silencioso para DeepSeek 5xx/429 → OpenRouter Qwen Coder (asimetría con
    // el proxy HTTP en handleHermesProxy, que ya hace lo mismo). Si el fallback también
    // falla, propagar.
    const status = err?.status || err?.response?.status || 0;
    const looksUpstream = status >= 500 || status === 429 || /5\d\d|timeout|ETIMEDOUT|ENOTFOUND/i.test(String(err?.message || ""));
    if (isDeepSeekModel(finalModelId) && looksUpstream) {
      console.error(chalk.yellow(`⚠️ DeepSeek ${status || "?"} (${err.message}). Fallback silencioso a qwen/qwen3-coder-next...`));
      finalModelId = "qwen/qwen3-coder-next";
      finalConfig = MODELS_CONFIG[finalModelId];
      deepSeekFailed = true;
      response = await openai.chat.completions.create({ ...sdkParams, model: finalModelId });
    } else {
      throw err;
    }
  }

  const replyText = response.choices[0]?.message?.content || "_(sin respuesta)_";
  history.push({ role: "assistant", content: replyText });
  trimHistory(history);
  await saveHistory(chatId, history);

  let costStr = "N/A";
  if (response.usage) {
    const inputCost = (response.usage.prompt_tokens / 1000000) * finalConfig.inputPrice;
    const outputCost = (response.usage.completion_tokens / 1000000) * finalConfig.outputPrice;
    const totalCost = inputCost + outputCost;
    costStr = `$${totalCost.toFixed(6)}`;
    recordUsage({
      source: "telegram",
      chatId,
      modelId: finalModelId,
      promptTokens: response.usage.prompt_tokens,
      completionTokens: response.usage.completion_tokens,
      estUsd: totalCost,
    });
  }

  const balanceStr = await fetchBalance();
  const dsBalanceStr = isDeepSeekModel(finalModelId) ? await fetchDSBalance() : null;
  const balanceLabel = dsBalanceStr ? `💳 *Saldo DS:* \`${dsBalanceStr}\`` : `💳 *Saldo OR:* \`${balanceStr}\``;
  const hermesNote = getRandomHermesNote();

  const wasGeminiFallback = (modelId === "google/gemini-2.5-flash");
  const wasFallback = wasGeminiFallback || deepSeekFailed;
  const headerBar = wasFallback ? `─── *THE WISE PIPELINE (FALLBACK ACTIVE)* ───` : `─── *THE WISE PIPELINE* ───`;
  const fallbackTag = wasGeminiFallback
    ? ' ⚠️ (Quota limit - Fallback a Qwen)'
    : deepSeekFailed ? ' ⚠️ (DeepSeek 5xx - Fallback a Qwen Coder)' : '';

  const footer = `\n\n` +
                 `${headerBar}\n` +
                 `${balanceLabel} | 🪙 *Costo msg:* \`${costStr}\`\n` +
                 `🤖 *Modelo:* \`${finalConfig.short}\`${fallbackTag}\n` +
                 `🧠 *Bitácora Hermes:* _${hermesNote}_`;

  return replyText + footer;
}

// ─── Hermes-as-head proxy: OpenAI-compatible completions handler ─────────
// Enabled when HERMES_PROXY_TOKEN is set. Qoder IDE BYOK (Custom → OpenAI Compatible)
// points at `http://localhost:10000/v1` (local) or the Render URL + /v1 (cloud), and its
// API key = HERMES_PROXY_TOKEN. Then whatever model is active on Hermes' Telegram panel
// becomes literally the model Qoder talks to — DeepSeek, Qwen, Claude and the fallback
// routes all reachable through the same clientFor() dispatcher. History persists to
// Supabase under a virtual chat_id so the Qoder session has continuity across restarts,
// but it never leaks into the real Telegram chat.
// Sliding-window rate limiter + bearer auth + optional IP allowlist for the proxy.
// Returns `{ ok: true, remaining }` or `{ ok: false, status, body, headers }` ready to
// write. Requests are tracked in one global bucket because today we only support a
// single HERMES_PROXY_TOKEN — if we ever split per-user, key the array by bearer hash.
const proxyRecentRequests = [];
function extractProxyIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}
function proxyAuthorize(req) {
  const authHeader = req.headers["authorization"] || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (bearer !== HERMES_PROXY_TOKEN) {
    return { ok: false, status: 401, body: { error: { message: "invalid proxy token", type: "auth_error" } } };
  }
  if (HERMES_PROXY_IP_ALLOWLIST) {
    const ip = extractProxyIp(req);
    // localhost in IPv4/IPv6 is always allowed to keep local dev friction low
    const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLocal && !HERMES_PROXY_IP_ALLOWLIST.has(ip)) {
      return { ok: false, status: 403, body: { error: { message: `ip ${ip} not in HERMES_PROXY_ALLOWED_IPS`, type: "ip_denied" } } };
    }
  }
  const now = Date.now();
  const windowMs = 60_000;
  while (proxyRecentRequests.length && proxyRecentRequests[0] < now - windowMs) {
    proxyRecentRequests.shift();
  }
  if (proxyRecentRequests.length >= HERMES_PROXY_RPM) {
    const retryAfterSec = Math.max(1, Math.ceil((proxyRecentRequests[0] + windowMs - now) / 1000));
    console.warn(chalk.yellow(`[PROXY RL] 429 rate limited, retry-after ${retryAfterSec}s`));
    return {
      ok: false,
      status: 429,
      headers: { "Retry-After": String(retryAfterSec), "X-RateLimit-Limit": String(HERMES_PROXY_RPM), "X-RateLimit-Remaining": "0" },
      body: { error: { message: `rate limited: ${HERMES_PROXY_RPM} req/min`, type: "rate_limited", retry_after_seconds: retryAfterSec } },
    };
  }
  proxyRecentRequests.push(now);
  return { ok: true, remaining: Math.max(0, HERMES_PROXY_RPM - proxyRecentRequests.length) };
}

function proxyChatIdFrom(req) {
  const sid = req.headers["x-hermes-session-id"];
  if (!sid) return HERMES_PROXY_CHAT_BASE;
  // FNV-1a 32-bit, folded into the virtual range. Different Qoder conversation windows
  // (each with its own X-Hermes-Session-Id) get their own history bucket.
  let h = 2166136261;
  for (let i = 0; i < sid.length; i++) {
    h ^= sid.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return HERMES_PROXY_CHAT_BASE + (h % 1000000);
}

async function handleHermesProxy(req, res, rawBody) {
  let parsed;
  try { parsed = JSON.parse(rawBody || "{}"); }
  catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `invalid JSON body: ${e.message}` } }));
  }
  const inMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (inMessages.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "messages[] is required" } }));
  }
  if (parsed.stream && typeof parsed.stream !== "boolean") {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "stream must be boolean" } }));
  }
  // If we're in stream mode and the caller's client doesn't send Accept: text/event-stream,
  // we still honor it — Qoder BYOK sometimes omits the header and expects chunked SSE anyway.

  const virtualChatId = proxyChatIdFrom(req);
  // Explicit model in the body wins if we know it. Otherwise fall through to whatever
  // the Telegram panel currently has selected for this virtual chat (defaults to MODEL).
  const requested = parsed.model;
  let modelId = (requested && MODELS_CONFIG[requested]) ? requested : (activeModels.get(virtualChatId) || MODEL);
  if (!MODELS_CONFIG[modelId]) modelId = MODEL;
  if (modelId === "google/gemini-3.1-pro-preview") modelId = "google/gemini-2.5-flash";

  const lastUser = [...inMessages].reverse().find((m) => m && m.role === "user");
  const userText = typeof lastUser?.content === "string"
    ? lastUser.content
    : Array.isArray(lastUser?.content)
      ? lastUser.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")
      : "";
  if (!userText) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "no user text content in messages[]" } }));
  }

  const history = await loadHistory(virtualChatId);
  history.push({ role: "user", content: userText });
  trimHistory(history);

  const outbound = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
  ];

  const params = {
    model: modelId,
    messages: outbound,
    max_tokens: parsed.max_tokens || 1536,
    temperature: typeof parsed.temperature === "number" ? parsed.temperature : 0.7,
  };

  // ── Streaming branch: OpenAI-compatible Server-Sent Events ─────────────────
  if (parsed.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const created = Math.floor(Date.now() / 1000);
    const sendChunk = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };
    const firstChunkMeta = {
      id: `hermes_${Date.now()}`,
      object: "chat.completion.chunk",
      created,
      model: modelId,
    };
    // Emit the initial role-delta so strict OpenAI clients can allocate choice 0
    sendChunk({ ...firstChunkMeta, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

    let stream;
    let finalModelId = modelId;
    try {
      stream = await clientFor(modelId).chat.completions.create({ ...params, stream: true });
    } catch (err) {
      const status = err?.status || err?.response?.status || 0;
      const looksUpstream = status >= 500 || status === 429 || /5\d\d|timeout|ETIMEDOUT/i.test(String(err?.message || ""));
      if (isDeepSeekModel(modelId) && looksUpstream) {
        console.error(chalk.yellow(`[PROXY STREAM] DeepSeek ${status || "?"} → fallback qwen/qwen3-coder-next (single-chunk)`));
        finalModelId = "qwen/qwen3-coder-next";
        let full;
        try {
          full = await openai.chat.completions.create({ ...params, model: finalModelId });
        } catch (err2) {
          sendChunk({ ...firstChunkMeta, model: finalModelId, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        const fallbackMessage = full.choices?.[0]?.message || {};
        const text = fallbackMessage.content || fallbackMessage.reasoning_content || "";
        sendChunk({ id: full.id || firstChunkMeta.id, object: "chat.completion.chunk", created: full.created || created, model: finalModelId, choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] });
        history.push({ role: "assistant", content: text });
        trimHistory(history);
        await saveHistory(virtualChatId, history);
        const hasUsage = Number.isFinite(full.usage?.prompt_tokens)
          && Number.isFinite(full.usage?.completion_tokens);
        const promptTokens = hasUsage
          ? full.usage.prompt_tokens
          : Math.round(JSON.stringify(params.messages || "").length / 4);
        const completionTokens = hasUsage
          ? full.usage.completion_tokens
          : Math.round(text.length / 4);
        recordUsage({
          source: "proxy",
          chatId: virtualChatId,
          modelId: finalModelId,
          promptTokens,
          completionTokens,
          estUsd: usageCost(MODELS_CONFIG[finalModelId], {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
          }),
          estimated: !hasUsage,
        });
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      // Non-fallback failure: emit a delta with empty content and finish_reason=error, then DONE
      sendChunk({ ...firstChunkMeta, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] });
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    let accumulated = "";
    let chunkId = firstChunkMeta.id;
    try {
      for await (const chunk of stream) {
        if (chunk.id) chunkId = chunk.id;
        const deltaText = chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.delta?.reasoning_content || "";
        if (deltaText) accumulated += deltaText;
        sendChunk({
          id: chunk.id || chunkId,
          object: "chat.completion.chunk",
          created: chunk.created || created,
          model: chunk.model || finalModelId,
          choices: [{
            index: 0,
            delta: deltaText ? { content: deltaText } : {},
            finish_reason: chunk.choices?.[0]?.finish_reason || null,
          }],
        });
      }
    } catch (streamErr) {
      console.error(chalk.red(`[PROXY STREAM] mid-stream error: ${streamErr.message}`));
      sendChunk({ id: chunkId, object: "chat.completion.chunk", created, model: finalModelId, choices: [{ index: 0, delta: {}, finish_reason: "error" }] });
    }

    history.push({ role: "assistant", content: accumulated });
    trimHistory(history);
    await saveHistory(virtualChatId, history);
    // Streaming responses don't reliably carry a usage object (that would need
    // stream_options.include_usage, which can perturb strict SSE clients), so record a
    // length-based token estimate flagged estimated=true. Attribution only.
    recordUsage({
      source: "proxy",
      chatId: virtualChatId,
      modelId: finalModelId,
      promptTokens: Math.round((JSON.stringify(params.messages || "").length) / 4),
      completionTokens: Math.round(accumulated.length / 4),
      estUsd: usageCost(MODELS_CONFIG[finalModelId] || { inputPrice: 0.40, outputPrice: 1.20 }, {
        prompt_tokens: Math.round((JSON.stringify(params.messages || "").length) / 4),
        completion_tokens: Math.round(accumulated.length / 4),
      }),
      estimated: true,
    });
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  // ── End streaming branch ───────────────────────────────────────────

  let response, finalModelId = modelId;
  try {
    response = await clientFor(modelId).chat.completions.create(params);
  } catch (err) {
    // Silent fallback to Qwen coder on DeepSeek 5xx/429, mirroring the Gemini fallback
    // pattern in askAI. Retries once; if the fallback also fails, throw.
    const status = err?.status || err?.response?.status || 0;
    const looksUpstream = status >= 500 || status === 429 || /5\d\d|timeout|ETIMEDOUT/i.test(String(err?.message || ""));
    if (isDeepSeekModel(modelId) && looksUpstream) {
      console.error(chalk.yellow(`[PROXY] DeepSeek ${status || "?"} → fallback qwen/qwen3-coder-next`));
      finalModelId = "qwen/qwen3-coder-next";
      response = await openai.chat.completions.create({ ...params, model: finalModelId });
    } else {
      throw err;
    }
  }

  const rawMsg = response.choices?.[0]?.message || {};
  // DeepSeek thinking models return the visible answer in `content` and the chain-of-
  // thought in `reasoning_content`. Forward both (OpenAI-compatible clients ignore the
  // extra field; thinking-aware ones like Qoder render it). If content is empty but
  // reasoning exists (caller's max_tokens was too tight to finish thinking), surface the
  // reasoning so the client never gets a fully blank assistant turn.
  const replyText = rawMsg.content || rawMsg.reasoning_content || "";
  history.push({ role: "assistant", content: replyText });
  trimHistory(history);
  await saveHistory(virtualChatId, history);

  const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  recordUsage({
    source: "proxy",
    chatId: virtualChatId,
    modelId: finalModelId,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    estUsd: usageCost(MODELS_CONFIG[finalModelId] || { inputPrice: 0.40, outputPrice: 1.20 }, usage),
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: response.id || `hermes_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: finalModelId,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: rawMsg.content || rawMsg.reasoning_content || "",
        ...(rawMsg.reasoning_content ? { reasoning_content: rawMsg.reasoning_content } : {}),
      },
      finish_reason: response.choices?.[0]?.finish_reason || "stop",
    }],
    usage,
    hermes: {
      virtualChatId,
      fallbackUsed: finalModelId !== modelId,
      note: "Hermes-as-head proxy. Billed to the same DeepSeek/OpenRouter balance as Telegram.",
    },
  }));
}

// ─── Format model name for display ────────────────────────────────────
function shortModel(m) {
  return m.split("/").pop().replace(":nitro", " ⚡");
}

// ─── Build the Telegram inline model panel ────────────────────────────────────
// DeepSeek rows appear only when DEEPSEEK_API_KEY is present, so the Render deploy (which
// doesn't have the key yet) keeps the exact same panel as before.
function buildModelKeyboard(currentModelId) {
  const rows = [
    [
      { text: `🧠 Qwen 3 Max ($0.78/$3.90) ${currentModelId === 'qwen/qwen3-max' ? '✅' : ''}`, callback_data: 'set_model:qwen' }
    ],
    [
      { text: `💻 Claude Code ($3.00/$15.00) ${currentModelId === 'anthropic/claude-sonnet-4.6' ? '✅' : ''}`, callback_data: 'set_model:claude' }
    ],
    [
      { text: `🌐 Gemini 2.5 Flash (Directo - GRATIS) ${currentModelId === 'google/gemini-2.5-flash' ? '✅' : ''}`, callback_data: 'set_model:gemini' }
    ],
    [
      { text: `⚡ Qwen 3 Coder ($0.11/$0.80) ${currentModelId === 'qwen/qwen3-coder-next' ? '✅' : ''}`, callback_data: 'set_model:flash' }
    ]
  ];
  if (deepseek) {
    rows.push([
      { text: `🐋 DeepSeek Flash ($0.15/$0.60 off-peak) ${currentModelId === 'deepseek-flash' ? '✅' : ''}`, callback_data: 'set_model:ds' }
    ]);
    rows.push([
      { text: `🚀 DeepSeek V4 Pro ($0.66/$1.98 off-peak) ${currentModelId === 'deepseek-v4-pro' ? '✅' : ''}`, callback_data: 'set_model:dspro' }
    ]);
  }
  return rows;
}

// ─── Command Execution Helpers (Visual Actions) ──────────────────────────────────
async function showModelPanel(chatId) {
  let currentModelId = activeModels.get(chatId) || MODEL;
  if (currentModelId === "google/gemini-3.1-pro-preview") {
    currentModelId = "google/gemini-2.5-flash";
    activeModels.set(chatId, "google/gemini-2.5-flash");
  }

  const config = getModelConfig(chatId);
  const balanceStr = await fetchBalance();
  const dsBalanceStr = await fetchDSBalance();

  const menuText = `🤖 *PANEL DE CONTROL (The Wise Pipeline)*\n\n` +
                   `• *Modelo Activo:* \`${config.name}\`\n` +
                   `• *ID Técnico:* \`${currentModelId}\`\n` +
                   `• *Precios (1M tokens):* Entrada \`$${config.inputPrice.toFixed(2)}\` | Salida \`$${config.outputPrice.toFixed(2)}\` ${currentModelId === 'google/gemini-2.5-flash' ? '\n🔥 _¡Coste Cero! Llamada directa gratis via tu API Key de Google._' : ''}\n` +
                   buildBalanceLines(balanceStr, dsBalanceStr) +
                   `👉 *Selecciona un modelo tocando las opciones del panel:*`;

  const inlineKeyboard = buildModelKeyboard(currentModelId);

  bot.sendMessage(chatId, menuText, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  });
}

function showHelp(chatId) {
  bot.sendMessage(
    chatId,
    `🔧 *Ayuda del Bot (ax7.createga)*\n\n` +
    `• *Seleccionar Modelo:* Muestra el panel interactivo táctil para cambiar de IA y ver precios.\n` +
    `• *Comprobar Conexión:* Realiza una prueba rápida de latencia de red.\n` +
    `• *Limpiar Historial:* Borra la memoria reciente de este chat de forma segura en Supabase.\n` +
    `• *Vault:* \`/vault <archivo>\` lee una nota del vault de Obsidian; sin argumento muestra el índice.\n` +
    `• *Buscar:* \`/buscar <término>\` busca en todas las notas y devuelve fragmentos con la ruta.\n` +
    `• *Web:* abre la URL del servicio + \`/chat\` para chatear desde el navegador (pide \`HERMES_PROXY_TOKEN\`).\n\n` +
    `💡 *Nota:* Utiliza los botones táctiles del teclado inferior de tu pantalla móvil para una navegación instantánea y sin fricción.`,
    { parse_mode: "Markdown" }
  );
}

async function handleSecretaryCapture(chatId, input) {
  const cleanInput = String(input || "").trim();
  if (!cleanInput) {
    return bot.sendMessage(
      chatId,
      [
        "```",
        "HERMES / CAPTURA",
        "==============================",
        "Escribe algo despues de /captura.",
        "",
        "Ejemplo:",
        "/captura tarea: revisar RLS de Supabase",
        "```"
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  }

  const item = addCapture(secretaryState, chatId, cleanInput);
  return bot.sendMessage(chatId, formatCaptureAscii(item), { parse_mode: "Markdown" });
}

async function showNextAction(chatId) {
  const next = getNextAction(secretaryState, chatId);
  const text = next
    ? [
        "```",
        "HERMES / SIGUIENTE",
        "==============================",
        `[${next.id}] ${next.type}`,
        "",
        next.text,
        "",
        "Haz solo esto primero.",
        "```"
      ].join("\n")
    : [
        "```",
        "HERMES / SIGUIENTE",
        "==============================",
        "No hay capturas abiertas.",
        "",
        "Usa /captura para guardar una idea o tarea.",
        "```"
      ].join("\n");

  return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

async function showActiveProfile(chatId) {
  const profile = getProfile(secretaryState, chatId);
  return bot.sendMessage(
    chatId,
    [
      "```",
      "HERMES / PERFIL",
      "==============================",
      `Activo: ${profile.label}`,
      "",
      profile.purpose,
      "```"
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function changeProfile(chatId, input) {
  const profile = setProfile(secretaryState, chatId, input);
  return bot.sendMessage(
    chatId,
    [
      "```",
      "HERMES / PERFIL",
      "==============================",
      `Activo: ${profile.label}`,
      "",
      profile.purpose,
      "```"
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function handleSecretaryIntent(chatId, text) {
  const intent = detectSecretaryIntent(text);
  if (!intent) return false;

  if (intent.type === "PROJECTS") {
    await bot.sendMessage(chatId, formatProjectsAscii(secretaryState, chatId), { parse_mode: "Markdown" });
    return true;
  }
  if (intent.type === "NEXT") {
    await showNextAction(chatId);
    return true;
  }
  if (intent.type === "PROFILES") {
    await bot.sendMessage(chatId, formatProfilesAscii(secretaryState, chatId), { parse_mode: "Markdown" });
    return true;
  }
  if (intent.type === "VOICE_STATUS") {
    await bot.sendMessage(chatId, formatVoiceStatusAscii(), { parse_mode: "Markdown" });
    return true;
  }
  if (intent.type === "SET_PROFILE") {
    await changeProfile(chatId, intent.profileId);
    return true;
  }
  if (intent.type === "CAPTURE") {
    await handleSecretaryCapture(chatId, intent.text);
    return true;
  }

  return false;
}

async function runStatusCheck(chatId) {
  let currentModelId = activeModels.get(chatId) || MODEL;
  if (currentModelId === "google/gemini-3.1-pro-preview") {
    currentModelId = "google/gemini-2.5-flash";
    activeModels.set(chatId, "google/gemini-2.5-flash");
  }

  const statusMsg = await bot.sendMessage(chatId, "⏳ Comprobando conexión con la API...");
  try {
    const startTime = Date.now();
    let reply = "?";
    
    if (currentModelId === "google/gemini-2.5-flash" && googleGenAI) {
      const geminiModel = googleGenAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const result = await geminiModel.generateContent("Reply with exactly: OK");
      reply = result.response.text();
    } else {
      const ping = await clientFor(currentModelId).chat.completions.create({
        model: currentModelId,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 5,
      });
      reply = ping.choices[0]?.message?.content || "?";
    }
    
    const latency = Date.now() - startTime;
    await bot.editMessageText(
      `✅ *Servicio en línea (ax7.createga)*\n\nModelo probado: \`${shortModel(currentModelId)}\`\nRespuesta: \`${reply.trim()}\`\nLatencia: \`${latency}ms\` ${currentModelId === 'google/gemini-2.5-flash' ? '\n🌐 (Llamada directa nativa a Google)' : ''}`,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
    );
  } catch (err) {
    await bot.editMessageText(
      `❌ *Error de conexión*\n\n\`${err.message}\``,
      { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
    );
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────
onAuthorizedText(/\/start/, (msg) => {
  const name = msg.from.first_name || "allí";
  bot.sendMessage(
    msg.chat.id,
    `🧠 *Qwen/Gemini Online (ax7.createga)*\n\n¡Hola, ${name}! Soy tu asistente estratégico inteligente.\nModelo activo: \`${shortModel(activeModels.get(msg.chat.id) || MODEL)}\`\n\n` +
    `He configurado tu teclado con *botones táctiles persistentes* abajo. ¡Ya no necesitas escribir comandos con "/"!\n\n` +
    `Toca cualquier opción para interactuar de forma fluida y visual. 🚀`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [
          [
            { text: "🤖 Seleccionar Modelo" },
            { text: "✅ Comprobar Conexión" }
          ],
          [
            { text: "🔄 Limpiar Historial" },
            { text: "🔧 Menú de Ayuda" }
          ],
          [
            { text: "HERMES / HOY" },
            { text: "HERMES / SIGUIENTE" }
          ],
          [
            { text: "HERMES / PROYECTOS" },
            { text: "HERMES / PERFILES" }
          ]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    }
  );
});

onAuthorizedText(/\/help/, (msg) => {
  showHelp(msg.chat.id);
});

onAuthorizedText(/\/id/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    [
      "Hermes ID check",
      `chat_id: ${msg.chat.id}`,
      `user_id: ${msg.from.id}`
    ].join("\n")
  );
});

// ─── Obsidian vault queries ───────────────────────────────────────────────────
const VAULT_REPLY_LIMIT = 3500;

function truncateForTelegram(text, limit = VAULT_REPLY_LIMIT) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n… (truncado: ${text.length} caracteres en total)`;
}

onAuthorizedText(/\/vault(?:\s+([\s\S]+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!OBSIDIAN_VAULT_PATH) {
    return bot.sendMessage(chatId, "⚠️ El vault no está configurado (falta OBSIDIAN_VAULT_PATH).");
  }
  const query = (match && match[1] ? match[1] : "").trim();
  if (!query) {
    const files = collectObsidianMarkdown();
    const byFolder = new Map();
    for (const rel of files) {
      const folder = rel.includes("/") ? rel.split("/")[0] : "(raíz)";
      byFolder.set(folder, (byFolder.get(folder) || 0) + 1);
    }
    const lines = [...byFolder.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `• ${f} — ${n} notas`);
    return bot.sendMessage(
      chatId,
      [`📚 Vault: ${files.length} notas .md`, "", ...lines, "", "Uso:", "/vault <archivo o ruta>", "Ej: /vault PLAN-Trello-llamas", "/buscar <término>"].join("\n")
    );
  }
  const abs = resolveObsidianPath(query);
  if (!abs) {
    const term = query.toLowerCase();
    const candidates = collectObsidianMarkdown().filter((rel) => rel.toLowerCase().includes(term)).slice(0, 10);
    const hint = candidates.length ? `\n\nCoincidencias por nombre:\n${candidates.map((c) => `• /vault ${c}`).join("\n")}` : "\n\nIntenta con /buscar <término>.";
    return bot.sendMessage(chatId, `❌ No encontré \"${query}\".${hint}`);
  }
  let content = "";
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch (err) {
    return bot.sendMessage(chatId, `❌ No pude leer el archivo: ${err.message}`);
  }
  const relative = path.relative(path.resolve(OBSIDIAN_VAULT_PATH), abs).replace(/\\/g, "/");
  return bot.sendMessage(chatId, truncateForTelegram(`📄 ${relative}\n\n${content}`));
});

onAuthorizedText(/\/buscar(?:\s+([\s\S]+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  if (!OBSIDIAN_VAULT_PATH) {
    return bot.sendMessage(chatId, "⚠️ El vault no está configurado (falta OBSIDIAN_VAULT_PATH).");
  }
  const term = (match && match[1] ? match[1] : "").trim();
  if (!term) {
    return bot.sendMessage(chatId, "Uso: /buscar <término>\nEj: /buscar trello");
  }
  const results = searchObsidianVault(term);
  if (!results.length) {
    return bot.sendMessage(chatId, `🔎 Sin coincidencias para \"${term}\" en el vault.`);
  }
  const blocks = results.map((r) => {
    const head = `📄 ${r.rel} (${r.total})`;
    const body = r.snippets.map((s) => `… ${s} …`).join("\n");
    return `${head}\n${body}`;
  });
  const totalHits = results.reduce((acc, r) => acc + r.total, 0);
  return bot.sendMessage(
    chatId,
    truncateForTelegram(`🔎 \"${term}\" — ${totalHits} coincidencias en ${results.length} archivos\n\n${blocks.join("\n\n")}\n\nAbre una con /vault <ruta>`)
  );
});

onAuthorizedText(/\/reset/, async (msg) => {
  await saveHistory(msg.chat.id, []);
  bot.sendMessage(
    msg.chat.id,
    "🔄 *Conversación restablecida.*\nHistorial limpiado. ¡Empecemos de cero!",
    { parse_mode: "Markdown" }
  );
});

onAuthorizedText(/\/model/, async (msg) => {
  await showModelPanel(msg.chat.id);
});

onAuthorizedText(/^\/captura(?:\s+([\s\S]+))?$/, async (msg, match) => {
  await handleSecretaryCapture(msg.chat.id, match && match[1]);
});

onAuthorizedText(/^\/hoy$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, formatTodayAscii(secretaryState, msg.chat.id), { parse_mode: "Markdown" });
});

onAuthorizedText(/^\/siguiente$/, async (msg) => {
  await showNextAction(msg.chat.id);
});

onAuthorizedText(/^\/cierre$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, formatCloseAscii(secretaryState, msg.chat.id), { parse_mode: "Markdown" });
});

onAuthorizedText(/^\/proyectos$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, formatProjectsAscii(secretaryState, msg.chat.id), { parse_mode: "Markdown" });
});

onAuthorizedText(/^\/perfiles$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, formatProfilesAscii(secretaryState, msg.chat.id), { parse_mode: "Markdown" });
});

onAuthorizedText(/^\/perfil(?:\s+(.+))?$/, async (msg, match) => {
  const input = match && match[1] ? match[1].trim() : "";
  if (!input) {
    await showActiveProfile(msg.chat.id);
    return;
  }

  await changeProfile(msg.chat.id, input);
});

onAuthorizedText(/^\/director$/, async (msg) => {
  await changeProfile(msg.chat.id, "director");
});

onAuthorizedText(/^\/voz$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, formatVoiceStatusAscii(), { parse_mode: "Markdown" });
});

onAuthorizedText(/^\/gasto$/, async (msg) => {
  if (!DS_KEY) {
    await bot.sendMessage(msg.chat.id,
      "\u26a0\ufe0f Sin `DEEPSEEK_API_KEY` en `.env` \u2014 no puedo consultar /user/balance.",
      { parse_mode: "Markdown" });
    return;
  }
  const statusMsg = await bot.sendMessage(msg.chat.id, "\u23f3 Consultando saldo DeepSeek\u2026");
  const bal = await getDSBalanceRaw();
  let text = formatGasto(bal, DS_INVESTED_USD);
  const brk = await fetchTodayUsageBreakdown();
  if (brk && brk.rows.length > 0) {
    const line = (label, a) => a
      ? `\u2022 ${label}: \`$${a.usd.toFixed(5)}\` \u00b7 ${a.reqs} turns \u00b7 ~${a.tokens.toLocaleString("en-US")} tok${a.anyEst ? " (incl. est.)" : ""}`
      : null;
    const parts = [
      line("\ud83d\udcf1 Telegram", brk.agg.telegram),
      line("\ud83d\udcbb Qoder (proxy)", brk.agg.proxy),
    ].filter(Boolean);
    if (parts.length) text += `\n\n\ud83d\udccd *Por d\u00f3nde hoy (UTC, costo estimado por lista):*\n${parts.join("\n")}`;
  } else if (brk === null) {
    text += `\n\n\u2139\ufe0f *Breakdown por fuente:* no disponible (falta aplicar \`proxy_usage.sql\` en Supabase).`;
  }
  await bot.editMessageText(text, {
    chat_id: msg.chat.id,
    message_id: statusMsg.message_id,
    parse_mode: "Markdown",
  });
});

// Callback queries handler for inline buttons
bot.on("callback_query", async (callbackQuery) => {
  if (!isAllowed(callbackQuery.from?.id)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: "No autorizado" });
    return;
  }
  const message = callbackQuery.message;
  const data = callbackQuery.data;
  if (!message || !data) {
    await bot.answerCallbackQuery(callbackQuery.id);
    return;
  }
  const chatId = message.chat.id;

  if (data.startsWith("set_model:")) {
    const key = data.split(":")[1];
    let targetModelId = null;
    let targetName = "";

    if (key === "qwen") {
      targetModelId = "qwen/qwen3-max";
      targetName = "Qwen 3 Max";
    } else if (key === "claude") {
      targetModelId = "anthropic/claude-sonnet-4.6";
      targetName = "Claude Sonnet 4.6";
    } else if (key === "gemini") {
      targetModelId = "google/gemini-2.5-flash";
      targetName = "Gemini 2.5 Flash";
    } else if (key === "flash") {
      targetModelId = "qwen/qwen3-coder-next";
      targetName = "Qwen 3 Coder";
    } else if (key === "ds") {
      targetModelId = "deepseek-flash";
      targetName = "DeepSeek Flash";
    } else if (key === "dspro") {
      targetModelId = "deepseek-v4-pro";
      targetName = "DeepSeek V4 Pro";
    }

    if (targetModelId) {
      activeModels.set(chatId, targetModelId);
      const config = MODELS_CONFIG[targetModelId];
      const balanceStr = await fetchBalance();
      const dsBalanceStr = await fetchDSBalance();

      bot.answerCallbackQuery(callbackQuery.id, { text: `Modelo cambiado a ${targetName}` });

      const updatedMenuText = `🤖 *PANEL DE CONTROL (The Wise Pipeline)*\n\n` +
                              `• *Modelo Activo:* \`${config.name}\`\n` +
                              `• *ID Técnico:* \`${targetModelId}\`\n` +
                              `• *Precios (1M tokens):* Entrada \`$${config.inputPrice.toFixed(2)}\` | Salida \`$${config.outputPrice.toFixed(2)}\` ${targetModelId === 'google/gemini-2.5-flash' ? '\n🔥 _¡Coste Cero! Llamada directa gratis via tu API Key de Google._' : ''}\n` +
                              buildBalanceLines(balanceStr, dsBalanceStr) +
                              `👉 *Selecciona un modelo tocando las opciones del panel:*`;

      const updatedInlineKeyboard = buildModelKeyboard(targetModelId);

      bot.editMessageText(updatedMenuText, {
        chat_id: chatId,
        message_id: message.message_id,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: updatedInlineKeyboard
        }
      });
    }
  }
});

onAuthorizedText(/\/status/, async (msg) => {
  await runStatusCheck(msg.chat.id);
});

// ─── Robust message sending ───────────────────────────────────────────────────
async function safeSendMessage(chatId, text) {
  try {
    if (text.length <= 4096) {
      await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } else {
      const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
      }
    }
  } catch (err) {
    if (err.message && err.message.includes("can't parse entities")) {
      console.warn("Markdown parsing failed, falling back to plain text...");
      if (text.length <= 4096) {
        await bot.sendMessage(chatId, text);
      } else {
        const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, chunk);
        }
      }
    } else {
      throw err;
    }
  }
}

// ─── HTML Document Extractor and Sender ──────────────────────────────────────
const fs = require("fs");
const path = require("path");

async function handleHTMLExtraction(chatId, replyText) {
  const regex = /```html\s*([\s\S]*?)```/i;
  const match = replyText.match(regex);
  if (match && match[1]) {
    const htmlContent = match[1].trim();
    const dateStr = new Date().toISOString().split("T")[0];
    const filename = `Ficha_Hiperenfoque_${dateStr}.html`;
    const tempPath = path.join(__dirname, filename);
    
    try {
      fs.writeFileSync(tempPath, htmlContent, "utf8");
      await bot.sendMessage(chatId, "📄 *He compilado tu Ficha HTML interactiva en un documento descargable. ¡Aquí lo tienes!*", { parse_mode: "Markdown" });
      await bot.sendDocument(chatId, tempPath, {}, { filename });
      fs.unlinkSync(tempPath);
    } catch (err) {
      console.error("Error al generar o enviar archivo HTML:", err.message);
    }
  }
}

// ─── Local Safe Action Runner (Realtime Polling Bridge) ──────────────────
async function runLocalCommand(chatId, rawAction) {
  const actionName = normalizeActionName(rawAction);

  if (!isAllowedAction(actionName)) {
    const valid = listAllowedActions().map(a => `\`${a}\``).join(", ");
    return bot.sendMessage(
      chatId,
      `❌ *Acción no permitida por seguridad.*\n\nLa consola de ejecución libre de comandos de shell está deshabilitada.\n\nAcciones seguras de solo lectura admitidas:\n${valid}\n\nEnvía: \`🖥️ help\` para ver la descripción de cada una.`,
      { parse_mode: "Markdown" }
    );
  }

  if (!supabase) {
    return bot.sendMessage(chatId, "❌ Supabase no está configurada.");
  }
  
  const statusMsg = await bot.sendMessage(chatId, `⏳ *Enviando acción segura a tu PC local...*\n\`${actionName}\``, { parse_mode: "Markdown" });
  
  try {
    const { data, error } = await supabase
      .from("antigravity_local_queue")
      .insert({ command: actionName, status: "pending" })
      .select()
      .single();
      
    if (error) throw error;
    
    const jobId = data.id;
    let attempts = 0;
    const maxAttempts = 20; // 20 * 1.5s = 30s timeout
    
    const interval = setInterval(async () => {
      attempts++;
      const { data: job, error: pollError } = await supabase
        .from("antigravity_local_queue")
        .select("status, result")
        .eq("id", jobId)
        .single();
        
      if (pollError) {
        clearInterval(interval);
        await bot.editMessageText(`❌ *Error al consultar estatus de la acción:*\n\`${pollError.message}\``, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "Markdown"
        });
        return;
      }
      
      if (job.status === "completed" || job.status === "failed") {
        clearInterval(interval);
        
        const statusIndicator = job.status === "completed" ? "✅" : "❌";
        const resultHeader = `${statusIndicator} *Acción Local (${actionName}) — ID ${jobId}*\n\n`;
        const formattedResult = `${job.result}`;
        
        await bot.editMessageText(resultHeader + formattedResult, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "Markdown"
        });
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        await bot.editMessageText(`⚠️ *Tiempo de espera agotado.*\nEl PC local no respondió a la acción en 30 segundos. Verifica que \`node antigravity-bridge.js\` esté corriendo en tu PC.`, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "Markdown"
        });
      }
    }, 1500);
    
  } catch (err) {
    await bot.editMessageText(`❌ *Error al insertar acción:* \`${err.message}\``, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: "Markdown"
    });
  }
}

// ─── Main message handler ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId   = msg.chat.id;
  const userId   = msg.from.id;
  const username = msg.from.username || msg.from.first_name;

  // Auth check
  if (!isAllowed(userId)) {
    bot.sendMessage(chatId, "⛔ No estás autorizado para acceder a este bot.");
    console.log(chalk.yellow(`[AUTH] Usuario bloqueado: @${username} (${userId})`));
    return;
  }

  // Interceptar comandos de consola local (🖥️)
  if (msg.text && (msg.text.startsWith("🖥️") || msg.text.toLowerCase().startsWith("cmd:"))) {
    let commandText = "";
    if (msg.text.startsWith("🖥️")) {
      commandText = msg.text.substring(2).trim();
    } else {
      commandText = msg.text.substring(4).trim();
    }
    
    if (!commandText) {
      const valid = listAllowedActions().map(a => `• \`🖥️ ${a}\``).join("\n");
      bot.sendMessage(
        chatId,
        `ℹ️ *Acciones de PC Local Disponibles:*\n\n${valid}\n\nEjemplo: \`🖥️ status\` o \`🖥️ help\`.\n⚠️ *Seguridad:* Comandos libres de consola arbitrarios (dir, del, etc.) están deshabilitados.`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    
    await runLocalCommand(chatId, commandText);
    return;
  }

  // Interceptar botones persistentes de menú táctil
  if (msg.text) {
    if (msg.text.startsWith("/")) return;
    if (msg.text === "HERMES / HOY") {
      await bot.sendMessage(chatId, formatTodayAscii(secretaryState, chatId), { parse_mode: "Markdown" });
      return;
    }
    if (msg.text === "HERMES / SIGUIENTE") {
      await showNextAction(chatId);
      return;
    }
    if (msg.text === "HERMES / PROYECTOS") {
      await bot.sendMessage(chatId, formatProjectsAscii(secretaryState, chatId), { parse_mode: "Markdown" });
      return;
    }
    if (msg.text === "HERMES / PERFILES") {
      await bot.sendMessage(chatId, formatProfilesAscii(secretaryState, chatId), { parse_mode: "Markdown" });
      return;
    }
    if (msg.text === "🤖 Seleccionar Modelo") {
      await showModelPanel(chatId);
      return;
    }
    if (msg.text === "✅ Comprobar Conexión") {
      await runStatusCheck(chatId);
      return;
    }
    if (msg.text === "🔄 Limpiar Historial") {
      await saveHistory(chatId, []);
      bot.sendMessage(chatId, "🔄 *Conversación restablecida.*\nHistorial limpiado. ¡Empecemos de cero!", { parse_mode: "Markdown" });
      return;
    }
    if (msg.text === "🔧 Menú de Ayuda") {
      showHelp(chatId);
      return;
    }
  }

  let textToProcess = msg.text;

  // ─── Voice Note Handler ──────────────────────────────────────────────────────
  if (msg.voice) {
    const voiceMsg = await bot.sendMessage(chatId, "🎤 _Descargando y escuchando tu nota de voz..._");
    try {
      bot.sendChatAction(chatId, "record_voice");
      const audioBuffer = await getVoiceBuffer(msg.voice.file_id);
      
      const transcription = await transcribeAudio(audioBuffer);
      
      if (!transcription || transcription.length === 0) {
        await bot.editMessageText("❌ No pude entender nada en el audio. Por favor, habla más claro o acércate al micrófono.", {
          chat_id: chatId,
          message_id: voiceMsg.message_id
        });
        return;
      }
      
      await bot.editMessageText(`🎤 *Transcripción:* _"${transcription}"_`, {
        chat_id: chatId,
        message_id: voiceMsg.message_id,
        parse_mode: "Markdown"
      });
      
      textToProcess = transcription;
    } catch (err) {
      console.error(chalk.red(`[VOICE ERR] ${err.message}`));
      await bot.editMessageText(`❌ *Error al transcribir audio:*\n\`${err.message}\``, {
        chat_id: chatId,
        message_id: voiceMsg.message_id,
        parse_mode: "Markdown"
      });
      return;
    }
  }

  if (!textToProcess) {
    bot.sendMessage(chatId, "📝 Por el momento solo puedo procesar mensajes de texto y notas de voz.");
    return;
  }

  console.log(chalk.cyan(`[MSG] @${username} → ${textToProcess.substring(0, 60)}${textToProcess.length > 60 ? "..." : ""}`));

  if (await handleSecretaryIntent(chatId, textToProcess)) {
    return;
  }

  // Show typing indicator
  bot.sendChatAction(chatId, "typing");
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, "typing"), 4500);

  try {
    const reply = await askAI(chatId, textToProcess);
    clearInterval(typingInterval);

    // Safe, robust message chunking and delivery
    await safeSendMessage(chatId, reply);
    
    // Automatically compile and deliver HTML code blocks as downloadable files
    await handleHTMLExtraction(chatId, reply);

    console.log(chalk.green(`[OK]  Respondido (${reply.length} caracteres)`));

  } catch (err) {
    clearInterval(typingInterval);
    console.error(chalk.red(`[ERR] ${err.message}`));

    let errMsg = "⚠️ *Error del Asistente*\n\n";
    if (err.status === 404) {
      errMsg += "El modelo solicitado no está disponible en OpenRouter en este momento.\n\nPrueba /status para diagnosticar.";
    } else if (err.status === 401) {
      errMsg += "Clave API inválida en la configuración del servidor (.env).";
    } else if (err.status === 429) {
      errMsg += "Límite de peticiones alcanzado. Espera un momento y vuelve a intentarlo.";
    } else {
      errMsg += `\`${err.message}\``;
    }

    await safeSendMessage(chatId, errMsg);
  }
});

// ─── Error handling ───────────────────────────────────────────────────────────
bot.on("polling_error", (err) => {
  console.error(chalk.red(`[ERROR DE POLLING] ${err.message}`));
});

// ─── Qoder → Hermes queue consumer (Supabase realtime) ───────────────────
// Inserts from the MCP bridge (tool `hermes_enqueue`) arrive as new rows in
// qoder_hermes_queue. This mirrors the Telegram message handler: claim the row
// atomically, temporarily override activeModels if a model was specified,
// reuse askAI + safeSendMessage + handleHTMLExtraction, and post the reply back
// to Telegram. Works in both webhook (Render) and polling (local) modes;
// whichever instance claims the row first wins via the status='pending' guard.
const HERMES_INSTANCE_ID = process.env.HERMES_INSTANCE_ID
  || `${USE_TELEGRAM_WEBHOOK ? "render" : "local"}-${process.pid}`;

// Queue authorization: two layers.
//   1. `ALLOWED_USER_ID` (Telegram-side, already in .env) — for 1:1 chats, chat_id === user_id,
//      so `isAllowed(row.chat_id)` mirrors what bot.on("message") enforces.
//   2. `QODER_ALLOWED_CHAT_IDS` (optional comma-separated) — narrower list specific to inserts
//      coming from the MCP bridge. If set, a row's chat_id must be in BOTH that list AND pass
//      isAllowed(). This defends against a compromised SUPABASE_KEY inserting a foreign chat.
const QODER_ALLOWED_CHAT_IDS = process.env.QODER_ALLOWED_CHAT_IDS
  ? new Set(process.env.QODER_ALLOWED_CHAT_IDS.split(",").map((s) => Number(s.trim())).filter(Number.isFinite))
  : null;

function queueAuthorizes(chatId) {
  if (!isAllowed(chatId)) return { ok: false, reason: "outside ALLOWED_USER_ID" };
  if (QODER_ALLOWED_CHAT_IDS && !QODER_ALLOWED_CHAT_IDS.has(chatId)) {
    return { ok: false, reason: "chat_id not in QODER_ALLOWED_CHAT_IDS" };
  }
  return { ok: true };
}

async function subscribeQoderHermesQueue() {
  if (!supabase) {
    console.warn(chalk.gray("[QODER QUEUE] Supabase no está configurado; el consumer queda inactivo."));
    return;
  }
  const policy = QODER_ALLOWED_CHAT_IDS
    ? `ALLOWED_USER_ID=${ALLOWED ?? "abierto"} ∩ QODER_ALLOWED_CHAT_IDS={${[...QODER_ALLOWED_CHAT_IDS].join(", ")}}`
    : `ALLOWED_USER_ID=${ALLOWED ?? "abierto"} (sin lista específica de Qoder)`;
  console.log(chalk.gray(`[QODER QUEUE] política de autorización: ${policy}`));
  // Probe that the queue table exists before subscribing. If the user hasn't
  // run qoder_hermes_queue.sql yet, we log a clear one-liner instead of a
  // cryptic realtime error later.
  const { count, error: probeErr } = await supabase
    .from("qoder_hermes_queue")
    .select("*", { count: "exact", head: true });
  if (probeErr) {
    console.warn(chalk.yellow(`[QODER QUEUE] tabla qoder_hermes_queue no accesible (${probeErr.message}). Ejecuta D:/AI/Hermes/mcp-server/qoder_hermes_queue.sql en Supabase y reinicia el bot. Consumer NO suscrito.`));
    return;
  }
  console.log(chalk.gray(`[QODER QUEUE] tabla presente; filas actuales: ${count ?? 0}. Suscribiendo realtime…`));
  supabase
    .channel("qoder-hermes-queue")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "qoder_hermes_queue" },
      async (payload) => {
        const row = payload.new;
        if (!row || row.status !== "pending") return;

        // Reject before claiming — a row for an unauthorized chat is marked failed and never runs.
        const auth = queueAuthorizes(row.chat_id);
        if (!auth.ok) {
          console.warn(chalk.yellow(`[QODER QUEUE] fila ${row.id} RECHAZADA: ${auth.reason} (chat ${row.chat_id})`));
          await supabase
            .from("qoder_hermes_queue")
            .update({
              status: "failed",
              result: `authz denied: ${auth.reason}`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id)
            .eq("status", "pending");
          return;
        }

        // Atomic claim: only the instance whose update returns status='processing' continues.
        const { data: claimed, error: claimErr } = await supabase
          .from("qoder_hermes_queue")
          .update({ status: "processing", updated_at: new Date().toISOString() })
          .eq("id", row.id)
          .eq("status", "pending")
          .select("id, status")
          .single();
        if (claimErr || !claimed) {
          console.log(chalk.gray(`[QODER QUEUE] fila ${row.id} ya la tomó otra instancia.`));
          return;
        }
        console.log(chalk.cyan(`[QODER QUEUE] ${HERMES_INSTANCE_ID} procesando fila ${row.id} (chat ${row.chat_id})`));

        const previousModel = activeModels.get(row.chat_id);
        const hasPrev = activeModels.has(row.chat_id);
        if (row.model && MODELS_CONFIG[row.model]) {
          activeModels.set(row.chat_id, row.model);
        }
        try {
          const reply = await askAI(row.chat_id, row.text);
          await safeSendMessage(row.chat_id, reply);
          try { await handleHTMLExtraction(row.chat_id, reply); } catch (_) { /* best-effort */ }
          await supabase
            .from("qoder_hermes_queue")
            .update({
              status: "done",
              result: String(reply).slice(0, 4000),
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          console.log(chalk.green(`[QODER QUEUE] ✔ fila ${row.id} respondida (${reply.length} chars)`));
        } catch (err) {
          console.error(chalk.red(`[QODER QUEUE] ✖ fila ${row.id}: ${err.message}`));
          await supabase
            .from("qoder_hermes_queue")
            .update({
              status: "failed",
              result: String((err && err.message) || err).slice(0, 500),
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
        } finally {
          if (hasPrev) activeModels.set(row.chat_id, previousModel);
          else activeModels.delete(row.chat_id);
        }
      }
    )
    .subscribe((status) => {
      console.log(chalk.gray(`[QODER QUEUE] subscription status: ${status}`));
    });
}
subscribeQoderHermesQueue();

async function configureTelegramDelivery() {
  if (!USE_TELEGRAM_WEBHOOK) {
    console.log(chalk.gray("[TELEGRAM] Modo polling local activo."));
    return;
  }

  try {
    await bot.setWebHook(WEBHOOK_URL, {
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false
    });
    console.log(chalk.green("[TELEGRAM] Webhook activo en Render."));
  } catch (err) {
    console.error(chalk.red(`[TELEGRAM WEBHOOK ERR] ${err.message}`));
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────
console.log(chalk.bold.cyan("\n  🧠 QWEN/GEMINI TELEGRAM BOT (ax7.createga)"));
console.log(chalk.gray("  ─────────────────────────────────────────────"));
console.log(chalk.white(`  Modelo  : ${MODEL}`));
console.log(chalk.white(`  Acceso  : ${ALLOWED ? `ID de Usuario ${ALLOWED} únicamente` : "Abierto a todos"}`));
console.log(chalk.green("  Estado  : En línea y escuchando peticiones...\n"));
console.log(chalk.white(`  Entrega : ${USE_TELEGRAM_WEBHOOK ? "Webhook Render" : "Polling local"}`));
configureTelegramDelivery();
