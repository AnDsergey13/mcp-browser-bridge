/* global chrome */
"use strict";

/**
 * compat-browser.js — шим `browser.*` поверх `chrome.*` для Chromium (D10).
 *
 * Firefox: нативный глобал `browser` уже есть → шим no-op.
 * Chromium: создаём глобал `browser` с промис-обёртками ТОЛЬКО для методов,
 * реально используемых расширением (список собран grep'ом `browser\.` по
 * extension/src): storage.local.get/set/remove + onChanged, tabs.get/query/
 * create/update/remove/goBack/reload/sendMessage/executeScript/
 * captureVisibleTab + onUpdated/onRemoved, permissions.contains/request,
 * notifications.create/clear + onButtonClicked, runtime.getManifest/
 * sendMessage/onMessage, webRequest.onBeforeRequest, alarms.create + onAlarm.
 *
 * Правила:
 *  - callback-style chrome.* работает и в MV3 — оборачиваем через callback,
 *    chrome.runtime.lastError → reject(Error(message));
 *  - события — прямой пасsthrough, КРОМЕ runtime.onMessage: Firefox-стиль
 *    «слушатель возвращает Promise» в Chromium не поддержан — конвертируем
 *    в sendResponse + return true (канал держится до async-ответа);
 *  - tabs.executeScript в MV3 выпилен — маппим на chrome.scripting.executeScript.
 *
 * Подключается ПЕРВЫМ везде: в background scripts (MV2), в popup.html перед
 * popup.js, первым в списке content scripts (injector CONTENT_JS), в MV3 —
 * первым в importScripts sw-loader.js.
 */
