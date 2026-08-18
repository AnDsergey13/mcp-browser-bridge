/* global browser */
"use strict";

/**
 * popup.js — UI расширения. Состояние читает из storage.local (пишет background),
 * действия шлёт background'у сообщениями {kind:"popup", action, ...}.
 * permissions.request вызывается только здесь и только по жесту пользователя (N2).
 *
 * Мульти-подключения (D11): список серверов (storage "servers"), per-connection
 * статус и approve/deny (storage "connState"), назначение текущей вкладки
 * подключению-владельцу (storage "tabOwners" читаем напрямую, меняем через
 * действия tab.assign/tab.unassign). Пресеты/гранты адресуются выбранному
 * подключению (targetConn).
 */

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  offline: "Нет соединения",
  pending_approval: "Ожидает подтверждения",
  active: "Сессия активна",
  denied: "Сессия отклонена",
};

let state = {
  servers: [],
  connState: {},
  lastError: "",
  needHostPermission: false,
  paused: false,
  journal: [],
  lastAction: null,
  autoPaused: [],
  injectorRegistered: false,
  injectorPatterns: [],
  injectorTs: 0,
  tabOwners: {},
};

let currentDomain = "";
let currentTabId = 0;
let targetLabel = ""; // подключение, которому адресованы пресет/гранты
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

function serverLabels() {
  return (Array.isArray(state.servers) ? state.servers : []).map((s) => s.label);
}

function connInfo(label) {
  return (state.connState && state.connState[label]) || { status: "offline", lastError: "" };
}

/** Подключение-цель пресета/грантов: выбранное, иначе первое. */
function resolveTarget() {
  const labels = serverLabels();
  if (targetLabel && labels.includes(targetLabel)) return targetLabel;
  return labels[0] || "";
}

