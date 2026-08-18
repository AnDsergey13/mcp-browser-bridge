// helpers.mjs — загрузка browser-скриптов (не ESM) в vm-песочницу + моки
// chrome/browser API для тестов без браузера.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * Выполнить скрипт расширения в изолированном контексте.
 * exportName — имя top-level const, которое надо вернуть (null — ничего).
 * Возвращает { exported, sandbox }.
 */
export function loadScript(file, exportName, sandboxExtra = {}) {
  const code = readFileSync(path.join(SRC, file), "utf8");
  const sandbox = { console, ...sandboxExtra };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    code + (exportName ? `\n;globalThis.__exported = ${exportName};` : ""),
    sandbox,
    { filename: file }
  );
  return { exported: sandbox.__exported, sandbox };
}

/** Снять кросс-realm прототипы (vm-песочница) перед deepStrictEqual. */
export function j(x) {
  return JSON.parse(JSON.stringify(x));
}

/** Событие в стиле WebExtension (add/remove/has + fire для теста). */
export function makeEvent() {
  const fns = [];
  return {
    addListener(fn) {
      fns.push(fn);
    },
    removeListener(fn) {
      const i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    },
    hasListener(fn) {
      return fns.includes(fn);
    },
    fire(...args) {
      return fns.map((fn) => fn(...args));
    },
    get count() {
      return fns.length;
    },
  };
}

/** In-memory storage.local с onChanged. */
export function makeStorage(initial = {}) {
  const store = { ...initial };
  const onChanged = makeEvent();
  return {
    store,
    onChanged,
    local: {
      async get(defaults) {
        if (typeof defaults === "string") return { [defaults]: store[defaults] };
        const out = {};
        for (const [k, v] of Object.entries(defaults || {})) {
          out[k] = k in store ? store[k] : v;
        }
        return out;
      },
      async set(patch) {
        const changes = {};
        for (const [k, v] of Object.entries(patch)) {
          changes[k] = { oldValue: store[k], newValue: v };
          store[k] = v;
        }
        onChanged.fire(changes, "local");
      },
      async remove(keys) {
        for (const k of [].concat(keys)) delete store[k];
      },
    },
  };
}

/**
 * Полный мок `chrome.*` (callback-style), покрывающий API, оборачиваемые
 * compat-browser.js. cb вызывается синхронно; lastError управляется тестом
 * через chrome.runtime.lastError.
 */
export function makeChrome() {
  const chrome = {
    calls: [], // журнал вызовов "api.method"
    runtime: {
      lastError: null,
      getManifest: () => ({ version: "0.0.0-test" }),
      sendMessage(msg, cb) {
        chrome.calls.push(["runtime.sendMessage", msg]);
        cb({ ok: true });
      },
      onMessage: makeEvent(),
    },
    storage: {
      local: {
        get(defaults, cb) {
          chrome.calls.push(["storage.local.get", defaults]);
          cb(typeof defaults === "object" && defaults ? { ...defaults } : {});
        },
        set(patch, cb) {
          chrome.calls.push(["storage.local.set", patch]);
          cb();
        },
        remove(keys, cb) {
          chrome.calls.push(["storage.local.remove", keys]);
          cb();
        },
      },
      onChanged: makeEvent(),
    },
    tabs: {
      get: (id, cb) => cb({ id, url: "https://a.com/" }),
      query: (q, cb) => cb([]),
      create: (p, cb) => cb({ id: 1, url: p.url || "" }),
      update: (id, p, cb) => cb({ id }),
      remove: (id, cb) => cb(),
      goBack: (id, cb) => cb(),
      reload: (id, cb) => cb(),
      sendMessage: (id, msg, cb) => cb({ ok: true, result: {} }),
      captureVisibleTab: (winId, opt, cb) => cb("data:image/jpeg;base64,AA=="),
      // tabs.executeScript намеренно отсутствует (MV3) — проверяем маппинг на scripting
      onUpdated: makeEvent(),
      onRemoved: makeEvent(),
    },
    scripting: {
      executeScript(inj, cb) {
        chrome.calls.push(["scripting.executeScript", inj]);
        cb([{ result: 42 }]);
      },
      registerContentScripts(specs) {
        chrome.calls.push(["scripting.registerContentScripts", specs]);
        return Promise.resolve();
      },
      unregisterContentScripts(filter) {
        chrome.calls.push(["scripting.unregisterContentScripts", filter]);
        return Promise.resolve();
      },
      getRegisteredContentScripts() {
        chrome.calls.push(["scripting.getRegisteredContentScripts"]);
        return Promise.resolve([]);
      },
    },
    permissions: {
      contains: (p, cb) => cb(true),
      request: (p, cb) => cb(true),
    },
    notifications: {
      create: (id, opt, cb) => cb(id),
      clear: (id, cb) => cb(true),
      onButtonClicked: makeEvent(),
    },
    webRequest: {
      onBeforeRequest: makeEvent(),
    },
    alarms: {
      create: (name, info, cb) => {
        chrome.calls.push(["alarms.create", name, info]);
        if (cb) cb();
      },
      onAlarm: makeEvent(),
    },
  };
  return chrome;
}

/** Минимальный мок `browser.*` (promise-style) для модулей owners/injector/config. */
export function makeBrowser(overrides = {}) {
  const storage = makeStorage(overrides.storageData);
  const browser = {
    storage,
    tabs: {
      onUpdated: makeEvent(),
      onRemoved: makeEvent(),
      get: async (id) => ({ id, url: "https://a.com/" }),
      executeScript: async () => undefined,
      ...(overrides.tabs || {}),
    },
    alarms: { onAlarm: makeEvent(), create: async () => {} },
    permissions: {
      contains: async () => (overrides.hostPermission === false ? false : true),
      request: async () => true,
    },
    ...(overrides.extra || {}),
  };
  return browser;
}
