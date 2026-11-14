/**
 * safe-actions.js — Safe Predefined Project Actions Allowlist
 * 
 * Replaces arbitrary shell command execution with a strict, closed allowlist
 * of read-only project diagnostic and status actions.
 * 
 * SECURITY RULES:
 * 1. Arbitrary shell command execution is prohibited.
 * 2. No free-form command strings are passed to shell interpolators.
 * 3. Only explicit action IDs in ALLOWED_ACTIONS can be executed.
 * 4. Unknown actions or syntax containing shell metacharacters (; && | ` $ > <) are rejected immediately.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");

const ALLOWED_ACTIONS = {
  "help": {
    name: "help",
    description: "Muestra la lista de acciones seguras de solo lectura permitidas.",
    execute: async () => {
      const actions = Object.entries(ALLOWED_ACTIONS)
        .map(([key, item]) => `• \`${key}\`: ${item.description}`)
        .join("\n");
      return `🛡️ *Acciones Seguras Permitidas (Solo Lectura):*\n\n${actions}\n\n⚠️ *Nota de seguridad:* La ejecución de comandos libres de consola está deshabilitada. Solo se admiten estas acciones predefinidas.`;
    }
  },

  "status": {
    name: "status",
    description: "Muestra el estado del entorno de Node.js, memoria, plataforma y hora local.",
    execute: async () => {
      const memoryUsage = process.memoryUsage();
      const formatMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
      const uptimeMin = (process.uptime() / 60).toFixed(1);
      
      return [
        "📊 *Estado del Proceso y Entorno Local*",
        `• Sistema Operativo: \`${os.type()} ${os.release()} (${os.arch()})\``,
        `• Node.js: ${process.version}`,
        `• Uptime del proceso: ${uptimeMin} min`,
        `• Memoria RSS: ${formatMB(memoryUsage.rss)}`,
        `• Memoria Heap Usada: ${formatMB(memoryUsage.heapUsed)} / ${formatMB(memoryUsage.heapTotal)}`,
        `• Directorio raíz: \`${PROJECT_ROOT}\``,
        `• Fecha y hora local: ${new Date().toLocaleString("es-MX", { timeZone: "America/Cancun" })}`
      ].join("\n");
    }
  },

  "git-status": {
    name: "git-status",
    description: "Ejecuta un 'git status --short' de solo lectura en D:\\AI\\Hermes.",
    execute: async () => {
      return new Promise((resolve) => {
        // Use execFile with explicit arguments — no shell interpolation
        execFile("git", ["status", "--short"], { cwd: PROJECT_ROOT, timeout: 5000 }, (err, stdout, stderr) => {
          if (err) {
            if (err.message && err.message.includes("not a git repository")) {
              return resolve("ℹ️ D:\\AI\\Hermes no está inicializado como repositorio git independiente (o no tiene carpeta .git raíz).");
            }
            return resolve(`⚠️ Error al consultar git: ${err.message}`);
          }
          const output = stdout.trim();
          if (!output) {
            return resolve("✅ Git working tree limpio (sin cambios pendientes).");
          }
          return resolve(`📁 *Git Status (Resumen):*\n\`\`\`\n${output}\n\`\`\``);
        });
      });
    }
  },

  "disk-space": {
    name: "disk-space",
    description: "Reporta el espacio libre y total en los discos principales del sistema.",
    execute: async () => {
      return new Promise((resolve) => {
        // Safe read-only wmic query for logical disks
        execFile("wmic", ["logicaldisk", "get", "Caption,FreeSpace,Size"], { timeout: 5000 }, (err, stdout) => {
          if (err) {
            return resolve(`⚠️ No se pudo consultar el disco: ${err.message}`);
          }
          const lines = stdout.trim().split(/\r?\n/).slice(1);
          const results = [];
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
              const drive = parts[0];
              const freeGB = (parseInt(parts[1], 10) / (1024 ** 3)).toFixed(1);
              const sizeGB = (parseInt(parts[2], 10) / (1024 ** 3)).toFixed(1);
              results.push(`• Disco ${drive}: ${freeGB} GB libres de ${sizeGB} GB`);
            }
          }
          if (results.length === 0) {
            return resolve("ℹ️ No se detectaron discos lógicos mediante wmic.");
          }
          return resolve(`💾 *Almacenamiento Local:*\n${results.join("\n")}`);
        });
      });
    }
  },

  "pendientes-summary": {
    name: "pendientes-summary",
    description: "Muestra las primeras líneas del archivo PENDIENTES.md de Hermes.",
    execute: async () => {
      const filePath = path.resolve(PROJECT_ROOT, "PENDIENTES.md");
      if (!fs.existsSync(filePath)) {
        return "⚠️ Archivo PENDIENTES.md no encontrado en el directorio raíz.";
      }
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split(/\r?\n/).slice(0, 30).join("\n");
        return `📋 *Resumen de PENDIENTES.md (Primeras líneas):*\n\`\`\`markdown\n${lines}\n\`\`\``;
      } catch (err) {
        return `❌ Error al leer PENDIENTES.md: ${err.message}`;
      }
    }
  },

  "health": {
    name: "health",
    description: "Consulta el endpoint /health de Hermes en localhost:10000.",
    execute: async () => {
      try {
        const res = await fetch("http://127.0.0.1:10000/health", { signal: AbortSignal.timeout(3000) });
        if (!res.ok) {
          return `⚠️ Endpoint /health devolvió HTTP ${res.status}`;
        }
        const text = await res.text();
        return `✅ *Hermes Local Health:* HTTP 200 OK — \`${text}\``;
      } catch (err) {
        return `ℹ️ Servicio local en :10000 no responde o está apagado (${err.message}).`;
      }
    }
  }
};

/**
 * Normalizes input and verifies if action is on the strict allowlist.
 */
