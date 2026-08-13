/* global browser, WebSocket, BridgeInjector */
"use strict";

/**
 * background.js — WS-клиент к bridge-server (PROTOCOL.md).
 * Persistent background page (N1, MV2). Хранит конфиг и журнал в storage.local.
 * Браузерозависимая инжекция content scripts вынесена в injector.js (BridgeInjector).
 */

// ---------- конфиг и состояние ----------
const DEFAULT_SERVER_URL = "ws://127.0.0.1:18777";
const REQ_TIMEOUT_MS = 30000; // таймаут res на req (§1)
const NAV_TIMEOUT_MS = 10000; // ожидание загрузки вкладки
const POST_NAV_TIMEOUT_MS = 15000; // ожидание «тихого окна» в content script (+ запас)
const FETCHFILE_TIMEOUT_MS = 10 * 60 * 1000; // релей большого файла
const ACK_BG_TIMEOUT_MS = 20000; // страховка поверх контентных 15 с на file.ack
const JOURNAL_LIMIT = 20;
const NOTIF_SESSION = "bridge-session-approval";

const config = { serverUrl: DEFAULT_SERVER_URL, secret: "" };
let ws = null;
let sessionStatus = "offline"; // offline | pending_approval | active | denied
let paused = false;
let reqCounter = 0;
let transferCounter = 0;
let reconnectDelayMs = 1000; // backoff 1→30 c (§3)
let reconnectTimer = null;
let connecting = false;

/** @type {Map<string, {resolve:Function, reject:Function, timer:number}>} наши исходящие req */
const pendingReqs = new Map();
/** @type {Map<string, {resolve:Function, timer:number}>} ожидание file.ack от сервера */
const ackWaiters = new Map();
/**
 * Реестр авто-паузенных вкладок (§6): tabId → {reason, flags, domain, url, ts}.
 * Пополняется по pause.auto от content script; чистится по tabs.onRemoved и
 * после успешной отправки evt resume. pause.global реестр НЕ трогает — это
 * отдельный уровень паузы.
 */
const autoPausedTabs = new Map();

/** Снимок реестра авто-пауз для popup (storage.local — единый канал состояния). */
function syncAutoPaused() {
  const list = [];
  for (const [tabId, info] of autoPausedTabs) {
    list.push({
      tabId,
      domain: info.domain || "",
      reason: info.reason || "",
      flags: info.flags || [],
      ts: info.ts || 0,
    });
  }
  saveState({ autoPaused: list });
}

// ---------- утилиты ----------
function perr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(perr(code || "TIMEOUT", "таймаут " + ms + " мс")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function saveState(patch) {
  try {
    await browser.storage.local.set(patch);
  } catch (e) {
    console.warn("[bridge] storage.local.set failed:", e);
  }
}

async function setSessionStatus(status, extra) {
  sessionStatus = status;
  await saveState(Object.assign({ sessionStatus: status }, extra || {}));
}

// ---------- журнал действий (для popup) ----------
async function logAction(method, domain, outcome) {
  const entry = { method, domain: domain || "", ts: Date.now(), outcome };
  try {
    const { journal } = await browser.storage.local.get({ journal: [] });
    const next = (journal || []).concat(entry).slice(-JOURNAL_LIMIT);
    await saveState({ journal: next, lastAction: entry });
  } catch (e) {
    console.warn("[bridge] journal failed:", e);
  }
}

async function domainOfTab(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    return tab.url ? new URL(tab.url).host : "";
  } catch (e) {
    return "";
  }
}

// ---------- WS: исходящие ----------
function rawSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw perr("BROWSER_OFFLINE", "WS не подключён");
  }
  ws.send(JSON.stringify(obj));
}

function sendEvt(event, data) {
  try {
    rawSend({ type: "evt", event, data });
  } catch (e) {
    console.warn("[bridge] evt не отправлен:", event, e.message);
  }
}

