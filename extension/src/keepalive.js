/* global browser */
"use strict";

/**
 * keepalive.js — страховка живучести MV3 service worker (D10).
 *
 * Открытый WS с трафиком (серверные ping каждые 15 с, PROTOCOL.md §3) сам
 * сбрасывает 30-с idle-таймер воркера (Chrome 116+). Будильник alarms —
 * страховка на случай, если воркер всё же убили, а сокет умер: по срабатыванию
 * (это и есть точка пробуждения SW) мёртвые подключения переподключаются.
 *
 * Слушатель регистрируется СИНХРОННО на top-level (требование MV3).
 * В Firefox (persistent background) будильник безвреден: ws там не засыпает,
 * проверка isAlive просто ничего не делает.
 */
const BridgeKeepalive = (() => {
  const ALARM_NAME = "bridge-keepalive";
  const PERIOD_MIN = 0.5; // минимум MV3; Firefox может молча клампить до 1 мин — ок

  /** Сокет жив: CONNECTING или OPEN (константы WebSocket 0/1, без глобала — тесты). */
  function wsAlive(ws) {
    return !!ws && (ws.readyState === 0 || ws.readyState === 1);
  }

  /**
   * Зарегистрировать обработчик будильника. getConnections() → массив
   * объектов {ws, connect()} (ServerConnection из background.js).
   */
  function install(getConnections) {
    browser.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || alarm.name !== ALARM_NAME) return;
      for (const conn of getConnections()) {
        try {
          if (!wsAlive(conn.ws)) conn.connect();
        } catch (e) {
          console.warn("[bridge] keepalive:", e);
        }
      }
    });
  }

  /** Создать (пересоздать) периодический будильник. */
  async function arm() {
    try {
      await browser.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MIN });
    } catch (e) {
      console.warn("[bridge] keepalive arm failed:", e);
    }
  }

  return { ALARM_NAME, wsAlive, install, arm };
})();
