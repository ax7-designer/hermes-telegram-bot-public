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
  setProfile,
  getProfile,
  detectSecretaryIntent
} = require("./secretary");

// ─── Render Health Check Web Server ──────────────────────────────────────────
const HTTP_PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(HTTP_PORT, () => {
  console.log(chalk.yellow(`[HTTP] Servidor de salud activo en puerto ${HTTP_PORT}`));
});

// ─── Config ───────────────────────────────────────────────────────────────────
const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const OR_KEY  = process.env.OPENROUTER_API_KEY;
const MODEL   = process.env.HERMES_MODEL || "qwen/qwen3-max";
const ALLOWED = process.env.ALLOWED_USER_ID ? Number(process.env.ALLOWED_USER_ID) : null;
const MAX_HISTORY = 60;

if (!TOKEN || !OR_KEY) {
  console.error(chalk.red("❌  Falta TELEGRAM_BOT_TOKEN o OPENROUTER_API_KEY en el archivo .env"));
  process.exit(1);
}

// ─── Clients ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

// OpenRouter Client (for Claude and Qwen)
const openai = new OpenAI({
  apiKey: OR_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/ax7/hermes-telegram-bot",
    "X-Title": "Qwen/Gemini Telegram Bot (ax7.createga)",
  },
});

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
  if (!ALLOWED) return true;
  return userId === ALLOWED;
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
        systemInstruction: SYSTEM_PROMPT
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
  const finalModelId = (modelId === "google/gemini-2.5-flash") ? "qwen/qwen3-coder-next" : modelId;
  const finalConfig = MODELS_CONFIG[finalModelId] || config;

  console.log(chalk.blue(`🤖 Ejecutando enrutamiento OpenRouter con modelo: ${finalModelId}...`));

  history.push({ role: "user", content: userMessage });
  trimHistory(history);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
  ];

  const response = await openai.chat.completions.create({
    model: finalModelId,
    messages,
    max_tokens: 1536,
    temperature: 0.7,
  });

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
  }

  const balanceStr = await fetchBalance();
  const hermesNote = getRandomHermesNote();

  const wasFallback = (modelId === "google/gemini-2.5-flash");
  const headerBar = wasFallback ? `─── *THE WISE PIPELINE (FALLBACK ACTIVE)* ───` : `─── *THE WISE PIPELINE* ───`;

  const footer = `\n\n` +
                 `${headerBar}\n` +
                 `💳 *Saldo OR:* \`${balanceStr}\` | 🪙 *Costo msg:* \`${costStr}\`\n` +
                 `🤖 *Modelo:* \`${finalConfig.short}\`${wasFallback ? ' ⚠️ (Quota limit - Fallback a Qwen)' : ''}\n` +
                 `🧠 *Bitácora Hermes:* _${hermesNote}_`;

  return replyText + footer;
}

// ─── Format model name for display ───────────────────────────────────────────
function shortModel(m) {
  return m.split("/").pop().replace(":nitro", " ⚡");
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

  const menuText = `🤖 *PANEL DE CONTROL (The Wise Pipeline)*\n\n` +
                   `• *Modelo Activo:* \`${config.name}\`\n` +
                   `• *ID Técnico:* \`${currentModelId}\`\n` +
                   `• *Precios (1M tokens):* Entrada \`$${config.inputPrice.toFixed(2)}\` | Salida \`$${config.outputPrice.toFixed(2)}\` ${currentModelId === 'google/gemini-2.5-flash' ? '\n🔥 _¡Coste Cero! Llamada directa gratis via tu API Key de Google._' : ''}\n` +
                   `• *Saldo OpenRouter:* \`${balanceStr}\`\n\n` +
                   `👉 *Selecciona un modelo tocando las opciones del panel:*`;

  const inlineKeyboard = [
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
    `• *Limpiar Historial:* Borra la memoria reciente de este chat de forma segura en Supabase.\n\n` +
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
      const ping = await openai.chat.completions.create({
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
bot.onText(/\/start/, (msg) => {
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

bot.onText(/\/help/, (msg) => {
  showHelp(msg.chat.id);
});

bot.onText(/\/id/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    [
      "Hermes ID check",
      `chat_id: ${msg.chat.id}`,
      `user_id: ${msg.from.id}`
    ].join("\n")
  );
});

bot.onText(/\/reset/, async (msg) => {
  await saveHistory(msg.chat.id, []);
  bot.sendMessage(
    msg.chat.id,
    "🔄 *Conversación restablecida.*\nHistorial limpiado. ¡Empecemos de cero!",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/model/, async (msg) => {
  await showModelPanel(msg.chat.id);
});

bot.onText(/^\/captura(?:\s+([\s\S]+))?$/, async (msg, match) => {
  await handleSecretaryCapture(msg.chat.id, match && match[1]);
});

bot.onText(/^\/hoy$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, formatTodayAscii(secretaryState, msg.chat.id), { parse_mode: "Markdown" });
});

bot.onText(/^\/siguiente$/, async (msg) => {
  await showNextAction(msg.chat.id);
});

bot.onText(/^\/cierre$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, formatCloseAscii(secretaryState, msg.chat.id), { parse_mode: "Markdown" });
});

bot.onText(/^\/proyectos$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, formatProjectsAscii(secretaryState, msg.chat.id), { parse_mode: "Markdown" });
});

