require("dotenv").config({ path: require("node:path").join(__dirname, ".env") });
const { execFile, spawn } = require("node:child_process");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");
const { parseReportCommand, formatReportResult, createReportPrompt } = require("./pc-report");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const allowedUserId = Number(process.env.ALLOWED_USER_ID);
if (!supabaseUrl || !supabaseKey || !Number.isSafeInteger(allowedUserId) || allowedUserId <= 0) {
  console.error("[PC INFORME] Falta configuración de Supabase o ALLOWED_USER_ID válido.");
  process.exit(1);
}

const workspaceRoot = path.resolve(__dirname, "..", "..");
const dshHome = path.join(workspaceRoot, ".dsh");
const dshCommand = "D:\\Apps\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd";
const supabase = createClient(supabaseUrl, supabaseKey);
let queueTail = Promise.resolve();
let stopping = false;
let activeChild = null;

function terminateChild(child) {
  if (!child?.pid) return;
  execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
}

function runHeadlessReport() {
  return new Promise((resolve, reject) => {
    const command = `call "${dshCommand}" --profile computer-use-headless --permission-mode read-only --approval-policy never -`;
    const env = { ...process.env, DSH_HOME: dshHome, DSH_PERMISSION_MODE: "read-only" };
    delete env.DEEPSEEK_API_KEY;
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: workspaceRoot,
      windowsHide: true,
      windowsVerbatimArguments: true,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    activeChild = child;
    let output = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      terminateChild(child);
      const error = new Error("task timeout");
      error.code = "TIMEOUT";
      finish(error);
    }, 120000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 256_000) {
        terminateChild(child);
        const error = new Error("task output limit");
        error.code = "OUTPUT_LIMIT";
        finish(error);
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (activeChild === child) activeChild = null;
      if (code !== 0) {
        const error = new Error("Harness task failed");
        error.code = `DSH_EXIT_${code}`;
        return finish(error);
      }
      finish(null, output);
    });
    child.stdin.end(createReportPrompt());
  });
}

async function processRow(row) {
  if (!row || row.status !== "pending") return;
  const request = parseReportCommand(row.command, allowedUserId);
  if (!request) return;

  const { data: claimed, error: claimError } = await supabase
    .from("antigravity_local_queue")
    .update({ status: "executing", updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return;

  const startedAt = Date.now();
  let status = "completed";
  let result;
  try {
    result = formatReportResult(await runHeadlessReport());
  } catch (error) {
    status = "failed";
    result = "No se pudo leer el informe. Verifica que esté visible en Edge y que Windows siga con la sesión iniciada.";
    console.warn(`[PC INFORME] Tarea ${row.id} falló en ${Date.now() - startedAt} ms (${error.code || error.name || "error"}).`);
  }

  const { error: updateError } = await supabase
    .from("antigravity_local_queue")
    .update({ status, result, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "executing");
  if (updateError) throw updateError;
  console.log(`[PC INFORME] Tarea ${row.id}: ${status}, ${Date.now() - startedAt} ms.`);
}

function enqueue(row) {
  queueTail = queueTail
    .then(() => processRow(row))
    .catch((error) => console.error(`[PC INFORME] Error de cola (${error.code || error.name || "error"}).`));
}

const subscription = supabase
  .channel("deepseek-pc-report")
  .on("postgres_changes", {
    event: "INSERT",
    schema: "public",
    table: "antigravity_local_queue",
    filter: "status=eq.pending",
  }, (payload) => enqueue(payload.new))
  .subscribe((status) => {
    if (status !== "SUBSCRIBED") {
      console.warn(`[PC INFORME] Estado de suscripción: ${status}.`);
      return;
    }
    console.log("[PC INFORME] Consumidor activo en la sesión interactiva; esperando solicitudes autorizadas.");
    supabase
      .from("antigravity_local_queue")
      .select("id, command, status")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(20)
      .then(({ data, error }) => {
        if (error) console.error(`[PC INFORME] No se pudo revisar la cola pendiente (${error.code || "error"}).`);
        else for (const row of data || []) enqueue(row);
      });
  });

async function shutdown() {
  if (stopping) return;
  stopping = true;
  terminateChild(activeChild);
  await supabase.removeChannel(subscription);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