function normalizeActionName(raw) {
  if (!raw || typeof raw !== "string") return "";
  let cleaned = raw.trim().toLowerCase();
  if (cleaned.startsWith("🖥️")) cleaned = cleaned.replace(/^🖥️\s*/, "");
  if (cleaned.startsWith("cmd:")) cleaned = cleaned.replace(/^cmd:\s*/, "");
  return cleaned.trim();
}

function isAllowedAction(actionName) {
  const norm = normalizeActionName(actionName);
  return Object.prototype.hasOwnProperty.call(ALLOWED_ACTIONS, norm);
}

/**
 * Safely executes an action ONLY if it exists in the allowlist.
 * Rejects all free-form commands, pipes, shell metacharacters, or unknown action names.
 */
async function executeSafeAction(rawInput) {
  const norm = normalizeActionName(rawInput);

  // Reject any shell injection attempts or special characters
  if (/[\&\|\;\`\$\>\<\\\n\r]/.test(norm)) {
    return {
      success: false,
      error: "REJECTED: La entrada contiene caracteres no permitidos. La consola de comandos libres está deshabilitada."
    };
  }

  if (!isAllowedAction(norm)) {
    const validList = Object.keys(ALLOWED_ACTIONS).join(", ");
    return {
      success: false,
      error: `REJECTED: La acción '${rawInput}' no está permitida.\nAcciones seguras admitidas: [${validList}].\nEnvía 'help' para más detalles.`
    };
  }

  try {
    const result = await ALLOWED_ACTIONS[norm].execute();
    return {
      success: true,
      result
    };
  } catch (err) {
    return {
      success: false,
      error: `Error ejecutando acción '${norm}': ${err.message}`
    };
  }
}

function listAllowedActions() {
  return Object.keys(ALLOWED_ACTIONS);
}

module.exports = {
  ALLOWED_ACTIONS,
  normalizeActionName,
  isAllowedAction,
  executeSafeAction,
  listAllowedActions
};