function render() {
  const labels = serverLabels();
  const infos = labels.map((l) => connInfo(l));

  // Агрегатный статус в шапке
  let agg = "offline";
  if (infos.some((i) => i.status === "pending_approval")) agg = "pending_approval";
  else if (infos.some((i) => i.status === "active")) agg = "active";
  const activeCount = infos.filter((i) => i.status === "active").length;
  $("connText").textContent = labels.length
    ? STATUS_TEXT[agg] + " (" + activeCount + "/" + labels.length + " активно)"
    : "Нет подключений";
  $("connDot").className =
    "dot " + (agg === "active" ? "on" : agg === "pending_approval" ? "wait" : "off");

  const err = state.lastError || "";
  $("lastError").classList.toggle("hidden", !err);
  $("lastError").textContent = err;

  // Диагностика инжектора content scripts
  const injPatterns = Array.isArray(state.injectorPatterns) ? state.injectorPatterns : [];
  $("injectorStatus").textContent = state.injectorRegistered
    ? "Инжектор: зарегистрировано " + injPatterns.length + " паттернов"
    : "Инжектор: НЕ зарегистрирован";
  $("injectorStatus").title = injPatterns.join("\n");

  $("hostPermBox").classList.toggle("hidden", !state.needHostPermission);

  // Список подключений: статус, approve/deny, удаление
  const ul = $("connList");
  ul.innerHTML = "";
  if (!labels.length) {
    const li = document.createElement("li");
    li.textContent = "нет серверов — добавьте в «Настройках»";
    ul.appendChild(li);
  }
  for (const label of labels) {
    const info = connInfo(label);
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className =
      "dot " +
      (info.status === "active" ? "on" : info.status === "pending_approval" ? "wait" : "off");
    const text = document.createElement("span");
    text.className = "conn-label";
    text.textContent = label + " — " + (STATUS_TEXT[info.status] || info.status);
    text.title = info.lastError || "";
    li.appendChild(dot);
    li.appendChild(text);
    if (info.status === "pending_approval") {
      const ok = document.createElement("button");
      ok.className = "btn conn-btn ok";
      ok.textContent = "Разрешить";
      ok.addEventListener("click", () => send("approve", { label }));
      const no = document.createElement("button");
      no.className = "btn conn-btn danger";
      no.textContent = "Запретить";
      no.addEventListener("click", () => send("deny", { label }));
      li.appendChild(ok);
      li.appendChild(no);
    }
    if (labels.length > 1) {
      const del = document.createElement("button");
      del.className = "btn conn-btn";
      del.textContent = "✕";
      del.title = "Удалить подключение (его вкладки станут неназначенными)";
      del.addEventListener("click", () => send("server.remove", { label }));
      li.appendChild(del);
    }
    ul.appendChild(li);
  }

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
    label.title = (item.flags || []).join(", ") + (item.conn ? " [" + item.conn + "]" : "");
    const btn = document.createElement("button");
    btn.className = "btn ap-resume";
    btn.textContent = "Возобновить";
    btn.addEventListener("click", () => send("resume", { tabId: item.tabId }));
    li.appendChild(label);
    li.appendChild(btn);
    apUl.appendChild(li);
  }

  // Владелец текущей вкладки + селектор назначения
  const owners = state.tabOwners && typeof state.tabOwners === "object" ? state.tabOwners : {};
  const owner = currentTabId ? owners[currentTabId] || "" : "";
  $("tabOwner").textContent = currentTabId
    ? owner || "никто (при " + (labels.length > 1 ? "нескольких" : "одном") +
      " подключени" + (labels.length > 1 ? "ях" : "и") + " — " +
      (labels.length > 1 ? "недоступна" : "авто-назначение") + ")"
    : "—";
  const assignSel = $("assignSelect");
  fillSelect(assignSel, labels, owner || "");
  $("btnAssign").disabled = !currentTabId || !labels.length;
  $("btnUnassign").disabled = !currentTabId || !owner;

  // Подключение-цель пресета/грантов
  const target = resolveTarget();
  fillSelect($("targetConn"), labels, target);
  const tInfo = connInfo(target);
  const tActive = tInfo.status === "active";

  // Пресеты целевого подключения
  const sel = $("presetSelect");
  const presets = Array.isArray(tInfo.presets) ? tInfo.presets : [];
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
    o.textContent = name + (name === tInfo.policyPreset ? " (активный)" : "");
    if (name === tInfo.policyPreset) o.selected = true;
    sel.appendChild(o);
  }
  sel.disabled = !presets.length || !tActive;

  // Пауза (глобальная, рассылается всем подключениям)
  const btn = $("btnPause");
  btn.textContent = state.paused ? "СНЯТЬ ПАУЗУ" : "ПАУЗА";
  btn.classList.toggle("paused", !!state.paused);

  // Последнее действие
  const la = state.lastAction;
  $("lastAction").textContent = la
    ? `${fmtTime(la.ts)}  ${la.conn ? "[" + la.conn + "] " : ""}${la.method}  ${la.domain || ""}  — ${la.outcome}`
    : "—";

  // Журнал
  const jul = $("journal");
  jul.innerHTML = "";
  const items = (state.journal || []).slice(-20).reverse();
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = `${fmtTime(it.ts)}  ${it.conn ? "[" + it.conn + "] " : ""}${it.method}  ${it.domain || ""}  — ${it.outcome}`;
    jul.appendChild(li);
  }
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "пусто";
    jul.appendChild(li);
  }

  $("grantDomain").textContent = currentDomain || "—";
  // Чекбоксы capabilities: предзаполняем текущим состоянием гранта (session
  // или preset), но не затираем, пока пользователь редактирует (capDirty).
  const policyDomains = tInfo.policyDomains || {};
  const domInfo = policyDomains[currentDomain] || null;
  if (!capDirty) {
    const caps = domInfo ? domInfo.capabilities || [] : ["read", "interact"];
    $("capRead").checked = caps.includes("read");
    $("capInteract").checked = caps.includes("interact");
    $("capDownload").checked = caps.includes("download");
  }
  const sessionGranted = domInfo && domInfo.source === "session";
  const presetGranted = domInfo && domInfo.source === "preset";
  $("btnGrant").disabled = !currentDomain || !tActive;
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
  const grants = Object.keys(policyDomains).filter(
    (d) => policyDomains[d] && policyDomains[d].source === "session"
  );
  $("grantsBox").classList.toggle("hidden", grants.length === 0);
  const gUl = $("grantsList");
  gUl.innerHTML = "";
  for (const domain of grants) {
    const li = document.createElement("li");
    const lab = document.createElement("span");
    lab.textContent = domain + " (" + (policyDomains[domain].capabilities || []).join(", ") + ")";
    const revoke = document.createElement("button");
    revoke.className = "btn";
    revoke.textContent = "Отозвать";
    revoke.disabled = !tActive;
    revoke.addEventListener("click", () =>
      send("grant.remove", { domain, label: target })
    );
    li.appendChild(lab);
    li.appendChild(document.createTextNode(" "));
    li.appendChild(revoke);
    gUl.appendChild(li);
  }
}