function sendReq(method, params, timeoutMs) {
  const id = "e_" + ++reqCounter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReqs.delete(id);
      reject(perr("TIMEOUT", "req " + method + " таймаут"));
    }, timeoutMs || REQ_TIMEOUT_MS);
    pendingReqs.set(id, { resolve, reject, timer });
    try {
      rawSend({ type: "req", id, method, params: params || {} });
    } catch (e) {
      clearTimeout(timer);
      pendingReqs.delete(id);
      reject(e);
    }
  });
}

// ---------- WS: подключение, reconnect (§3) ----------
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
}

async function connect() {
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  await setSessionStatus("offline");
  try {
    ws = new WebSocket(config.serverUrl);
  } catch (e) {
    connecting = false;
    await saveState({ lastError: "connect: " + e.message });
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    connecting = false;
    reconnectDelayMs = 1000;
    doHello().catch((e) => console.warn("[bridge] hello failed:", e));
  };
  ws.onclose = () => onDisconnected();
  ws.onerror = () => {
    // onclose придёт следом — там и обработаем
  };
  ws.onmessage = (ev) => {
    onWireMessage(ev.data).catch((e) => console.warn("[bridge] onmessage:", e));
  };
}

function onDisconnected() {
  connecting = false;
  ws = null;
  // Очереди нет: незавершённые запросы фейлим сразу (§3).
  for (const [id, p] of pendingReqs) {
    clearTimeout(p.timer);
    p.reject(perr("BROWSER_OFFLINE", "соединение разорвано"));
    pendingReqs.delete(id);
  }
  for (const [key, w] of ackWaiters) {
    clearTimeout(w.timer);
    w.resolve({ ok: false, error: "BROWSER_OFFLINE" });
    ackWaiters.delete(key);
  }
  setSessionStatus("offline");
  scheduleReconnect();
}

async function doHello() {
  let res;
  try {
    res = await sendReq("hello", {
      secret: config.secret,
      ext_version: browser.runtime.getManifest().version,
      browser: "firefox-family",
      ua: navigator.userAgent,
    });
  } catch (e) {
    if (e.code === "AUTH_FAILED") {
      // Неверный секрет: сервер закроет сокет; статус показываем в popup.
      await saveState({ lastError: "AUTH_FAILED: проверьте секрет в настройках" });
      return;
    }
    throw e;
  }
  const data = res || {};
  await saveState({
    lastError: "",
    presets: Array.isArray(data.presets) ? data.presets : [],
    serverSessionId: data.server_session_id || "",
  });
  const status = data.status || "pending_approval";
  if (status === "active") {
    await setSessionStatus("active");
  } else if (status === "denied") {
    await setSessionStatus("denied");
  } else {
    await setSessionStatus("pending_approval");
    notifyApproval();
  }
}

// ---------- уведомление о новой сессии ----------
async function notifyApproval() {
  const base = {
    type: "basic",
    title: "Bridge: новая сессия агента",
    message: "Сервер запрашивает доступ к браузеру. Разрешить сессию?",
  };
  try {
    // NB: Firefox пока не рендерит кнопки уведомлений (MDN: поддерживаются только
    // type/title/message/iconUrl) — решение тогда принимается в popup.
    await browser.notifications.create(NOTIF_SESSION, {
      ...base,
      buttons: [{ title: "Разрешить" }, { title: "Запретить" }],
    });
  } catch (e) {
    await browser.notifications.create(NOTIF_SESSION, base).catch(() => {});
  }
}

async function approveSession() {
  try {
    await sendReq("session.approve", {});
    await setSessionStatus("active");
  } catch (e) {
    await saveState({ lastError: "session.approve: " + (e.code || e.message) });
  }
  browser.notifications.clear(NOTIF_SESSION).catch(() => {});
}

async function denySession() {
  try {
    await sendReq("session.deny", {});
  } catch (e) {
    // даже при ошибке сети локально сессия отклонена
  }
  await setSessionStatus("denied");
  browser.notifications.clear(NOTIF_SESSION).catch(() => {});
}

