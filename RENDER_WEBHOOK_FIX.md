# Hermes Render Webhook Fix

## Diagnostico

Telegram tenia notas de voz pendientes. Eso significa que el bot en Render no estaba consumiendo polling.

## Arreglo aplicado

Hermes ahora usa:

```text
Local: polling
Render: webhook si existe TELEGRAM_WEBHOOK_URL o RENDER_EXTERNAL_URL
```

## SS+

```text
1. Abrir Render > servicio Hermes
2. Copiar la URL publica del servicio
3. Agregar env var:
   TELEGRAM_WEBHOOK_URL=https://TU-SERVICIO.onrender.com
4. Redeploy manual
5. Verificar /health:
   debe decir mode=webhook
6. En Telegram:
   enviar nota de voz "Hermes, proyectos"
```

## Registro manual si hace falta

Desde esta carpeta:

```powershell
npm run webhook:set -- https://TU-SERVICIO.onrender.com
```

## Verificacion Telegram

```powershell
node -e "require('dotenv').config(); fetch('https://api.telegram.org/bot'+process.env.TELEGRAM_BOT_TOKEN+'/getWebhookInfo').then(r=>r.json()).then(j=>console.log(j.result))"
```
