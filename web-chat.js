"use strict";

// Hermes web chat page: single-file, zero dependencies, served by the bot's own
// HTTP server at GET /chat. Auth reuses the existing proxy bearer token
// (HERMES_PROXY_TOKEN) and the same virtual chat_id range as the OpenAI proxy,
// so conversations keep per-session history in Supabase without new RLS ranges.

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderChatPage(options = {}) {
  const enabled = Boolean(options.enabled);
  const modelLabel = escapeHtml(options.model || "Hermes");
  const stateBanner = enabled
    ? ""
    : '<div class="banner">⚠️ Web chat deshabilitado: falta <code>HERMES_PROXY_TOKEN</code> en el servidor.</div>';

  return '<!doctype html>\n' +
'<html lang="es">\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
'<meta name="theme-color" content="#08080c">\n' +
'<title>HERMES · ax7.createga</title>\n' +
'<style>\n' +
':root{--bg:#08080c;--panel:#101018;--line:#26263a;--txt:#e8e8f0;--dim:#8a8aa3;--blue:#3b82f6;--red:#ff2d55;--purple:#a855f7;--cyan:#22d3ee}\n' +
'*{box-sizing:border-box}\n' +
'html,body{height:100%}\n' +
'body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,rgba(168,85,247,.14),transparent 60%),radial-gradient(900px 500px at 0% 110%,rgba(59,130,246,.12),transparent 60%),var(--bg);color:var(--txt);font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column}\n' +
'header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line);background:rgba(16,16,24,.85);backdrop-filter:blur(8px);position:sticky;top:0;z-index:5}\n' +
'.logo{font:700 18px/1 ui-monospace,Consolas,monospace;letter-spacing:.18em;color:var(--txt);text-shadow:0 0 18px rgba(59,130,246,.55)}\n' +
'.logo b{color:var(--red);text-shadow:0 0 14px rgba(255,45,85,.7)}\n' +
'.dot{width:8px;height:8px;border-radius:50%;background:var(--cyan);box-shadow:0 0 10px var(--cyan)}\n' +
'.meta{margin-left:auto;font:12px/1 ui-monospace,Consolas,monospace;color:var(--dim)}\n' +
'.banner{margin:10px 14px 0;padding:10px 12px;border:1px solid rgba(255,45,85,.5);border-radius:10px;background:rgba(255,45,85,.08);color:#ffd7de;font-size:13px}\n' +
'.banner code{color:#fff}\n' +
'main{flex:1;overflow-y:auto;padding:18px 14px 8px;display:flex;flex-direction:column;gap:12px;max-width:860px;width:100%;margin:0 auto}\n' +
'.msg{max-width:82%;padding:11px 14px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;font-size:14.5px}\n' +
'.msg.user{align-self:flex-end;background:linear-gradient(135deg,rgba(59,130,246,.28),rgba(59,130,246,.14));border:1px solid rgba(59,130,246,.45)}\n' +
'.msg.assistant{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--purple)}\n' +
'.msg.pending{color:var(--dim);font-style:italic}\n' +
'.hint{color:var(--dim);font-size:13px;text-align:center;margin-top:18px}\n' +
'footer{padding:12px 14px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:rgba(16,16,24,.9);position:sticky;bottom:0}\n' +
'.composer{display:flex;gap:10px;max-width:860px;margin:0 auto;align-items:flex-end}\n' +
'textarea{flex:1;resize:none;min-height:46px;max-height:160px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:#0b0b12;color:var(--txt);font:15px/1.4 inherit;outline:none}\n' +
'textarea:focus{border-color:var(--blue);box-shadow:0 0 0 2px rgba(59,130,246,.25)}\n' +
'button{cursor:pointer;border:none;border-radius:12px;font-weight:600}\n' +
'.send{padding:12px 18px;background:linear-gradient(135deg,var(--red),var(--purple));color:#fff;min-height:46px;box-shadow:0 0 18px rgba(255,45,85,.35)}\n' +
'.send:disabled{opacity:.45;box-shadow:none;cursor:default}\n' +
'.clear{background:transparent;color:var(--dim);border:1px solid var(--line);padding:11px 13px;min-height:46px;font-size:13px}\n' +
'.gate{position:fixed;inset:0;background:rgba(8,8,12,.92);display:flex;align-items:center;justify-content:center;z-index:20;padding:18px}\n' +
'.gate.hidden{display:none}\n' +
'.card{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px}\n' +
'.card h1{margin:0 0 6px;font:700 16px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.14em}\n' +
'.card h1 span{color:var(--red)}\n' +
'.card p{margin:0 0 14px;color:var(--dim);font-size:13px}\n' +
'.card input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:#0b0b12;color:var(--txt);font:14px ui-monospace,Consolas,monospace;outline:none;margin-bottom:12px}\n' +
'.card input:focus{border-color:var(--purple);box-shadow:0 0 0 2px rgba(168,85,247,.25)}\n' +
'.card .enter{width:100%;padding:12px;background:linear-gradient(135deg,var(--blue),var(--purple));color:#fff}\n' +
'.card .err{color:#ff8fa3;font-size:12.5px;min-height:16px;margin-top:10px}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'<header>\n' +
'  <span class="dot"></span>\n' +
'  <span class="logo">HERMES<b>·</b>AX7</span>\n' +
'  <span class="meta">' + modelLabel + '</span>\n' +
'</header>\n' +
stateBanner +
'<main id="log"><div class="hint">Escribe abajo. Enter envía · Shift+Enter nueva línea.</div></main>\n' +
'<footer>\n' +
'  <div class="composer">\n' +
'    <textarea id="input" rows="1" placeholder="Mensaje para Hermes…"></textarea>\n' +
'    <button class="clear" id="clear" title="Nueva sesión">Limpiar</button>\n' +
'    <button class="send" id="send">Enviar</button>\n' +
'  </div>\n' +
'</footer>\n' +
'<div class="gate" id="gate">\n' +
'  <form class="card" id="gateForm">\n' +
'    <h1>HERMES <span>·</span> ACCESO</h1>\n' +
'    <p>Introduce el token (<code>HERMES_PROXY_TOKEN</code>). Se guarda solo en esta pestaña.</p>\n' +
'    <input id="token" type="password" autocomplete="off" placeholder="token" ' + (enabled ? '' : 'disabled') + '>\n' +
'    <button class="enter" type="submit" ' + (enabled ? '' : 'disabled') + '>Entrar</button>\n' +
'    <div class="err" id="gateErr"></div>\n' +
'  </form>\n' +
'</div>\n' +
'<script>\n' +
'(function(){\n' +
'  var logEl = document.getElementById("log");\n' +
'  var inputEl = document.getElementById("input");\n' +
'  var sendEl = document.getElementById("send");\n' +
'  var clearEl = document.getElementById("clear");\n' +
'  var gateEl = document.getElementById("gate");\n' +
'  var gateForm = document.getElementById("gateForm");\n' +
'  var tokenEl = document.getElementById("token");\n' +
'  var gateErr = document.getElementById("gateErr");\n' +
'  var TOKEN_KEY = "hermes_web_token";\n' +
'  var SID_KEY = "hermes_web_sid";\n' +
'  var busy = false;\n' +
'\n' +
'  function newSid() {\n' +
'    var sid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);\n' +
'    try { sessionStorage.setItem(SID_KEY, sid); } catch (e) {}\n' +
'    return sid;\n' +
'  }\n' +
'  function sid() {\n' +
'    try { return sessionStorage.getItem(SID_KEY) || newSid(); } catch (e) { return newSid(); }\n' +
'  }\n' +
'  function getToken() {\n' +
'    try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }\n' +
'  }\n' +
'  function setToken(t) {\n' +
'    try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) {}\n' +
'  }\n' +
'  function bubble(role, text) {\n' +
'    var hint = logEl.querySelector(".hint");\n' +
'    if (hint) hint.remove();\n' +
'    var el = document.createElement("div");\n' +
'    el.className = "msg " + role;\n' +
'    el.textContent = text;\n' +
'    logEl.appendChild(el);\n' +
'    logEl.scrollTop = logEl.scrollHeight;\n' +
'    return el;\n' +
'  }\n' +
'  function showGate(message) {\n' +
'    if (message) gateErr.textContent = message; else gateErr.textContent = "";\n' +
'    gateEl.classList.remove("hidden");\n' +
'    if (!tokenEl.disabled) tokenEl.focus();\n' +
'  }\n' +
'  function hideGate() { gateEl.classList.add("hidden"); }\n' +
'\n' +
'  gateForm.addEventListener("submit", function(ev){\n' +
'    ev.preventDefault();\n' +
'    var t = tokenEl.value.trim();\n' +
'    if (!t) { gateErr.textContent = "Escribe el token."; return; }\n' +
'    setToken(t);\n' +
'    hideGate();\n' +
'  });\n' +
'\n' +
'  async function send() {\n' +
'    if (busy) return;\n' +
'    var text = inputEl.value.trim();\n' +
'    if (!text) return;\n' +
'    var token = getToken();\n' +
'    if (!token) { showGate(""); return; }\n' +
'    busy = true; sendEl.disabled = true;\n' +
'    inputEl.value = ""; inputEl.style.height = "auto";\n' +
'    bubble("user", text);\n' +
'    var pending = bubble("assistant pending", "escribiendo…");\n' +
'    try {\n' +
'      var res = await fetch("/chat/api/message", {\n' +
'        method: "POST",\n' +
'        headers: {\n' +
'          "Content-Type": "application/json",\n' +
'          "Authorization": "Bearer " + token,\n' +
'          "x-hermes-session-id": sid()\n' +
'        },\n' +
'        body: JSON.stringify({ text: text })\n' +
'      });\n' +
'      var data = await res.json().catch(function(){ return {}; });\n' +
'      if (res.status === 401) {\n' +
'        pending.remove();\n' +
'        try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}\n' +
'        showGate("Token inválido.");\n' +
'        return;\n' +
'      }\n' +
'      if (!res.ok) {\n' +
'        var msg = (data && data.error && data.error.message) ? data.error.message : ("HTTP " + res.status);\n' +
'        pending.textContent = "⚠️ " + msg;\n' +
'        pending.classList.remove("pending");\n' +
'        return;\n' +
'      }\n' +
'      pending.textContent = (data && data.reply) ? data.reply : "(sin respuesta)";\n' +
'      pending.classList.remove("pending");\n' +
'    } catch (err) {\n' +
'      pending.textContent = "⚠️ Error de red: " + err.message;\n' +
'      pending.classList.remove("pending");\n' +
'    } finally {\n' +
'      busy = false; sendEl.disabled = false;\n' +
'      logEl.scrollTop = logEl.scrollHeight;\n' +
'      inputEl.focus();\n' +
'    }\n' +
'  }\n' +
'\n' +
'  sendEl.addEventListener("click", send);\n' +
'  inputEl.addEventListener("keydown", function(ev){\n' +
'    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send(); }\n' +
'  });\n' +
'  inputEl.addEventListener("input", function(){\n' +
'    inputEl.style.height = "auto";\n' +
'    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";\n' +
'  });\n' +
'  clearEl.addEventListener("click", function(){\n' +
'    while (logEl.firstChild) logEl.removeChild(logEl.firstChild);\n' +
'    var h = document.createElement("div");\n' +
'    h.className = "hint";\n' +
'    h.textContent = "Escribe abajo. Enter envía · Shift+Enter nueva línea.";\n' +
'    logEl.appendChild(h);\n' +
'    newSid();\n' +
'    inputEl.focus();\n' +
'  });\n' +
'\n' +
'  if (getToken()) hideGate(); else showGate("");\n' +
'})();\n' +
'</script>\n' +
'</body>\n' +
'</html>\n';
}

module.exports = { renderChatPage };