browser.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (notifId !== NOTIF_SESSION) return;
  if (btnIdx === 0) approveSession();
  else denySession();
});

// ---------- работа со вкладками ----------
async function getTab(tabId) {
  try {
    return await browser.tabs.get(tabId);
  } catch (e) {
    throw perr("NO_TAB", "вкладка " + tabId + " не найдена");
  }
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(perr("NAV_TIMEOUT", "загрузка вкладки не завершилась за " + timeoutMs + " мс"));
    }, timeoutMs);
    function onUpdated(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    }
    function onRemoved(id) {
      if (id === tabId) {
        cleanup();
        reject(perr("NO_TAB", "вкладка закрыта"));
      }
    }
    function cleanup() {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    }
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
  });
}

/**
 * Самолечение: одноразовая инжекция content scripts через executeScript.
 * Закрывает кейсы «вкладка открыта до регистрации» и «регистрация не сработала».
 * Только при наличии host-прав; ошибка инжекции уходит в lastError.
 */
async function tryInjectContentScripts(tabId) {
  try {
    if (!(await BridgeInjector.hasHostPermission())) return false;
    for (const file of ["src/snapshot.js", "src/consent-banner.js", "src/content-bridge.js"]) {
      await browser.tabs.executeScript(tabId, { file, runAt: "document_idle" });
    }
    return true;
  } catch (e) {
    await saveState({ lastError: "executeScript fallback (tab " + tabId + "): " + e.message });
    return false;
  }
}

/**
 * Команда в content script вкладки. Классифицирует ошибки транспорта:
 *  - CONTENT_SCRIPT_ABSENT — скрипта во вкладке нет (домен вне match_patterns);
 *  - CONTEXT_DEAD — контекст умер на лету (полная навигация во время команды).
 * При отсутствии приёмника один раз пробует executeScript-fallback.
 */
async function sendCmdToTab(tabId, method, params, timeoutMs, _retried) {
  let res;
  try {
    res = await withTimeout(
      browser.tabs.sendMessage(tabId, { kind: "cmd", method, params: params || {} }),
      timeoutMs || REQ_TIMEOUT_MS,
      "TIMEOUT"
    );
  } catch (e) {
    if (e.code === "TIMEOUT") throw e;
    const m = String((e && e.message) || e);
    if (/Receiving end does not exist|Could not establish connection/i.test(m)) {
      if (!_retried && (await tryInjectContentScripts(tabId))) {
        return sendCmdToTab(tabId, method, params, timeoutMs, true);
      }
      throw perr("CONTENT_SCRIPT_ABSENT", "content script отсутствует во вкладке " + tabId);
    }
    if (/disconnect|closed|destroy/i.test(m)) {
      throw perr("CONTEXT_DEAD", "контекст вкладки разрушен: " + m);
    }
    throw perr("INTERNAL", m);
  }
  if (!res) throw perr("INTERNAL", "пустой ответ content script");
  if (!res.ok) throw perr(res.error && res.error.code, (res.error && res.error.message) || "?");
  return res.result;
}

