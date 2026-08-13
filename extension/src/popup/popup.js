/* global browser */
"use strict";

/**
 * popup.js — UI расширения. Состояние читает из storage.local (пишет background),
 * действия шлёт background'у сообщениями {kind:"popup", action, ...}.
 * permissions.request вызывается только здесь и только по жесту пользователя (N2).
 */

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  offline: "Нет соединения",
  pending_approval: "Ожидает подтверждения",
  active: "Сессия активна",
  denied: "Сессия отклонена",
};

let state = {
  sessionStatus: "offline",
  lastError: "",
  presets: [],
  policyPreset: "",
  policyVersion: 0,
  needHostPermission: false,
  paused: false,
  journal: [],
  lastAction: null,
  autoPaused: [],
  injectorRegistered: false,
  injectorPatterns: [],
  injectorTs: 0,
  sessionGrants: [],
  serverUrl: "",
  secret: "",
};

let currentDomain = "";
let grantMsgDirty = false; // клик-обработчик поставил своё сообщение — render не затирает

function send(action, extra) {
  return browser.runtime
    .sendMessage(Object.assign({ kind: "popup", action }, extra || {}))
    .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch (e) {
    return "";
  }
}

function render() {
  const st = state.sessionStatus || "offline";
  $("connText").textContent = STATUS_TEXT[st] || st;
  $("connDot").className =
    "dot " + (st === "active" ? "on" : st === "pending_approval" ? "wait" : "off");

  const err = state.lastError || "";
  $("lastError").classList.toggle("hidden", !err);
  $("lastError").textContent = err;

  // Диагностика инжектора content scripts
  const injPatterns = Array.isArray(state.injectorPatterns) ? state.injectorPatterns : [];
  $("injectorStatus").textContent = state.injectorRegistered
    ? "Инжектор: зарегистрировано " + injPatterns.length + " паттернов"
    : "Инжектор: НЕ зарегистрирован";
  $("injectorStatus").title = injPatterns.join("\n");

  $("approvalBox").classList.toggle("hidden", st !== "pending_approval");
  $("hostPermBox").classList.toggle("hidden", !state.needHostPermission);

  // Авто-паузенные вкладки (§6)
  const autoPaused = Array.isArray(state.autoPaused) ? state.autoPaused : [];
  $("autoPauseBox").classList.toggle("hidden", autoPaused.length === 0);
  const apUl = $("autoPauseList");
  apUl.innerHTML = "";
  for (const item of autoPaused) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "ap-label";
    const reason = String(item.reason || "").replace(/^auto:/, "");
    label.textContent = `${item.domain || "вкладка " + item.tabId} — ${reason}`;
    label.title = (item.flags || []).join(", ");
    const btn = document.createElement("button");
    btn.className = "btn ap-resume";
    btn.textContent = "Возобновить";
    btn.addEventListener("click", () => send("resume", { tabId: item.tabId }));
    li.appendChild(label);
    li.appendChild(btn);
    apUl.appendChild(li);
  }

  // Пресеты
  const sel = $("presetSelect");
  const presets = Array.isArray(state.presets) ? state.presets : [];
  sel.innerHTML = "";
  if (!presets.length) {
    const o = document.createElement("option");
    o.textContent = "—";
    o.value = "";
    sel.appendChild(o);
  }
  for (const name of presets) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name + (name === state.policyPreset ? " (активный)" : "");
    if (name === state.policyPreset) o.selected = true;
    sel.appendChild(o);
  }
  sel.disabled = !presets.length || st !== "active";

  // Пауза
  const btn = $("btnPause");
  btn.textContent = state.paused ? "СНЯТЬ ПАУЗУ" : "ПАУЗА";
  btn.classList.toggle("paused", !!state.paused);

  // Последнее действие
  const la = state.lastAction;
  $("lastAction").textContent = la
    ? `${fmtTime(la.ts)}  ${la.method}  ${la.domain || ""}  — ${la.outcome}`
    : "—";

  // Журнал
  const ul = $("journal");
  ul.innerHTML = "";
  const items = (state.journal || []).slice(-20).reverse();
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = `${fmtTime(it.ts)}  ${it.method}  ${it.domain || ""}  — ${it.outcome}`;
    ul.appendChild(li);
  }
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "пусто";
    ul.appendChild(li);
  }

  $("grantDomain").textContent = currentDomain || "—";
  // Разовый грант: подтверждение/дизейбл для уже выданного домена.
  const granted = (state.sessionGrants || []).includes(currentDomain);
  $("btnGrant").disabled = !currentDomain || st !== "active" || granted;
  if (granted) {
    $("grantMsg").textContent = "Грант выдан: " + currentDomain + " (read+interact, сессия)";
  } else if (!grantMsgDirty) {
    $("grantMsg").textContent = "";
  }

  // Настройки (не затираем поле, пока пользователь его редактирует)
  if (document.activeElement !== $("inUrl")) $("inUrl").value = state.serverUrl || "";
  if (document.activeElement !== $("inSecret")) $("inSecret").value = state.secret || "";
}

async function loadState() {
  const stored = await browser.storage.local.get({
    sessionStatus: "offline",
    lastError: "",
    presets: [],
    policyPreset: "",
    policyVersion: 0,
    needHostPermission: false,
    paused: false,
    journal: [],
    lastAction: null,
    autoPaused: [],
    injectorRegistered: false,
    injectorPatterns: [],
    injectorTs: 0,
    sessionGrants: [],
    serverUrl: "ws://127.0.0.1:18777",
    secret: "",
  });
  state = stored;
  render();
}

async function loadCurrentDomain() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const url = tabs[0] && tabs[0].url;
    currentDomain = url && /^https?:/.test(url) ? new URL(url).host : "";
  } catch (e) {
    currentDomain = "";
  }
  grantMsgDirty = false; // смена вкладки — сообщение гранта пересоздаётся
  render();
}

function flashSave(msg) {
  $("saveMsg").textContent = msg;
  setTimeout(() => {
    $("saveMsg").textContent = "";
  }, 2500);
}

// ---------- обработчики ----------

$("btnApprove").addEventListener("click", () => send("approve"));
$("btnDeny").addEventListener("click", () => send("deny"));

$("btnHostPerm").addEventListener("click", async () => {
  // Только здесь и только по жесту пользователя (N2).
  const granted = await browser.permissions
    .request({ origins: ["<all_urls>"] })
    .catch(() => false);
  if (granted) await send("hostPermissionGranted");
});

$("presetSelect").addEventListener("change", async (e) => {
  const name = e.target.value;
  if (name) await send("preset.switch", { name });
});

$("btnGrant").addEventListener("click", async () => {
  if (!currentDomain) return;
  const res = await send("grant.add", { domain: currentDomain });
  grantMsgDirty = true;
  if (res && res.ok) {
    // sessionGrants в storage обновит background → render покажет подтверждение сам.
    $("grantMsg").textContent = "Грант выдан: " + currentDomain + " (read+interact, сессия)";
    $("btnGrant").disabled = true;
  } else {
    $("grantMsg").textContent = "Ошибка гранта: " + ((res && res.error) || "нет ответа");
  }
});

$("btnPause").addEventListener("click", () => send("pause.global", { paused: !state.paused }));

$("btnSave").addEventListener("click", async () => {
  await browser.storage.local.set({
    serverUrl: $("inUrl").value.trim() || "ws://127.0.0.1:18777",
    secret: $("inSecret").value.trim(),
  });
  flashSave("сохранено — переподключение…");
});

// ---------- live-обновление ----------
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(changes)) {
    state[key] = changes[key].newValue;
  }
  render();
});

loadState();
loadCurrentDomain();
