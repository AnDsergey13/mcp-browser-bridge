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
  policyDomains: {},
  serverUrl: "",
  secret: "",
};

let currentDomain = "";
let grantMsgDirty = false; // клик-обработчик поставил своё сообщение — render не затирает
let capDirty = false; // пользователь трогает чекбоксы — render не перезаполняет

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
  // Чекбоксы capabilities: предзаполняем текущим состоянием гранта (session
  // или preset), но не затираем, пока пользователь редактирует (capDirty).
  const domInfo = (state.policyDomains || {})[currentDomain] || null;
  if (!capDirty) {
    const caps = domInfo ? domInfo.capabilities || [] : ["read", "interact"];
    $("capRead").checked = caps.includes("read");
    $("capInteract").checked = caps.includes("interact");
    $("capDownload").checked = caps.includes("download");
  }
  const sessionGranted = domInfo && domInfo.source === "session";
  const presetGranted = domInfo && domInfo.source === "preset";
  $("btnGrant").disabled = !currentDomain || st !== "active";
  $("btnGrant").textContent = sessionGranted
    ? "Обновить грант (сессия)"
    : "Выдать грант (сессия)";
  if (presetGranted && !grantMsgDirty) {
    $("grantMsg").textContent =
      "Доступ из пресета: " + (domInfo.capabilities || []).join(", ") +
      " — session-грант добавит/снимет capabilities поверх (пресет правится в policy.yaml)";
  } else if (sessionGranted && !grantMsgDirty) {
    $("grantMsg").textContent =
      "Грант выдан: " + currentDomain + " (" + (domInfo.capabilities || []).join(", ") + ", сессия)";
  } else if (!grantMsgDirty) {
    $("grantMsg").textContent = "";
  }

  // Список грантов сессии с отзывом (управляет человек, не модель).
  // Источник — policyDomains (authoritative, приходит в policy.update).
  const domains = state.policyDomains || {};
  const grants = Object.keys(domains).filter((d) => domains[d] && domains[d].source === "session");
  $("grantsBox").classList.toggle("hidden", grants.length === 0);
  const gUl = $("grantsList");
  gUl.innerHTML = "";
  for (const domain of grants) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = domain + " (" + (domains[domain].capabilities || []).join(", ") + ")";
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "Отозвать";
    btn.disabled = st !== "active";
    btn.addEventListener("click", () => send("grant.remove", { domain }));
    li.appendChild(label);
    li.appendChild(document.createTextNode(" "));
    li.appendChild(btn);
    gUl.appendChild(li);
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
    policyDomains: {},
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
  capDirty = false; // и чекбоксы предзаполняются под новый домен
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
  const caps = [];
  if ($("capRead").checked) caps.push("read");
  if ($("capInteract").checked) caps.push("interact");
  if ($("capDownload").checked) caps.push("download");
  grantMsgDirty = true;
  if (caps.length === 0) {
    // Все галочки сняты = отзыв гранта (если он был).
    const res = await send("grant.remove", { domain: currentDomain });
    $("grantMsg").textContent =
      res && res.ok ? "Грант отозван: " + currentDomain : "Ошибка: " + ((res && res.error) || "нет ответа");
    capDirty = false;
    return;
  }
  const res = await send("grant.add", { domain: currentDomain, capabilities: caps });
  if (res && res.ok) {
    // policy.update обновит policyDomains → render покажет состояние сам.
    $("grantMsg").textContent = "Грант выдан: " + currentDomain + " (" + caps.join(", ") + ", сессия)";
    capDirty = false;
  } else {
    $("grantMsg").textContent = "Ошибка гранта: " + ((res && res.error) || "нет ответа");
  }
});

for (const id of ["capRead", "capInteract", "capDownload"]) {
  $(id).addEventListener("change", () => {
    capDirty = true;
  });
}

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
