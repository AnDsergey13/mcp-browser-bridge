/* global browser, WebSocket, BridgeInjector, BridgeOwners, BridgeConfig, BridgeKeepalive, BridgeFileRelay */
"use strict";

/**
 * background.js — WS-клиент к bridge-server (PROTOCOL.md), мульти-подключения (D11).
 *
 * Firefox: persistent background page (N1, MV2). Chromium: MV3 service worker
 * (загружается через sw-loader.js → importScripts; слушатели регистрируются
 * синхронно на top-level, состояние — в storage.local, keepalive — alarms).
 *
 * Архитектура:
 *  - ServerConnection (фабрика) инкапсулирует всю WS-логику одного подключения:
 *    config, connect/reconnect/hello, pendingReqs/ackWaiters, sessionStatus,
 *    policyPatterns, журнал с меткой label. Подключений — массив `connections`
 *    (конфиг — storage.local["servers"], миграция legacy — config.js).
 *  - Владение вкладками (owners.js): tabId → label; чужие команды → TAB_NOT_OWNED;
 *    авто-назначение при одном подключении сохраняет прежнее одиночное поведение.
 *  - Общее на весь браузер (один браузер = один набор вкладок): netLog
 *    (webRequest), tryInjectContentScripts, реестр авто-пауз, injector
 *    (объединение match_patterns всех подключений — осознанное упрощение,
 *    изоляция идёт роутингом команд по владельцам, а не инжекцией).
 */

// ---------- константы ----------
const REQ_TIMEOUT_MS = 30000; // таймаут res на req (§1)
const NAV_TIMEOUT_MS = 10000; // ожидание загрузки вкладки
const POST_NAV_TIMEOUT_MS = 15000; // ожидание «тихого окна» в content script (+ запас)
const CLICK_CMD_TIMEOUT_MS = 20000; // 2 c nav-watch + тихое окно + after в контенте
const CLICK_RECOVERY_TIMEOUT_MS = 12000; // сторожевой таймаут восстановления после смерти контекста
const ACK_BG_TIMEOUT_MS = 20000; // таймаут file.ack на чанк файлового релея (§8)
const JOURNAL_LIMIT = 20;
const NOTIF_PREFIX = "bridge-session-"; // id уведомления = NOTIF_PREFIX + label

// ---------- общее состояние ----------
let paused = false;
let reinjectDone = false; // П2-6: одноразовая переинжекция открытых вкладок
/** @type {Array} подключения к серверам (ServerConnection) */
const connections = [];
/** Кэш per-connection состояния для popup; персистится как storage.local["connState"]. */
const connStateCache = {};
/**
 * Реестр авто-паузенных вкладок (§6): tabId → {reason, flags, domain, url, ts, conn}.
 * Пополняется по pause.auto от content script; чистится по tabs.onRemoved и
 * после успешной отправки evt resume. pause.global реестр НЕ трогает.
 * conn — label подключения-владельца вкладки (resume уходит туда же).
 */
const autoPausedTabs = new Map();

// Загрузку реестра владельцев начинаем СРАЗУ (top-level): сократить гонку
// между пробуждением SW и первыми сообщениями. start() дожидается того же промиса.
const ownersReady = BridgeOwners.load();

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
      conn: info.conn || "",
    });
  }
  saveState({ autoPaused: list });
}

// ---------- netWatch: пассивный лог media-запросов (m3u8/mpd/media) ----------
// Только наблюдение (без блокировок): ищем прямые URL потоков для скачивания.
// Буфер кольцевой, по 50 записей на вкладку; чистится при навигации и закрытии.
// Общий для всех подключений; после рестарта SW теряется — допустимо (in-memory by design).
// NB (MV3 Chromium): webRequest в service worker может не иметь bindings —
// addListener бросает синхронно ("No matching signature", регистрация SW падает,
// status 15). Поэтому регистрация под try/catch: без webRequest мост живёт,
// деградирует только net.list (netlogAvailable=false → честный ответ).
const NETLOG_CAP = 50;
const NETLOG_STREAM_RE = /\.(m3u8|mpd)(\?|#|$)/i;
/** @type {Map<number, Array<{ts:number,url:string,type:string,frameId:number}>>} */
const netLog = new Map();
let netlogAvailable = true;

try {
  browser.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.tabId < 0) return; // фоновые запросы без вкладки не интересны
      if (d.type !== "media" && !NETLOG_STREAM_RE.test(d.url)) return;
      let arr = netLog.get(d.tabId);
      if (!arr) netLog.set(d.tabId, (arr = []));
      arr.push({ ts: Date.now(), url: d.url, type: d.type, frameId: d.frameId });
      if (arr.length > NETLOG_CAP) arr.splice(0, arr.length - NETLOG_CAP);
    },
    { urls: ["<all_urls>"], types: ["media", "xmlhttprequest"] }
  );
} catch (e) {
  netlogAvailable = false;
  console.warn("[bridge] webRequest недоступен (MV3 SW без bindings) — net.list отключён:", e);
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") netLog.delete(tabId);
});
browser.tabs.onRemoved.addListener((tabId) => netLog.delete(tabId));