/** Опросить состояние вкладки после загрузки; content script может инжектиться с задержкой. */
async function postNavState(tabId) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await sendCmdToTab(tabId, "__postNav", {}, POST_NAV_TIMEOUT_MS);
    } catch (e) {
      lastErr = e;
      if (e.code !== "CONTENT_SCRIPT_ABSENT") throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

// navigate/back/reload: навигацию делает background, «тихое окно» ждёт content script.
async function navCommand(method, params) {
  const tabId = params.tabId;
  await getTab(tabId); // NO_TAB раньше навигации
  let navigationExpected = true;
  // waiter создаём ДО действия, чтобы не пропустить быстрый complete.
  let waiter = waitTabComplete(tabId, NAV_TIMEOUT_MS);
  // Для неиспользуемого ветвления (back без истории) waiter отменяем ниже.
  waiter.catch(() => {});
  try {
    if (method === "navigate") await browser.tabs.update(tabId, { url: params.url });
    else if (method === "back") {
      // goBack без истории отклоняет промис — это не ошибка протокола,
      // а «остались на месте»: пропускаем ожидание загрузки.
      await browser.tabs.goBack(tabId).catch(() => {
        navigationExpected = false;
      });
    } else await browser.tabs.reload(tabId);
  } catch (e) {
    throw perr("INTERNAL", method + ": " + e.message);
  }
  let navTimedOut = false;
  if (navigationExpected) {
    try {
      await waiter;
    } catch (e) {
      if (e.code === "NO_TAB") throw e;
      navTimedOut = true; // §7: продолжаем с тем, что есть
    }
  }
  const st = await postNavState(tabId);
  return {
    url: st.url,
    title: st.title,
    flags: st.flags,
    truncated: !!(st.truncated || navTimedOut),
  };
}

// click: может убить контекст полной навигацией — тогда дожидаемся новой страницы.
async function clickCommand(params) {
  const tabId = params.tabId;
  await getTab(tabId);
  try {
    return await sendCmdToTab(tabId, "click", params, REQ_TIMEOUT_MS + NAV_TIMEOUT_MS);
  } catch (e) {
    if (e.code !== "CONTEXT_DEAD") throw e;
    let navTimedOut = false;
    try {
      await waitTabComplete(tabId, NAV_TIMEOUT_MS);
    } catch (navErr) {
      if (navErr.code === "NO_TAB") throw navErr;
      navTimedOut = true;
    }
    const st = await postNavState(tabId);
    return {
      url: st.url,
      title: st.title,
      flags: st.flags,
      navigated: true,
      truncated: !!(st.truncated || navTimedOut),
    };
  }
}

async function screenshotCommand(params) {
  const tab = await getTab(params.tabId);
  // TODO(MVP): даунскейл до <=1280px не реализован — captureVisibleTab отдаёт полный кадр.
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: 70,
  });
  const base64 = String(dataUrl).split(",")[1] || "";
  return { data_jpeg_base64: base64 };
}

async function fetchFileCommand(params) {
  await getTab(params.tabId);
  const transferId = "t_" + ++transferCounter;
  const st = await sendCmdToTab(
    params.tabId,
    "fetchFile",
    { url: params.url, name: params.name, transferId },
    FETCHFILE_TIMEOUT_MS
  );
  return { transferId, size: st.size, sha256: st.sha256 };
}

// consent.ask: баннер рисует content script; нет скрипта (challenge-страница) → deny.
async function consentCommand(params) {
  const timeoutMs = (Number(params.timeout_ms) || 120000) + 10000;
  try {
    const st = await sendCmdToTab(params.tabId, "__consent", params, timeoutMs);
    return { decision: st.decision || "deny" };
  } catch (e) {
    return { decision: "deny", note: "content_script_absent: " + e.message };
  }
}

// ---------- роутер серверных req ----------
const CONTENT_METHODS = new Set([
  "type",
  "select",
  "scroll",
  "scrollIntoView",
  "pressKey",
  "hover",
  "snapshot",
  "extractMarkdown",
  "findText",
  "getStateHash",
]);

async function handleServerReq(msg) {
  const { method } = msg;
  const params = msg.params || {};
  switch (method) {
    case "tab.list": {
      const tabs = await browser.tabs.query({});
      return {
        tabs: tabs.map((t) => ({
          tabId: t.id,
          url: t.url || "",
          title: t.title || "",
          active: !!t.active,
        })),
      };
    }
    case "tab.open": {
      const tab = await browser.tabs.create({
        url: params.url,
        active: params.active !== false,
      });
      try {
        await waitTabComplete(tab.id, NAV_TIMEOUT_MS);
      } catch (e) {
        if (e.code === "NO_TAB") throw e;
        // NAV_TIMEOUT — возвращаем то, что есть
      }
      const cur = await getTab(tab.id);
      return { tabId: cur.id, url: cur.url || "", title: cur.title || "" };
    }
    case "tab.close":
      await browser.tabs.remove(params.tabId);
      return {};
    case "navigate":
    case "back":
    case "reload":
      return navCommand(method, params);
    case "click":
      return clickCommand(params);
    case "screenshot":
      return screenshotCommand(params);
    case "fetchFile":
      return fetchFileCommand(params);
    case "consent.ask":
      return consentCommand(params);
    default:
      if (CONTENT_METHODS.has(method)) {
        await getTab(params.tabId);
        return sendCmdToTab(params.tabId, method, params);
      }
      throw perr("INTERNAL", "неизвестный метод: " + method);
  }
}