bot.onText(/^\/perfiles$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, formatProfilesAscii(secretaryState, msg.chat.id), { parse_mode: "Markdown" });
});

bot.onText(/^\/perfil(?:\s+(.+))?$/, async (msg, match) => {
  const input = match && match[1] ? match[1].trim() : "";
  if (!input) {
    await showActiveProfile(msg.chat.id);
    return;
  }

  await changeProfile(msg.chat.id, input);
});

// Callback queries handler for inline buttons
bot.on("callback_query", async (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;
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
    }

    if (targetModelId) {
      activeModels.set(chatId, targetModelId);
      const config = MODELS_CONFIG[targetModelId];
      const balanceStr = await fetchBalance();

      bot.answerCallbackQuery(callbackQuery.id, { text: `Modelo cambiado a ${targetName}` });

      const updatedMenuText = `🤖 *PANEL DE CONTROL (The Wise Pipeline)*\n\n` +
                              `• *Modelo Activo:* \`${config.name}\`\n` +
                              `• *ID Técnico:* \`${targetModelId}\`\n` +
                              `• *Precios (1M tokens):* Entrada \`$${config.inputPrice.toFixed(2)}\` | Salida \`$${config.outputPrice.toFixed(2)}\` ${targetModelId === 'google/gemini-2.5-flash' ? '\n🔥 _¡Coste Cero! Llamada directa gratis via tu API Key de Google._' : ''}\n` +
                              `• *Saldo OpenRouter:* \`${balanceStr}\`\n\n` +
                              `👉 *Selecciona un modelo tocando las opciones del panel:*`;

      const updatedInlineKeyboard = [
        [
          { text: `🧠 Qwen 3 Max ($0.78/$3.90) ${targetModelId === 'qwen/qwen3-max' ? '✅' : ''}`, callback_data: 'set_model:qwen' }
        ],
        [
          { text: `💻 Claude Code ($3.00/$15.00) ${targetModelId === 'anthropic/claude-sonnet-4.6' ? '✅' : ''}`, callback_data: 'set_model:claude' }
        ],
        [
          { text: `🌐 Gemini 2.5 Flash (Directo - GRATIS) ${targetModelId === 'google/gemini-2.5-flash' ? '✅' : ''}`, callback_data: 'set_model:gemini' }
        ],
        [
          { text: `⚡ Qwen 3 Coder ($0.11/$0.80) ${targetModelId === 'qwen/qwen3-coder-next' ? '✅' : ''}`, callback_data: 'set_model:flash' }
        ]
      ];

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

bot.onText(/\/status/, async (msg) => {
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

// ─── Local Console Command Runner (Realtime Polling Bridge) ──────────────────
async function runLocalCommand(chatId, commandText) {
  if (!supabase) {
    return bot.sendMessage(chatId, "❌ Supabase no está configurada.");
  }
  
  const statusMsg = await bot.sendMessage(chatId, `⏳ *Enviando comando a tu PC local...*\n\`${commandText}\``, { parse_mode: "Markdown" });
  
  try {
    const { data, error } = await supabase
      .from("antigravity_local_queue")
      .insert({ command: commandText, status: "pending" })
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
        await bot.editMessageText(`❌ *Error al consultar estatus del comando:*\n\`${pollError.message}\``, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "Markdown"
        });
        return;
      }
      
      if (job.status === "completed" || job.status === "failed") {
        clearInterval(interval);
        
        const statusIndicator = job.status === "completed" ? "✅" : "❌";
        const resultHeader = `${statusIndicator} *Consola (PC Local) — ID ${jobId}*\n\n`;
        const formattedResult = `\`\`\`\n${job.result}\n\`\`\``;
        
        await bot.editMessageText(resultHeader + formattedResult, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "Markdown"
        });
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        await bot.editMessageText(`⚠️ *Tiempo de espera agotado.*\nEl PC local no respondió al comando en 30 segundos. Verifica que \`node antigravity-bridge.js\` esté corriendo en tu PC.`, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "Markdown"
        });
      }
    }, 1500);
    
  } catch (err) {
    await bot.editMessageText(`❌ *Error al insertar comando:* \`${err.message}\``, {
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
      bot.sendMessage(chatId, "❌ Por favor escribe un comando después de la 🖥️ (Ej: `🖥️ dir` o `🖥️ git status`).", { parse_mode: "Markdown" });
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

// ─── Startup ──────────────────────────────────────────────────────────────────
console.log(chalk.bold.cyan("\n  🧠 QWEN/GEMINI TELEGRAM BOT (ax7.createga)"));
console.log(chalk.gray("  ─────────────────────────────────────────────"));
console.log(chalk.white(`  Modelo  : ${MODEL}`));
console.log(chalk.white(`  Acceso  : ${ALLOWED ? `ID de Usuario ${ALLOWED} únicamente` : "Abierto a todos"}`));
console.log(chalk.green("  Estado  : En línea y escuchando peticiones...\n"));
