function createPcPoller({
  supabase,
  editMessageText,
  chatId,
  messageId,
  actionName,
  jobId,
  timers = globalThis,
  maxAttempts = 20,
  intervalMs = 1500,
  logger = console,
}) {
  const plain = { chat_id: chatId, message_id: messageId };
  const markdown = { ...plain, parse_mode: "Markdown" };

  function start() {
    let attempts = 0;
    let stopped = false;
    const interval = timers.setInterval(tick, intervalMs);

    function stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(interval);
    }

    async function tick() {
      if (stopped) return;
      let ownsExit = false;
      try {
        const attempt = ++attempts;
        const { data: job, error: pollError } = await supabase
          .from("antigravity_local_queue")
          .select("status, result")
          .eq("id", jobId)
          .single();
        if (stopped) return;

        if (pollError) {
          ownsExit = true;
          stop();
          await editMessageText(`❌ *Error al consultar estatus de la acción:*\n\`${pollError.message}\``, markdown);
          return;
        }
        if (!job) throw new Error("No se encontró la acción");

        if (job.status === "completed" || job.status === "failed") {
          ownsExit = true;
          stop();
          const statusIndicator = job.status === "completed" ? "✅" : "❌";
          const resultHeader = `${statusIndicator} *Acción Local (${actionName}) — ID ${jobId}*\n\n`;
          const formattedResult = `${job.result}`;
          const text = resultHeader + formattedResult;
          try {
            await editMessageText(text, markdown);
          } catch (err) {
            if (!/can't parse entities|parse entities/i.test(err?.message)) throw err;
            await editMessageText(text, plain);
          }
        } else if (attempt >= maxAttempts) {
          ownsExit = true;
          stop();
          await editMessageText(`⚠️ *Tiempo de espera agotado.*\nEl PC local no respondió a la acción en 30 segundos. Verifica que \`node antigravity-bridge.js\` esté corriendo en tu PC.`, markdown);
        }
      } catch (err) {
        if (stopped && !ownsExit) return;
        stop();
        try {
          await editMessageText(`❌ Error en la acción local: ${err?.message ?? err}`, plain);
        } catch (reportError) {
          logger.error("[PC] No se pudo reportar el error del sondeo:", reportError);
        }
      }
    }
  }

  return { start };
}

module.exports = { createPcPoller };