// ---------- приём сообщений по WS ----------
async function onWireMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    console.warn("[bridge] не-JSON фрейм проигнорирован");
    return;
  }

  if (msg.type === "res") {
    const p = pendingReqs.get(msg.id);
    if (!p) return;
    pendingReqs.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(perr(msg.error.code, msg.error.message));
    else p.resolve(msg.result);
    return;
  }

  if (msg.type === "req") {
    let domain = "";
    if (msg.params && msg.params.tabId) domain = await domainOfTab(msg.params.tabId);
    else if (msg.params && msg.params.url) {
      try {
        domain = new URL(msg.params.url).host;
      } catch (e) {}
    }
    try {
      const result = await handleServerReq(msg);
      rawSend({ type: "res", id: msg.id, result: result || {} });
      logAction(msg.method, domain, "ok");
    } catch (e) {
      const code = e.code || "INTERNAL";
      try {
        rawSend({ type: "res", id: msg.id, error: { code, message: String(e.message || e) } });
      } catch (sendErr) {
        // сокет умер — ответ уже некуда девать
      }
      logAction(msg.method, domain, "error:" + code);
    }
    return;
  }

  if (msg.type === "evt") {
    if (msg.event === "policy.update") {
      await onPolicyUpdate(msg.data || {});
    } else if (msg.event === "file.ack") {
      const d = msg.data || {};
      const key = d.transferId + ":" + d.seq;
      const w = ackWaiters.get(key);
      if (w) {
        ackWaiters.delete(key);
        clearTimeout(w.timer);
        w.resolve({ ok: true });
      }
    }
    return;
  }
}

async function onPolicyUpdate(data) {
  await saveState({
    policyPreset: data.preset || "",
    policyVersion: data.version || 0,
  });
  try {
    await BridgeInjector.applyPolicy(data); // needHostPermission выставит сам
  } catch (e) {
    console.warn("[bridge] applyPolicy failed:", e);
    await saveState({ lastError: "applyPolicy: " + e.message });
  }
}

// ---------- сообщения от content scripts и popup ----------
function handleFileRelay(msg) {
  const data = msg.data || {};
  if (msg.sub === "start") {
    sendEvt("file.start", data);
    return Promise.resolve({ ok: true });
  }
  if (msg.sub === "end") {
    sendEvt("file.end", data);
    return Promise.resolve({ ok: true });
  }
  if (msg.sub === "abort") {
    sendEvt("file.abort", data);
    return Promise.resolve({ ok: true });
  }
  if (msg.sub === "chunk") {
    // Держим ответ content script'у до file.ack от сервера (backpressure, §8).
    return new Promise((resolve) => {
      const key = data.transferId + ":" + data.seq;
      const timer = setTimeout(() => {
        ackWaiters.delete(key);
        resolve({ ok: false, error: "ACK_TIMEOUT" });
      }, ACK_BG_TIMEOUT_MS);
      ackWaiters.set(key, { resolve, timer });
      try {
        rawSend({ type: "evt", event: "file.chunk", data });
      } catch (e) {
        ackWaiters.delete(key);
        clearTimeout(timer);
        resolve({ ok: false, error: e.code || "BROWSER_OFFLINE" });
      }
    });
  }
  return Promise.resolve({ ok: false, error: "unknown sub" });
}

