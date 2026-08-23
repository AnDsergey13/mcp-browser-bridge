"use strict";

/**
 * console-hook.js — MAIN-world хук консоли для page.console (модель «боковой
 * линии», как net.list): пассивный сбор console.* + window.onerror +
 * unhandledrejection, чтение буфера — по команде consoleLog.
 *
 * Почему отдельный MAIN-world скрипт: content script работает в изолированном
 * мире (Firefox MV2 sandbox / Chromium MV3 isolated world) и НЕ видит ни вызовы
 * console.* страницы, ни её window.onerror — у него свои глобалы. Вариант без
 * web_accessible_resources (Firefox-only: window.wrappedJSObject +
 * exportFunction/cloneInto) на Chromium MV3 не портируется, поэтому выбран
 * единый для обоих браузеров путь: <script src=...> из
 * web_accessible_resources (внедряет content-bridge.js, только на доменах
 * политики — content script больше нигде не загружается). Страница технически
 * видит хук (stealth — не цель проекта). Жёсткий CSP страницы может запретить
 * загрузку — тогда content script отвечает маркером console_unavailable
 * (по образцу netlog_unavailable), а не молчаливым пустым буфером.
 *
 * Хук только ОТПРАВЛЯЕТ записи в content script через window.postMessage
 * (маркер __bridge_console). Кольцевой буфер, дедуп и точная обрезка — на
 * стороне content script: MAIN-world код держим минимальным. Защита от спама
 * здесь — потолок RATE записей/сек наружу: шумная страница (или подделка
 * маркера самой страницей) не завалит мост postMessage'ами.
 */
(() => {
  if (window.__BRIDGE_CONSOLE_HOOK__) return; // защита от двойной инъекции
  window.__BRIDGE_CONSOLE_HOOK__ = true;

  const TEXT_MAX = 1000; // грубая обрезка в MAIN world; точный лимит — в content script
  const RATE = 50; // потолок записей/сек наружу

  let sent = 0;
  let windowStart = Date.now();

  function fmt(args) {
    const parts = [];
    for (const a of args) {
      try {
        if (typeof a === "string") parts.push(a);
        else if (a instanceof Error) parts.push(String(a.stack || a));
        else {
          const s = JSON.stringify(a); // может кинуть на circular → catch ниже
          parts.push(s != null ? s : String(a));
        }
      } catch (e) {
        parts.push(String(a)); // circular/Proxy — грубый, но живой вариант
      }
    }
    return parts.join(" ").slice(0, TEXT_MAX);
  }

  function post(level, text) {
    try {
      // "*": страницы на opaque origin (about:blank, data:) имеют origin "null" —
      // точный targetOrigin их молча отфильтрует. Секретов в записи нет (это и
      // так данные самой страницы); приёмник проверяет event.source === window.
      window.postMessage({ __bridge_console: true, ts: Date.now(), level, text }, "*");
    } catch (e) {}
  }

  function send(level, text) {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      sent = 0;
    }
    if (sent >= RATE) {
      // Одна честная запись об урезанном хвосте на окно — не молчаливый дроп.
      if (sent === RATE) {
        sent++;
        post("warn", "bridge console hook: поток урезан (>" + RATE + " записей/с)");
      }
      return;
    }
    sent++;
    post(level, text);
  }

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level];
    if (typeof orig !== "function") continue;
    console[level] = function (...args) {
      send(level, fmt(args));
      return orig.apply(this, args);
    };
  }

  window.addEventListener("error", (e) => {
    const where = e.filename ? " (" + e.filename + ":" + (e.lineno || 0) + ")" : "";
    send("error", "onerror: " + (e.message || "script error") + where);
  });
  window.addEventListener("unhandledrejection", (e) => {
    send("error", "unhandledrejection: " + fmt([e.reason]));
  });
})();