function netListCommand(params) {
  // MV3 Chromium без webRequest-bindings: честный маркер вместо молчаливого
  // пустого списка — агент/пользователь понимает, что лог не пишется.
  return {
    requests: netLog.get(params.tabId) || [],
    ...(netlogAvailable ? {} : { netlog_unavailable: "webRequest недоступен в MV3 service worker" }),
  };
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

// ---------- connState: per-connection состояние для popup ----------
function connStateOf(label) {
  if (!connStateCache[label]) {
    connStateCache[label] = {
      status: "offline",
      lastError: "",
      presets: [],
      policyPreset: "",
      policyVersion: 0,
      policyDomains: {},
      sessionGrants: [],
      serverSessionId: "",
    };
  }
  return connStateCache[label];
}

async function saveConnState(label, patch) {
  Object.assign(connStateOf(label), patch);
  await saveState({ connState: connStateCache });
}

// ---------- журнал действий (для popup), записи помечены label подключения ----------
async function logAction(method, domain, outcome, connLabel) {
  const entry = { method, domain: domain || "", ts: Date.now(), outcome, conn: connLabel || "" };
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

// ---------- ServerConnection: одно WS-подключение к серверу ----------
/**
 * Фабрика подключения. Всё per-connection состояние — в замыкании:
 * ws, reconnect-backoff, pendingReqs/ackWaiters, policyPatterns, transferCounter.
 */
function createServerConnection(cfg) {
  const label = cfg.label;
  const config = { url: cfg.url, secret: cfg.secret };
  let ws = null;
  let connecting = false;
  let reconnectTimer = null;
  let reconnectDelayMs = 1000; // backoff 1→30 c (§3)
  let reqCounter = 0;
  let transferCounter = 0;
  /** match_patterns политики ЭТОГО сервера — сверка URL вкладки перед page-командой. */
  let policyPatterns = [];
  const notifId = NOTIF_PREFIX + label;

  /** @type {Map<string, {resolve:Function, reject:Function, timer:number}>} наши исходящие req */
  const pendingReqs = new Map();
  /** @type {Map<string, {resolve:Function, timer:number}>} ожидание file.ack от сервера */
  const ackWaiters = new Map();

  connStateOf(label); // дефолты в кэше сразу

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
      console.warn("[bridge][" + label + "] evt не отправлен:", event, e.message);
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
    await saveConnState(label, { status: "offline" });
    try {
      ws = new WebSocket(config.url);
    } catch (e) {
      connecting = false;
      await saveConnState(label, { lastError: "connect: " + e.message });
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      connecting = false;
      reconnectDelayMs = 1000;
      doHello().catch((e) => console.warn("[bridge][" + label + "] hello failed:", e));
    };
    ws.onclose = () => onDisconnected();
    ws.onerror = () => {
      // onclose придёт следом — там и обработаем
    };
    ws.onmessage = (ev) => {
      onWireMessage(ev.data).catch((e) => console.warn("[bridge][" + label + "] onmessage:", e));
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
    saveConnState(label, { status: "offline" });
    scheduleReconnect();
  }

  async function doHello() {
    let res;
    try {
      res = await sendReq("hello", {
        secret: config.secret,
        ext_version: browser.runtime.getManifest().version,
        // clientId на сервере = это поле (D1): короткое имя для policy.yaml
        // (`browsers: [firefox]`), AMBIGUOUS_BROWSER-подсказок и popup.
        browser: /firefox/i.test(navigator.userAgent) ? "firefox" : "chromium",
        ua: navigator.userAgent,
      });
    } catch (e) {
      if (e.code === "AUTH_FAILED") {
        // Неверный секрет: сервер закроет сокет; статус показываем в popup.
        await saveConnState(label, { lastError: "AUTH_FAILED: проверьте секрет в настройках" });
        return;
      }
      throw e;
    }
    const data = res || {};
    // Гранты выдаются scope:"session" — новая серверная сессия = чистый список.
    const prevSid = connStateOf(label).serverSessionId || "";
    const newSid = data.server_session_id || "";
    const patch = {
      lastError: "",
      presets: Array.isArray(data.presets) ? data.presets : [],
      serverSessionId: newSid,
    };
    if (newSid && newSid !== prevSid) patch.sessionGrants = [];
    await saveConnState(label, patch);
    const status = data.status || "pending_approval";
    if (status === "active") {
      await saveConnState(label, { status: "active" });
    } else if (status === "denied") {
      await saveConnState(label, { status: "denied" });
    } else {
      await saveConnState(label, { status: "pending_approval" });
      notifyApproval();
    }
  }

  // ---------- уведомление о новой сессии ----------
  async function notifyApproval() {
    const base = {
      type: "basic",
      title: "Bridge: новая сессия агента",
      message:
        "Сервер «" + label + "» запрашивает доступ к браузеру. Разрешить сессию?",
    };
    try {
      // NB: Firefox пока не рендерит кнопки уведомлений (MDN: поддерживаются только
      // type/title/message/iconUrl) — решение тогда принимается в popup.
      await browser.notifications.create(notifId, {
        ...base,
        buttons: [{ title: "Разрешить" }, { title: "Запретить" }],
      });
    } catch (e) {
      await browser.notifications.create(notifId, base).catch(() => {});
    }
  }

  async function approveSession() {
    try {
      await sendReq("session.approve", {});
      await saveConnState(label, { status: "active" });
    } catch (e) {
      await saveConnState(label, {
        lastError: "session.approve: " + (e.code || e.message),
      });
    }
    browser.notifications.clear(notifId).catch(() => {});
  }

  async function denySession() {
    try {
      await sendReq("session.deny", {});
    } catch (e) {
      // даже при ошибке сети локально сессия отклонена
    }
    await saveConnState(label, { status: "denied" });
    browser.notifications.clear(notifId).catch(() => {});
  }

  // ---------- файловый релей: file.chunk с backpressure (§8) ----------
  // fetch и стриминг — в background (file-relay.js); сюда попадает только
  // отправка чанка с ожиданием file.ack от сервера.
  function sendFileChunk(data) {
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

  // ---------- роутер серверных req (с проверкой владения вкладками, D11) ----------
  async function handleServerReq(msg) {
    const { method } = msg;
    const params = msg.params || {};
    const connCount = connections.length;
    switch (method) {
      case "tab.list": {
        // Подключение видит только СВОИ вкладки; при одиночном подключении —
        // все (неназначенные авто-назначатся при первой команде, owners.js).
        const tabs = await browser.tabs.query({});
        const visible = BridgeOwners.filterVisible(tabs, label, connCount);
        return {
          tabs: visible.map((t) => ({
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
        await BridgeOwners.assign(tab.id, label); // открывший — владелец
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
        await BridgeOwners.assertAccess(params.tabId, label, connCount);
        await browser.tabs.remove(params.tabId);
        await BridgeOwners.release(params.tabId); // onRemoved тоже чистит — дубль безвреден
        return {};
      case "navigate":
      case "back":
      case "reload":
        await BridgeOwners.assertAccess(params.tabId, label, connCount);
        return navCommand(method, params);
      case "click":
        await BridgeOwners.assertAccess(params.tabId, label, connCount);
        return clickCommand(conn, params);
      case "screenshot":
        await BridgeOwners.assertAccess(params.tabId, label, connCount);
        return screenshotCommand(params);
      case "fetchFile":
        await BridgeOwners.assertAccess(params.tabId, label, connCount);
        return fetchFileCommand(conn, params);
      case "netList":
        await BridgeOwners.assertAccess(params.tabId, label, connCount);
        await assertTabDomain(policyPatterns, params.tabId);
        return netListCommand(params);
      case "waitFor": {
        // Content ждёт до 30 с — таймаут команды должен быть больше, иначе
        // вместо честного {condition_met:false} сервер получит TIMEOUT.
        await BridgeOwners.assertAccess(params.tabId, label, connCount);
        await assertTabDomain(policyPatterns, params.tabId);
        const waitMs = Math.min(Math.max(Number(params.timeout_ms) || 10000, 500), 30000);
        return sendCmdToTab(params.tabId, "waitFor", params, waitMs + 10000);
      }
      case "scan":
        // До 20 экранов с человеческим темпом — дедлайн контента 45 с (П2-3).
        await BridgeOwners.assertAccess(params.tabId, label, connCount);
        await assertTabDomain(policyPatterns, params.tabId);
        return sendCmdToTab(params.tabId, "scan", params, 60000);
      case "consent.ask":
        await BridgeOwners.assertAccess(params.tabId, label, connCount);
        return consentCommand(policyPatterns, params);
      default:
        if (CONTENT_METHODS.has(method)) {
          await BridgeOwners.assertAccess(params.tabId, label, connCount);
          await assertTabDomain(policyPatterns, params.tabId);
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
      console.warn("[bridge][" + label + "] не-JSON фрейм проигнорирован");
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
        logAction(msg.method, domain, "ok", label);
      } catch (e) {
        const code = e.code || "INTERNAL";
        try {
          rawSend({ type: "res", id: msg.id, error: { code, message: String(e.message || e) } });
        } catch (sendErr) {
          // сокет умер — ответ уже некуда девать
        }
        logAction(msg.method, domain, "error:" + code, label);
      }
      return;
    }

    if (msg.type === "evt") {
      if (msg.event === "policy.update") {
        await onPolicyUpdate(conn, msg.data || {});
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

  /** Переподключение с новым url/secret (смена конфига в popup). */
  async function reconfigure(next) {
    config.url = next.url;
    config.secret = next.secret;
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
    await saveConnState(label, { status: "offline" });
    connect();
  }

  /** Полное снятие подключения (сервер удалён из конфига). */
  function shutdown() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch (e) {}
      ws = null;
    }
    for (const [id, p] of pendingReqs) {
      clearTimeout(p.timer);
      p.reject(perr("BROWSER_OFFLINE", "подключение удалено"));
      pendingReqs.delete(id);
    }
    for (const [key, w] of ackWaiters) {
      clearTimeout(w.timer);
      w.resolve({ ok: false, error: "BROWSER_OFFLINE" });
      ackWaiters.delete(key);
    }
    delete connStateCache[label];
    saveState({ connState: connStateCache });
  }

  const conn = {
    label,
    config,
    get ws() {
      return ws;
    },
    get policyPatterns() {
      return policyPatterns;
    },
    setPolicyPatterns(patterns) {
      policyPatterns = patterns;
    },
    nextTransferId() {
      return "t_" + ++transferCounter;
    },
    connect,
    reconfigure,
    shutdown,
    approveSession,
    denySession,
    sendReq,
    sendEvt,
    sendFileChunk,
  };
  return conn;
}

// ---------- работа со вкладками (общие хелперы; состояние — у подключений) ----------
async function getTab(tabId) {
  try {
    return await browser.tabs.get(tabId);
  } catch (e) {
    throw perr("NO_TAB", "вкладка " + tabId + " не найдена");
  }
}

// ---------- харденинг: сверка текущего URL вкладки с политикой ----------
// Сервер проверяет политику по последнему известному URL; если пользователь
// вручную увёл вкладку на чужой домен — команду НЕ исполняем (DOMAIN_MISMATCH).
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Простой конвертер match pattern → RegExp (`*://*.host/*`, `*://host/*`). */
function matchPatternToRegExp(pattern) {
  const m = /^(\*|https?):\/\/([^/]*)(\/.*)$/.exec(pattern || "");
  if (!m) return null;
  const scheme = m[1] === "*" ? "https?" : m[1];
  const host = m[2];
  let hostRe;
  if (host.startsWith("*.")) {
    // `*.host` — сам host и его поддомены
    hostRe = "(?:[^/]*\\.)?" + escapeRe(host.slice(2));
  } else {
    hostRe = host.split("*").map(escapeRe).join("[^/]*");
  }
  const pathRe = m[3].split("*").map(escapeRe).join(".*");
  return new RegExp("^" + scheme + "://" + hostRe + pathRe + "$");
}

function urlMatchesPolicy(patterns, url) {
  if (!patterns.length || !url) return false;
  return patterns.some((p) => {
    const re = matchPatternToRegExp(p);
    return re && re.test(url);
  });
}

/** Перед page-командой: актуальный tabs.get(url) должен попадать в match_patterns. */
async function assertTabDomain(patterns, tabId) {
  const tab = await getTab(tabId);
  const url = tab.url || "";
  if (!urlMatchesPolicy(patterns, url)) {
    throw perr(
      "DOMAIN_MISMATCH",
      "текущий URL вкладки " + tabId + " вне match_patterns политики: " + url
    );
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
 * В MV3 executeScript маппится на chrome.scripting.executeScript (compat-browser.js).
 */
async function tryInjectContentScripts(tabId) {
  try {
    if (!(await BridgeInjector.hasHostPermission())) return false;
    for (const file of [
      "src/compat-browser.js",
      "src/snapshot.js",
      "src/consent-banner.js",
      "src/content-bridge.js",
    ]) {
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

/** Вотчер начала полной навигации вкладки (статус loading) — детектор смерти контекста. */
function watchTabNavigating(tabId) {
  let onUpdated;
  let onRemoved;
  function cleanup() {
    browser.tabs.onUpdated.removeListener(onUpdated);
    browser.tabs.onRemoved.removeListener(onRemoved);
  }
  const promise = new Promise((resolve, reject) => {
    onUpdated = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "loading") {
        cleanup();
        resolve("NAV_STARTED");
      }
    };
    onRemoved = (id) => {
      if (id === tabId) {
        cleanup();
        reject(perr("NO_TAB", "вкладка закрыта"));
      }
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
  });
  promise.catch(() => {}); // проигравшая ветвь race не даёт unhandled rejection
  return { promise, cancel: cleanup };
}

/**
 * Восстановление после смерти контекста клика (JS-навигация без якоря):
 * ждём загрузку и опрашиваем новый content script. Общий сторожевой
 * таймаут — сервер никогда не получает 30-секундный TIMEOUT из-за гонки.
 */
async function recoverAfterClickNavigation(tabId, extra) {
  let navTimedOut = false;
  const st = await withTimeout(
    (async () => {
      try {
        await waitTabComplete(tabId, NAV_TIMEOUT_MS);
      } catch (e) {
        if (e.code === "NO_TAB") throw e;
        navTimedOut = true;
      }
      return postNavState(tabId);
    })(),
    CLICK_RECOVERY_TIMEOUT_MS,
    "NAV_TIMEOUT"
  );
  return Object.assign({}, st, extra || {}, {
    navigated: true,
    truncated: !!(st.truncated || navTimedOut),
  });
}

// click: три исхода — ответ контента; anchor-фолбэк (JS подавил клик);
// смерть контекста на лету (JS-навигация) → recover с вотчером loading и сторожем.
async function clickCommand(conn, params) {
  const tabId = params.tabId;
  await assertTabDomain(conn.policyPatterns, tabId);

  const navWatcher = watchTabNavigating(tabId);
  const cmdPromise = sendCmdToTab(tabId, "click", params, CLICK_CMD_TIMEOUT_MS);
  cmdPromise.catch(() => {}); // проигравшая ветвь race
  let st = null;
  let contextDead = false;
  try {
    const winner = await Promise.race([cmdPromise, navWatcher.promise]);
    if (winner === "NAV_STARTED") contextDead = true;
    else st = winner;
  } catch (e) {
    if (e.code === "CONTEXT_DEAD") contextDead = true;
    else {
      navWatcher.cancel();
      throw e;
    }
  } finally {
    navWatcher.cancel();
  }

  if (contextDead) return recoverAfterClickNavigation(tabId);
  if (st && st.anchor_href && !st.navigated) {
    return anchorFallbackNavigation(tabId, st);
  }
  return st;
}

/**
 * Фолбэк навигации по якорю: content script сообщил, что клик не навигировал,
 * но у цели есть абсолютный http(s) href → доводим навигацию сами.
 */
async function anchorFallbackNavigation(tabId, clickResult) {
  try {
    await browser.tabs.update(tabId, { url: clickResult.anchor_href });
  } catch (e) {
    throw perr("INTERNAL", "anchor fallback: " + e.message);
  }
  return recoverAfterClickNavigation(tabId, {
    navigation_fallback: "anchor_href",
    clicked: clickResult.clicked,
  });
}

// П0-5: даунскейл кадра до <=1280px по ширине, JPEG q70 — как обещает
// описание page.screenshot. MV2/Firefox: DOM canvas в persistent background
// page. MV3 service worker: DOM/Image нет → OffscreenCanvas + createImageBitmap.
const SCREENSHOT_MAX_WIDTH = 1280;
async function downscaleScreenshot(dataUrl) {
  try {
    if (typeof document === "undefined") return await downscaleScreenshotSw(dataUrl);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = dataUrl;
    });
    if (!img.width || img.width <= SCREENSHOT_MAX_WIDTH) return dataUrl;
    const scale = SCREENSHOT_MAX_WIDTH / img.width;
    const canvas = document.createElement("canvas");
    canvas.width = SCREENSHOT_MAX_WIDTH;
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } catch (e) {
    console.warn("[bridge] screenshot downscale failed, отдаю оригинал:", e);
    return dataUrl;
  }
}

/**
 * SW-ветка даунскейла (D10): fetch(dataUrl) → blob → createImageBitmap →
 * OffscreenCanvas → convertToBlob(jpeg q70) → base64 вручную по чанкам
 * (FileReader в service worker отсутствует).
 */
async function downscaleScreenshotSw(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  if (!bitmap.width || bitmap.width <= SCREENSHOT_MAX_WIDTH) return dataUrl;
  const scale = SCREENSHOT_MAX_WIDTH / bitmap.width;
  const canvas = new OffscreenCanvas(
    SCREENSHOT_MAX_WIDTH,
    Math.max(1, Math.round(bitmap.height * scale))
  );
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000; // fromCharCode.apply — по чанкам, чтобы не упереться в лимит аргументов
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return "data:image/jpeg;base64," + btoa(bin);
}

async function screenshotCommand(params) {
  const tab = await getTab(params.tabId);
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: 70,
  });
  const scaled = await downscaleScreenshot(String(dataUrl));
  const base64 = String(scaled).split(",")[1] || "";
  return { data_jpeg_base64: base64 };
}

// fetchFile: fetch и стриминг — в BACKGROUND (не в content script): background
// с host-правами <all_urls> не связан CORS страницы — cross-origin редиректы
// на CDN (xet/LFS) проходят (живой кейс HF, 2026-08). tabId по-прежнему нужен:
// assertTabDomain + Referer/Origin из URL вкладки (file-relay.js). res уходит
// СРАЗУ после HTTP-заголовков — серверный transport-timeout 120 c покрывает
// только старт; дальше трансфер живёт на file.chunk/file.ack → file.end.
async function fetchFileCommand(conn, params) {
  await assertTabDomain(conn.policyPatterns, params.tabId);
  const tab = await getTab(params.tabId);
  const transferId = conn.nextTransferId();
  return BridgeFileRelay.start(
    { url: params.url, name: params.name, transferId, referer: tab.url || "" },
    {
      sendStart: (d) => conn.sendEvt("file.start", d),
      sendChunk: (d) => conn.sendFileChunk(d), // Promise file.ack — backpressure
      sendEnd: (d) => conn.sendEvt("file.end", d),
      sendAbort: (d) => conn.sendEvt("file.abort", d),
    }
  );
}

// consent.ask: баннер рисует content script; нет скрипта (challenge-страница) → deny.
// Вкладка ушла с домена политики → консервативный deny с пояснением.
async function consentCommand(patterns, params) {
  const timeoutMs = (Number(params.timeout_ms) || 120000) + 10000;
  try {
    const tab = await getTab(params.tabId);
    if (!urlMatchesPolicy(patterns, tab.url || "")) {
      return { decision: "deny", note: "domain_mismatch: " + (tab.url || "") };
    }
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
  "consoleLog",
]);

/**
 * П2-6: после (пере)запуска/обновления расширения уже открытые вкладки держат
 * СТАРЫЕ content scripts (SETUP.md требовал F5). Один раз по первому
 * policy.update переинжектируем вкладки, чьи URL попадают в match_patterns
 * политики (только грантованные домены, только при host-правах).
 * Скрипты идемпотентны: content-bridge.js имеет guard __BRIDGE_CONTENT_LOADED__;
 * серверный ref-кэш протухает сам (свежий snapshot / авто-retry после STALE_REF).
 * Сверка идёт по ОБЪЕДИНЕНИЮ паттернов всех подключений (content script общий).
 */
async function reinjectOpenTabs() {
  if (reinjectDone) return;
  reinjectDone = true;
  try {
    if (!(await BridgeInjector.hasHostPermission())) return;
    const patterns = unionPatterns();
    const tabs = await browser.tabs.query({});
    for (const t of tabs) {
      if (!t.id || !t.url || !urlMatchesPolicy(patterns, t.url)) continue;
      await tryInjectContentScripts(t.id);
    }
  } catch (e) {
    console.warn("[bridge] reinject:", e);
  }
}

/** Объединение match_patterns всех подключений (дедупликация). */
function unionPatterns() {
  const seen = new Set();
  for (const conn of connections) {
    for (const p of conn.policyPatterns) seen.add(p);
  }
  return Array.from(seen);
}

async function onPolicyUpdate(conn, data) {
  conn.setPolicyPatterns(
    Array.isArray(data.match_patterns)
      ? data.match_patterns.filter((p) => typeof p === "string" && p.length)
      : []
  );
  await saveConnState(conn.label, {
    policyPreset: data.preset || "",
    policyVersion: data.version || 0,
    // Карта доменов с capabilities/source — popup рендерит чекбоксы и список грантов.
    policyDomains: data.domains && typeof data.domains === "object" ? data.domains : {},
  });
  // ОСОЗНАННОЕ УПРОЩЕНИЕ (D11): политика у каждого сервера своя, но content
  // script в странице один, общий — инжектор применяет ОБЪЕДИНЕНИЕ
  // match_patterns всех активных подключений. Изоляция агентов обеспечивается
  // не набором инжекций, а роутингом команд по владельцам вкладок (owners.js)
  // плюс per-connection assertTabDomain по собственным match_patterns.
  try {
    await BridgeInjector.applyPolicy({ match_patterns: unionPatterns() });
  } catch (e) {
    console.warn("[bridge] applyPolicy failed:", e);
    await saveState({ lastError: "applyPolicy: " + e.message });
  }
  reinjectOpenTabs(); // одноразово (П2-6), без await — не блокируем policy.update
}

// ---------- сообщения от popup ----------
/** Подключение по label; без label — первое (одиночный режим: label не обязателен). */
function findConn(label) {
  if (label) return connections.find((c) => c.label === label) || null;
  return connections[0] || null;
}

async function handlePopupAction(msg) {
  switch (msg.action) {
    case "approve": {
      const c = findConn(msg.label);
      if (!c) return { ok: false, error: "подключение не найдено" };
      await c.approveSession();
      return { ok: true };
    }
    case "deny": {
      const c = findConn(msg.label);
      if (!c) return { ok: false, error: "подключение не найдено" };
      await c.denySession();
      return { ok: true };
    }
    case "preset.switch": {
      const c = findConn(msg.label);
      if (!c) return { ok: false, error: "подключение не найдено" };
      const res = await c.sendReq("preset.switch", { name: msg.name });
      return { ok: true, result: res };
    }
    case "grant.add": {
      // capabilities приходят из чекбоксов popup (полный набор, replace).
      const c = findConn(msg.label);
      if (!c) return { ok: false, error: "подключение не найдено" };
      const res = await c.sendReq("grant.add", {
        domain: msg.domain,
        capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : ["read", "interact"],
        scope: "session",
      });
      // Трекинг выданных грантов — popup показывает подтверждение и дизейблит кнопку.
      const grants = connStateOf(c.label).sessionGrants || [];
      if (!grants.includes(msg.domain)) {
        await saveConnState(c.label, { sessionGrants: grants.concat(msg.domain).slice(-50) });
      }
      return { ok: true, result: res };
    }
    case "grant.remove": {
      // Отзыв разового гранта (жест в popup). Сервер обновит match_patterns
      // через policy.update → инжектор перерегистрируется без этого домена.
      const c = findConn(msg.label);
      if (!c) return { ok: false, error: "подключение не найдено" };
      const res = await c.sendReq("grant.remove", { domain: msg.domain });
      const grants = connStateOf(c.label).sessionGrants || [];
      await saveConnState(c.label, { sessionGrants: grants.filter((d) => d !== msg.domain) });
      return { ok: true, result: res };
    }
    case "pause.global": {
      paused = !!msg.paused;
      for (const c of connections) c.sendEvt("pause.global", { paused });
      await saveState({ paused });
      return { ok: true };
    }
    case "resume": {
      // Пользователь снимает АВТО-паузу вкладки (§6): сервер сделает
      // getStateHash + reconcile (STATE_DIVERGED при расхождении).
      // resume уходит подключению-владельцу вкладки (записано при pause.auto).
      const tabId = Number(msg.tabId);
      const info = autoPausedTabs.get(tabId);
      if (!tabId || !info) {
        return { ok: false, error: "вкладка не в авто-паузе" };
      }
      const c = findConn(info.conn) || connections[0];
      if (c) c.sendEvt("resume", { tabId });
      autoPausedTabs.delete(tabId);
      syncAutoPaused();
      return { ok: true };
    }
    case "hostPermissionGranted": {
      const r = await BridgeInjector.onHostPermissionGranted();
      return { ok: true, result: r };
    }
    case "server.add": {
      const url = String(msg.url || "").trim();
      if (!url) return { ok: false, error: "url обязателен" };
      const { servers } = await browser.storage.local.get({ servers: [] });
      const list = Array.isArray(servers) ? servers.slice() : [];
      const label = String(msg.label || "").trim() || "server-" + (list.length + 1);
      if (list.some((s) => s && s.label === label)) {
        return { ok: false, error: "label «" + label + "» уже занят" };
      }
      list.push({ label, url, secret: String(msg.secret || "") });
      await browser.storage.local.set({ servers: list }); // onChanged → reconcile
      return { ok: true, result: { label } };
    }
    case "server.remove": {
      const { servers } = await browser.storage.local.get({ servers: [] });
      const list = (Array.isArray(servers) ? servers : []).filter(
        (s) => s && s.label !== msg.label
      );
      await browser.storage.local.set({ servers: list }); // onChanged → reconcile
      return { ok: true };
    }
    case "tab.assign": {
      // Popup-жест: отдать вкладку выбранному подключению (D11).
      const tabId = Number(msg.tabId);
      const c = findConn(msg.label);
      if (!tabId || !c) return { ok: false, error: "нужны tabId и существующий label" };
      await BridgeOwners.assign(tabId, c.label);
      return { ok: true };
    }
    case "tab.unassign": {
      // Забрать обратно = сделать неназначенной (default-deny при мульти-подключении).
      await BridgeOwners.release(Number(msg.tabId));
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown action" };
  }
}

// ---------- сообщения от content scripts и popup ----------
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
    // Авто-пауза уходит подключению-владельцу вкладки; владельца нет
    // (одиночный режим до первой команды) — всем подключениям.
    const owner = tabId ? BridgeOwners.ownerOf(tabId) : null;
    const targets = owner
      ? connections.filter((c) => c.label === owner)
      : connections.slice();
    const primary = targets.length ? targets[0].label : owner || "";
    for (const c of targets) {
      c.sendEvt("pause.auto", {
        tabId,
        reason: d.reason || "",
        flags: Array.isArray(d.flags) ? d.flags : [],
      });
    }
    if (tabId) {
      autoPausedTabs.set(tabId, {
        reason: d.reason || "",
        flags: Array.isArray(d.flags) ? d.flags : [],
        domain,
        url: tabUrl,
        ts: Date.now(),
        conn: primary,
      });
      syncAutoPaused();
    }
    return undefined;
  }

  if (msg.kind === "popup") {
    return handlePopupAction(msg).catch((e) => ({
      ok: false,
      error: (e && e.code ? e.code + ": " : "") + String((e && e.message) || e),
    }));
  }

  return undefined;
});

// ---------- уведомления: кнопки approve/deny (id = префикс + label) ----------
browser.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (!notifId || notifId.indexOf(NOTIF_PREFIX) !== 0) return;
  const conn = findConn(notifId.slice(NOTIF_PREFIX.length));
  if (!conn) return;
  if (btnIdx === 0) conn.approveSession();
  else conn.denySession();
});

// Закрытая вкладка выпадает из реестров авто-пауз и владельцев.
browser.tabs.onRemoved.addListener((tabId) => {
  if (autoPausedTabs.delete(tabId)) syncAutoPaused();
  BridgeOwners.release(tabId);
});

// ---------- реакция на смену списка серверов ----------
/** Сверка массива connections с конфигом: удалить исчезнувшие, добавить новые, переподключить изменённые. */
async function reconcileServers(servers) {
  // удалить исчезнувшие
  for (const conn of connections.slice()) {
    const cfg = servers.find((s) => s.label === conn.label);
    if (!cfg) {
      conn.shutdown();
      connections.splice(connections.indexOf(conn), 1);
      // Вкладки удалённого подключения становятся неназначенными (default-deny).
      await BridgeOwners.releaseAll(conn.label);
      continue;
    }
    if (cfg.url !== conn.config.url || cfg.secret !== conn.config.secret) {
      await conn.reconfigure({ url: cfg.url, secret: cfg.secret });
    }
  }
  // добавить новые
  for (const cfg of servers) {
    if (!connections.some((c) => c.label === cfg.label)) {
      const conn = createServerConnection(cfg);
      connections.push(conn);
      await saveState({ connState: connStateCache });
      conn.connect();
    }
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.servers && Array.isArray(changes.servers.newValue)) {
    const servers = changes.servers.newValue
      .map((s, i) => BridgeConfig.normalizeServer(s, i))
      .filter(Boolean);
    reconcileServers(servers).catch((e) => console.warn("[bridge] reconcile:", e));
  }
});

// ---------- keepalive (MV3 service worker, D10) ----------
// Слушатель alarms — синхронно на top-level (требование MV3): по будильнику
// мёртвые подключения переподключаются. Живой WS с серверными ping каждые 15 с
// сам держит воркер (Chrome 116+); alarms — страховка.
BridgeKeepalive.install(() => connections);

// ---------- старт ----------
(async function start() {
  const servers = await BridgeConfig.load(); // миграция legacy {serverUrl,secret} → servers
  const stored = await browser.storage.local.get({
    paused: false,
    autoPaused: [],
    connState: {},
  });
  paused = !!stored.paused;
  // MV3: реестр авто-пауз восстанавливаем после рестарта service worker
  // (popup должен показать кнопки resume и после убийства воркера).
  autoPausedTabs.clear();
  for (const item of Array.isArray(stored.autoPaused) ? stored.autoPaused : []) {
    if (item && item.tabId) autoPausedTabs.set(item.tabId, item);
  }
  Object.assign(connStateCache, stored.connState || {});
  await ownersReady;
  await reconcileServers(servers); // создаёт подключения и сразу их connect()'ит
  await BridgeKeepalive.arm();
})();