async function handlePopupAction(msg) {
  switch (msg.action) {
    case "approve":
      await approveSession();
      return { ok: true };
    case "deny":
      await denySession();
      return { ok: true };
    case "preset.switch": {
      const res = await sendReq("preset.switch", { name: msg.name });
      return { ok: true, result: res };
    }
    case "grant.add": {
      const res = await sendReq("grant.add", {
        domain: msg.domain,
        capabilities: ["read", "interact"],
        scope: "session",
      });
      return { ok: true, result: res };
    }
    case "pause.global": {
      paused = !!msg.paused;
      sendEvt("pause.global", { paused });
      await saveState({ paused });
      return { ok: true };
    }
    case "resume": {
      // Пользователь снимает АВТО-паузу вкладки (§6): сервер сделает
      // getStateHash + reconcile (STATE_DIVERGED при расхождении).
      const tabId = Number(msg.tabId);
      if (!tabId || !autoPausedTabs.has(tabId)) {
        return { ok: false, error: "вкладка не в авто-паузе" };
      }
      sendEvt("resume", { tabId });
      autoPausedTabs.delete(tabId);
      syncAutoPaused();
      return { ok: true };
    }
    case "hostPermissionGranted": {
      const r = await BridgeInjector.onHostPermissionGranted();
      return { ok: true, result: r };
    }
    default:
      return { ok: false, error: "unknown action" };
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return undefined;

  if (msg.kind === "evt" && msg.event === "pause.auto") {
    const d = msg.data || {};
    const tabId = sender.tab ? sender.tab.id : 0;
    const tabUrl = sender.tab ? sender.tab.url || "" : "";
    let domain = "";
    try {
      domain = tabUrl ? new URL(tabUrl).host : "";
    } catch (e) {}
    sendEvt("pause.auto", {
      tabId,
      reason: d.reason || "",
      flags: Array.isArray(d.flags) ? d.flags : [],
    });
    if (tabId) {
      autoPausedTabs.set(tabId, {
        reason: d.reason || "",
        flags: Array.isArray(d.flags) ? d.flags : [],
        domain,
        url: tabUrl,
        ts: Date.now(),
      });
      syncAutoPaused();
    }
    return undefined;
  }

  if (msg.kind === "file") {
    return handleFileRelay(msg); // Promise → ответ content script'у
  }

  if (msg.kind === "popup") {
    return handlePopupAction(msg).catch((e) => ({
      ok: false,
      error: (e && e.code ? e.code + ": " : "") + String((e && e.message) || e),
    }));
  }

  return undefined;
});

// Закрытая вкладка выпадает из реестра авто-пауз.
browser.tabs.onRemoved.addListener((tabId) => {
  if (autoPausedTabs.delete(tabId)) syncAutoPaused();
});

// ---------- реакция на смену настроек ----------
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let reconnect = false;
  if (changes.serverUrl && typeof changes.serverUrl.newValue === "string") {
    config.serverUrl = changes.serverUrl.newValue || DEFAULT_SERVER_URL;
    reconnect = true;
  }
  if (changes.secret && typeof changes.secret.newValue === "string") {
    config.secret = changes.secret.newValue;
    reconnect = true;
  }
  if (reconnect) {
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch (e) {}
      ws = null;
    }
    for (const [id, p] of pendingReqs) {
      clearTimeout(p.timer);
      p.reject(perr("BROWSER_OFFLINE", "переподключение"));
      pendingReqs.delete(id);
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectDelayMs = 1000;
    setSessionStatus("offline").then(connect);
  }
});

// ---------- старт ----------
(async function start() {
  const stored = await browser.storage.local.get({
    serverUrl: DEFAULT_SERVER_URL,
    secret: "",
    paused: false,
  });
  config.serverUrl = stored.serverUrl || DEFAULT_SERVER_URL;
  config.secret = stored.secret || "";
  paused = !!stored.paused;
  autoPausedTabs.clear();
  await saveState({ autoPaused: [] }); // реестр в памяти пуст после (пере)запуска
  await setSessionStatus("offline");
  connect();
})();
