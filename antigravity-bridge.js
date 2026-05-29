require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { exec } = require("child_process");
const chalk = require("chalk");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(chalk.red("❌ Falta SUPABASE_URL o SUPABASE_KEY en el archivo .env"));
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

console.log(chalk.bold.cyan("\n  🖥️  ANTIGRAVITY LOCAL COMMAND BRIDGE"));
console.log(chalk.gray("  ───────────────────────────────────────────"));
console.log(chalk.white("  Conectando a Supabase Realtime..."));

// Subscribe to new commands in the database queue
const subscription = supabase
  .channel("local_commands")
  .on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "antigravity_local_queue",
      filter: "status=eq.pending"
    },
    async (payload) => {
      const { id, command } = payload.new;
      console.log(chalk.yellow(`\n📥 Nuevo comando recibido [ID: ${id}]: `) + chalk.green(command));
      
      try {
        // Mark as executing
        await supabase
          .from("antigravity_local_queue")
          .update({ status: "executing", updated_at: new Date().toISOString() })
          .eq("id", id);
        
        console.log(chalk.gray(`[${id}] Ejecutando en consola de Windows...`));

        // Execute command in Windows shell
        exec(command, { timeout: 30000 }, async (error, stdout, stderr) => {
          let status = "completed";
          let result = "";

          if (error) {
            status = "failed";
            result = `Error: ${error.message}\n`;
          }
          if (stderr) {
            result += `Stderr: ${stderr}\n`;
          }
          if (stdout) {
            result += stdout;
          }

          if (!result) {
            result = "(El comando se ejecutó con éxito pero no devolvió ninguna salida)";
          }

          // Truncate output if it exceeds Telegram/Supabase limits (max 3800 chars to be safe)
          if (result.length > 3800) {
            result = result.substring(0, 3700) + "\n\n... (Salida truncada debido al límite de caracteres) ...";
          }

          console.log(chalk.blue(`[${id}] Comando terminado con estatus: `) + (status === "completed" ? chalk.green(status) : chalk.red(status)));

          // Write results back to Supabase
          const { error: updateError } = await supabase
            .from("antigravity_local_queue")
            .update({
              status,
              result,
              updated_at: new Date().toISOString()
            })
            .eq("id", id);

          if (updateError) {
            console.error(chalk.red(`❌ Error al subir resultados a Supabase: ${updateError.message}`));
          } else {
            console.log(chalk.green(`[${id}] Resultados sincronizados en la nube.`));
          }
        });
      } catch (err) {
        console.error(chalk.red(`❌ Error general procesando comando: ${err.message}`));
      }
    }
  )
  .subscribe((status) => {
    if (status === "SUBSCRIBED") {
      console.log(chalk.green("✅ Escuchando la cola de Supabase en vivo (24/7)..."));
    } else {
      console.log(chalk.yellow(`⚠️ Estatus de suscripción: ${status}`));
    }
  });

// Keep process alive
process.on("SIGINT", () => {
  console.log(chalk.yellow("\nDesconectando bridge de Antigravity..."));
  subscription.unsubscribe();
  process.exit(0);
});