(function () {
  // Firefox (и повторная загрузка): ничего не делаем.
  if (typeof globalThis.browser !== "undefined" && globalThis.browser) return;
  // Не контекст расширения Chromium — шимить нечего.
  if (typeof chrome === "undefined" || !chrome.runtime) return;

  /** cb-style chrome-метод → Promise; lastError → reject(Error с .message). */
  function promisify(fn, ctx) {
    return function (...args) {
      return new Promise((resolve, reject) => {
        let settled = false;
        try {
          fn.apply(ctx, [
            ...args,
            (result) => {
              settled = true;
              const err = chrome.runtime.lastError;
              if (err) reject(new Error(err.message || String(err)));
              else resolve(result);
            },
          ]);
        } catch (e) {
          if (!settled) reject(e);
        }
      });
    };
  }

  /** Событие-пасsthrough (addListener/removeListener/hasListener). */
  function wrapEvent(ev) {
    return {
      addListener: (fn) => ev.addListener(fn),
      removeListener: (fn) => ev.removeListener(fn),
      hasListener: (fn) => ev.hasListener(fn),
    };
  }

  /**
   * runtime.onMessage: Firefox-семантика «вернуть Promise из слушателя».
   * Возвращённый thenable → sendResponse по резолву + return true (async-канал);
   * синхронный undefined → return false (слушатель сообщение не обрабатывает).
   */
  function wrapOnMessage(ev) {
    const wrapped = new Map(); // оригинал → обёртка (для removeListener)
    return {
      addListener(fn) {
        const w = (msg, sender, sendResponse) => {
          let ret;
          try {
            ret = fn(msg, sender);
          } catch (e) {
            return false;
          }
          if (ret && typeof ret.then === "function") {
            ret.then(
              (v) => {
                try {
                  sendResponse(v);
                } catch (e) {}
              },
              () => {
                try {
                  sendResponse(undefined);
                } catch (e) {}
              }
            );
            return true; // ответ уйдёт асинхронно — канал не закрывать
          }
          return false;
        };
        wrapped.set(fn, w);
        ev.addListener(w);
      },
      removeListener(fn) {
        const w = wrapped.get(fn);
        if (w) {
          wrapped.delete(fn);
          ev.removeListener(w);
        }
      },
      hasListener: (fn) => wrapped.has(fn),
    };
  }

  /**
   * tabs.executeScript: MV2-API, в MV3 выпилен → адаптер на
   * chrome.scripting.executeScript ({file} → {files:[file]}; runAt:"document_idle"
   * — поведение scripting по умолчанию, injectImmediately не трогаем).
   */
  function executeScript(tabId, details) {
    if (chrome.tabs && chrome.tabs.executeScript) {
      return promisify(chrome.tabs.executeScript, chrome.tabs)(tabId, details);
    }
    if (chrome.scripting && chrome.scripting.executeScript) {
      const injection = { target: { tabId } };
      if (details && details.file) injection.files = [details.file];
      return promisify(
        chrome.scripting.executeScript,
        chrome.scripting
      )(injection).then((results) =>
        Array.isArray(results) && results.length ? results[0].result : undefined
      );
    }
    return Promise.reject(new Error("executeScript недоступен (нет tabs.executeScript/scripting)"));
  }

  // ВАЖНО: в контент-скриптах Chromium доступен не весь chrome.* (нет tabs,
  // permissions, notifications, alarms, webRequest — только runtime/storage).
  // Поэтому пространства собираем условно: отсутствующее API → undefined
  // (контент-скриптам нужен только runtime; фон/popup имеют полный набор).
  const shim = {
    runtime: {
      getManifest: () => chrome.runtime.getManifest(),
      sendMessage: promisify(chrome.runtime.sendMessage, chrome.runtime),
      onMessage: wrapOnMessage(chrome.runtime.onMessage),
    },
  };

  if (chrome.storage && chrome.storage.local) {
    shim.storage = {
      local: {
        get: promisify(chrome.storage.local.get, chrome.storage.local),
        set: promisify(chrome.storage.local.set, chrome.storage.local),
        remove: promisify(chrome.storage.local.remove, chrome.storage.local),
      },
      onChanged: wrapEvent(chrome.storage.onChanged),
    };
  }
  if (chrome.tabs) {
    shim.tabs = {
      get: promisify(chrome.tabs.get, chrome.tabs),
      query: promisify(chrome.tabs.query, chrome.tabs),
      create: promisify(chrome.tabs.create, chrome.tabs),
      update: promisify(chrome.tabs.update, chrome.tabs),
      remove: promisify(chrome.tabs.remove, chrome.tabs),
      goBack: promisify(chrome.tabs.goBack, chrome.tabs),
      reload: promisify(chrome.tabs.reload, chrome.tabs),
      sendMessage: promisify(chrome.tabs.sendMessage, chrome.tabs),
      captureVisibleTab: promisify(chrome.tabs.captureVisibleTab, chrome.tabs),
      executeScript,
      onUpdated: wrapEvent(chrome.tabs.onUpdated),
      onRemoved: wrapEvent(chrome.tabs.onRemoved),
    };
  }
  if (chrome.permissions) {
    shim.permissions = {
      contains: promisify(chrome.permissions.contains, chrome.permissions),
      request: promisify(chrome.permissions.request, chrome.permissions),
    };
  }
  if (chrome.notifications) {
    shim.notifications = {
      create: promisify(chrome.notifications.create, chrome.notifications),
      clear: promisify(chrome.notifications.clear, chrome.notifications),
      onButtonClicked: wrapEvent(chrome.notifications.onButtonClicked),
    };
  }
  if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
    shim.webRequest = { onBeforeRequest: wrapEvent(chrome.webRequest.onBeforeRequest) };
  } else {
    // В MV3 service worker webRequest может быть schema-registered, но без
    // bindings: addListener бросает "No matching signature" СИНХРОННО —
    // вызов в background.js под try/catch, сообщение стаба понятное.
    shim.webRequest = {
      onBeforeRequest: {
        addListener() {
          throw new Error("webRequest недоступен в этом контексте (MV3 SW)");
        },
        removeListener() {},
        hasListener: () => false,
      },
    };
  }
  if (chrome.alarms) {
    shim.alarms = {
      create: promisify(chrome.alarms.create, chrome.alarms),
      onAlarm: wrapEvent(chrome.alarms.onAlarm),
    };
  }

  globalThis.browser = shim;
})();