/** Заполнить select значениями, не затирая фокус ввода. */
function fillSelect(sel, values, selected) {
  if (document.activeElement === sel) return;
  sel.innerHTML = "";
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    if (v === selected) o.selected = true;
    sel.appendChild(o);
  }
}

async function loadState() {
  const stored = await browser.storage.local.get({
    servers: [],
    connState: {},
    lastError: "",
    needHostPermission: false,
    paused: false,
    journal: [],
    lastAction: null,
    autoPaused: [],
    injectorRegistered: false,
    injectorPatterns: [],
    injectorTs: 0,
    tabOwners: {},
  });
  state = stored;
  render();
}

async function loadCurrentTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    currentTabId = tab && tab.id ? tab.id : 0;
    const url = tab && tab.url;
    currentDomain = url && /^https?:/.test(url) ? new URL(url).host : "";
  } catch (e) {
    currentTabId = 0;
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

$("btnHostPerm").addEventListener("click", async () => {
  // Только здесь и только по жесту пользователя (N2).
  const granted = await browser.permissions
    .request({ origins: ["<all_urls>"] })
    .catch(() => false);
  if (granted) await send("hostPermissionGranted");
});

$("targetConn").addEventListener("change", (e) => {
  targetLabel = e.target.value;
  render();
});

$("presetSelect").addEventListener("change", async (e) => {
  const name = e.target.value;
  if (name) await send("preset.switch", { name, label: resolveTarget() });
});

$("btnAssign").addEventListener("click", async () => {
  if (!currentTabId) return;
  await send("tab.assign", { tabId: currentTabId, label: $("assignSelect").value });
});

$("btnUnassign").addEventListener("click", async () => {
  if (!currentTabId) return;
  await send("tab.unassign", { tabId: currentTabId });
});

$("btnGrant").addEventListener("click", async () => {
  if (!currentDomain) return;
  const caps = [];
  if ($("capRead").checked) caps.push("read");
  if ($("capInteract").checked) caps.push("interact");
  if ($("capDownload").checked) caps.push("download");
  const label = resolveTarget();
  grantMsgDirty = true;
  if (caps.length === 0) {
    // Все галочки сняты = отзыв гранта (если он был).
    const res = await send("grant.remove", { domain: currentDomain, label });
    $("grantMsg").textContent =
      res && res.ok ? "Грант отозван: " + currentDomain : "Ошибка: " + ((res && res.error) || "нет ответа");
    capDirty = false;
    return;
  }
  const res = await send("grant.add", { domain: currentDomain, capabilities: caps, label });
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

$("btnAddServer").addEventListener("click", async () => {
  const res = await send("server.add", {
    label: $("inLabel").value.trim(),
    url: $("inUrl").value.trim(),
    secret: $("inSecret").value.trim(),
  });
  if (res && res.ok) {
    $("inLabel").value = "";
    // URL возвращаем к дефолту, а не очищаем: popup закрывается при потере
    // фокуса, перепечатывать адрес при каждом добавлении сервера не нужно.
    $("inUrl").value = "ws://127.0.0.1:18777";
    $("inSecret").value = "";
    flashSave("добавлено — подключение…");
  } else {
    flashSave("Ошибка: " + ((res && res.error) || "нет ответа"));
  }
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
loadCurrentTab();
