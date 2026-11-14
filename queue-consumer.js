const plain = (text) => text;

function createQueueHandler({
  supabase,
  queueAuthorizes,
  activeModels,
  modelsConfig,
  askAI,
  safeSendMessage,
  handleHTMLExtraction,
  instanceId,
  logger = console,
  chalk = { yellow: plain, gray: plain, cyan: plain, green: plain, red: plain },
}) {
      return async function handleQueueInsert(payload) {
        const row = payload.new;
        if (!row || row.status !== "pending") return;

        // Reject before claiming — a row for an unauthorized chat is marked failed and never runs.
        const auth = queueAuthorizes(row.chat_id);
        if (!auth.ok) {
          logger.warn(chalk.yellow(`[QODER QUEUE] fila ${row.id} RECHAZADA: ${auth.reason} (chat ${row.chat_id})`));
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
          logger.log(chalk.gray(`[QODER QUEUE] fila ${row.id} ya la tomó otra instancia.`));
          return;
        }
        logger.log(chalk.cyan(`[QODER QUEUE] ${instanceId} procesando fila ${row.id} (chat ${row.chat_id})`));

        const previousModel = activeModels.get(row.chat_id);
        const hasPrev = activeModels.has(row.chat_id);
        if (row.model && modelsConfig[row.model]) {
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
          logger.log(chalk.green(`[QODER QUEUE] ✔ fila ${row.id} respondida (${reply.length} chars)`));
        } catch (err) {
          logger.error(chalk.red(`[QODER QUEUE] ✖ fila ${row.id}: ${err.message}`));
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
      };
}

module.exports = { createQueueHandler };
