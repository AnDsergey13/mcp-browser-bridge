// compat-browser.test.mjs — шим browser→chrome: no-op в Firefox,
// промисы/lastError/onMessage-семантика/executeScript-маппинг в Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript, makeChrome, j } from "./helpers.mjs";

test("Firefox/LibreWolf: нативный browser с getBrowserInfo → шим no-op", () => {
  const chrome = makeChrome(); // даже если chrome.* рядом доступен
  const native = { runtime: { getBrowserInfo: async () => ({ name: "LibreWolf" }) } };
  const { sandbox } = loadScript("compat-browser.js", null, { chrome, browser: native });
  assert.equal(sandbox.browser, native); // объект не подменён
  assert.equal(sandbox.browser.tabs, undefined); // ничего не добавлено
});

test("Chromium ≥128: нативный browser-алиас (только MV3-API) → дочиняем tabs.executeScript", async () => {
  // Регрессия 2026-10-11: в свежем Chromium globalThis.browser уже существует
  // (алиас chrome.* с промисами), но MV2-зонда tabs.executeScript в нём нет;
  // ранний выход шима давал "browser.tabs.executeScript is not a function" на
  // каждой переинжекции вкладок.
  const chrome = makeChrome();
  const alias = {
    tabs: { get: async (id) => ({ id, url: "https://a.com/" }) },
    runtime: {}, // без getBrowserInfo — не Firefox
  };
  const { sandbox } = loadScript("compat-browser.js", null, { chrome, browser: alias });
  assert.equal(sandbox.browser, alias, "нативный объект не подменён");
  assert.equal(typeof alias.tabs.executeScript, "function", "пробел дочинен адаптером");
  await alias.tabs.executeScript(3, { file: "src/content-bridge.js" });
  const call = chrome.calls.find((c) => c[0] === "scripting.executeScript");
  assert.ok(call, "вызов ушёл в chrome.scripting.executeScript");
  assert.deepEqual(j(call[1].target), { tabId: 3 });
});

test("Chromium-алиас в урезанном контексте (без browser.tabs): не падаем, не трогаем", () => {
  const chrome = makeChrome();
  const alias = { runtime: { sendMessage: async () => ({}) } };
  const { sandbox } = loadScript("compat-browser.js", null, { chrome, browser: alias });
  assert.equal(sandbox.browser, alias);
  assert.equal(sandbox.browser.tabs, undefined);
});

test("Chromium ≥128: browser === chrome (один объект) — адаптер не рекурсирует в себя", async () => {
  // Регрессия 2026-10-11: присвоение browser.tabs.executeScript ставило адаптер
  // и на chrome.tabs.executeScript; адаптер видел «legacy API есть» и вызывал
  // сам себя до RangeError: Maximum call stack size exceeded.
  const chrome = makeChrome();
  const { sandbox } = loadScript("compat-browser.js", null, { chrome, browser: chrome });
  assert.equal(typeof chrome.tabs.executeScript, "function", "заплатка встала на общий объект");
  const res = await sandbox.browser.tabs.executeScript(3, { file: "src/content-bridge.js" });
  assert.equal(res, 42, "без рекурсии: ушло в chrome.scripting");
  const call = chrome.calls.find((c) => c[0] === "scripting.executeScript");
  assert.ok(call, "маппинг на chrome.scripting.executeScript");
  assert.deepEqual(j(call[1].files), ["src/content-bridge.js"]);
});

test("Chromium: создаётся browser поверх chrome, методы резолвятся промисами", async () => {
  const chrome = makeChrome();
  const { sandbox } = loadScript("compat-browser.js", null, { chrome });
  const b = sandbox.browser;
  assert.ok(b, "глобал browser создан");
  const tab = await b.tabs.get(7);
  assert.equal(tab.id, 7);
  assert.deepEqual(await b.storage.local.get({ a: 1 }), { a: 1 });
  assert.equal(b.runtime.getManifest().version, "0.0.0-test"); // sync-пасsthrough
});

test("Chromium: chrome.runtime.lastError → reject(Error с .message)", async () => {
  const chrome = makeChrome();
  chrome.storage.local.get = (defaults, cb) => {
    chrome.runtime.lastError = { message: "storage сломан" };
    cb(undefined);
  };
  const { sandbox } = loadScript("compat-browser.js", null, { chrome });
  await assert.rejects(sandbox.browser.storage.local.get({ a: 1 }), /storage сломан/);
});

test("Chromium: runtime.onMessage — Promise из слушателя → sendResponse + return true", async () => {
  const chrome = makeChrome();
  const { sandbox } = loadScript("compat-browser.js", null, { chrome });
  sandbox.browser.runtime.onMessage.addListener(async (msg) => ({ echo: msg.n }));

  // слушатель-обёртка на стороне chrome
  assert.equal(chrome.runtime.onMessage.count, 1);
  const sent = [];
  const ret = chrome.runtime.onMessage.fire({ n: 5 }, {}, (v) => sent.push(v))[0];
  assert.equal(ret, true, "async-ответ: канал держится открытым (return true)");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent, [{ echo: 5 }]);
});

test("Chromium: runtime.onMessage — синхронный undefined → return false (не обрабатываем)", () => {
  const chrome = makeChrome();
  const { sandbox } = loadScript("compat-browser.js", null, { chrome });
  sandbox.browser.runtime.onMessage.addListener(() => undefined);
  const ret = chrome.runtime.onMessage.fire({}, {}, () => {})[0];
  assert.equal(ret, false);
});

test("Chromium MV3: tabs.executeScript маппится на chrome.scripting.executeScript", async () => {
  const chrome = makeChrome();
  const { sandbox } = loadScript("compat-browser.js", null, { chrome });
  assert.equal(chrome.tabs.executeScript, undefined, "в MV3 tabs.executeScript нет");
  const res = await sandbox.browser.tabs.executeScript(3, {
    file: "src/content-bridge.js",
    runAt: "document_idle",
  });
  assert.equal(res, 42);
  const call = chrome.calls.find((c) => c[0] === "scripting.executeScript");
  assert.ok(call, "вызван chrome.scripting.executeScript");
  assert.deepEqual(j(call[1].target), { tabId: 3 });
  assert.deepEqual(j(call[1].files), ["src/content-bridge.js"]);
});

test("Chromium content script: chrome без tabs/permissions/alarms — шим строится, runtime работает", async () => {
  // Регрессия 2026-08-16: в контент-скриптах Chromium нет chrome.tabs и др.;
  // безусловная сборка шима падала на chrome.tabs.get и НЕ создавала глобал
  // browser → content-bridge умирал с "browser is not defined".
  const chrome = makeChrome();
  delete chrome.tabs;
  delete chrome.permissions;
  delete chrome.notifications;
  delete chrome.alarms;
  delete chrome.webRequest;
  const { sandbox } = loadScript("compat-browser.js", null, { chrome });
  const b = sandbox.browser;
  assert.ok(b, "глобал browser создан даже в урезанном контексте");
  assert.equal(b.tabs, undefined);
  assert.equal(b.alarms, undefined);
  assert.ok(b.runtime, "runtime — единственное нужное контент-скриптам API");
  assert.equal(b.runtime.getManifest().version, "0.0.0-test");
  // storage в контент-скриптах есть
  assert.deepEqual(await b.storage.local.get({ a: 1 }), { a: 1 });
  // webRequest-стаб: понятная ошибка при вызове, а не падение при сборке
  assert.throws(() => b.webRequest.onBeforeRequest.addListener(() => {}), /webRequest недоступен/);
});
