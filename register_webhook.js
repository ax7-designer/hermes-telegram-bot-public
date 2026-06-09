require("dotenv").config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const baseUrl = (process.env.TELEGRAM_WEBHOOK_URL || process.argv[2] || "").replace(/\/$/, "");
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || (token ? token.split(":")[1].slice(0, 24) : "");

async function main() {
  if (!token) {
    throw new Error("Falta TELEGRAM_BOT_TOKEN");
  }
  if (!baseUrl) {
    throw new Error("Falta TELEGRAM_WEBHOOK_URL o URL como argumento");
  }
  if (!secret) {
    throw new Error("No se pudo generar TELEGRAM_WEBHOOK_SECRET");
  }

  const webhookUrl = `${baseUrl}/telegram/${secret}`;
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false
    })
  });

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(payload.description || "Telegram rechazo el webhook");
  }

  const infoResponse = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const info = await infoResponse.json();
  console.log(JSON.stringify({
    ok: true,
    urlSet: Boolean(info.result && info.result.url),
    pending_update_count: info.result && info.result.pending_update_count,
    last_error_message: info.result && info.result.last_error_message || null,
    allowed_updates: info.result && info.result.allowed_updates || null
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});
