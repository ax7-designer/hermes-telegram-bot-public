require("dotenv").config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID || process.argv[2];
const message = process.argv.slice(process.env.TELEGRAM_CHAT_ID ? 2 : 3).join(" ").trim()
  || [
    "Hermes despierto.",
    "Prueba de enlace Codex -> Telegram completada.",
    "ax7, el canal responde y seguimos dejando el sistema listo."
  ].join("\n");

async function main() {
  if (!token) {
    throw new Error("Falta TELEGRAM_BOT_TOKEN en .env");
  }
  if (!chatId) {
    throw new Error("Falta TELEGRAM_CHAT_ID en .env o como primer argumento");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message
    })
  });

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(payload.description || "Telegram rechazo el mensaje");
  }

  console.log(JSON.stringify({
    ok: true,
    message_id: payload.result.message_id,
    chat_id: payload.result.chat.id,
    date: payload.result.date
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
