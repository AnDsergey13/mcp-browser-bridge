// injector.test.mjs — выбор ветки по доступным API, регистрация/перерегистрация.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript, makeBrowser, makeChrome, makeEvent, j } from "./helpers.mjs";

const PATTERNS = ["*://*.a.com/*", "*://b.com/*"];

function firefoxBrowser() {
  const registered = [];
  const unregistered = [];
  return {
    registered,
    unregistered,
    browser: makeBrowser({
      extra: {
        contentScripts: {
          async register(opts) {
            registered.push(opts);
            return {
              async unregister() {
                unregistered.push(opts);
              },
            };
          },
        },
      },
    }),
  };
}

test("Firefox-ветка: contentScripts.register с matches из политики", async () => {
  const { browser, registered } = firefoxBrowser();
  const { exported: inj } = loadScript("injector.js", "BridgeInjector", { browser });
  assert.equal(inj.detectMode(), "firefox");

  const r = await inj.applyPolicy({ match_patterns: PATTERNS });
  assert.equal(r.registered, true);
  assert.equal(r.count, 2);
  assert.equal(registered.length, 1);
  assert.deepEqual(j(registered[0].matches), j(PATTERNS));
  assert.equal(registered[0].runAt, "document_idle");
  // compat-browser.js — первым в списке content scripts
  assert.equal(registered[0].js[0].file, "src/compat-browser.js");
  assert.deepEqual(
    j(registered[0].js.map((f) => f.file)),
    ["src/compat-browser.js", "src/snapshot.js", "src/consent-banner.js", "src/content-bridge.js"]
  );
});

test("Firefox-ветка: смена политики — старые регистрации снимаются", async () => {
  const { browser, registered, unregistered } = firefoxBrowser();
  const { exported: inj } = loadScript("injector.js", "BridgeInjector", { browser });
  await inj.applyPolicy({ match_patterns: PATTERNS });
  await inj.applyPolicy({ match_patterns: ["*://c.com/*"] });
  assert.equal(unregistered.length, 1, "прежняя регистрация снята");
  assert.equal(registered.length, 2);
  assert.deepEqual(j(registered[1].matches), ["*://c.com/*"]);
});

test("Firefox-ветка: нет host-прав — needHostPermission, регистрации нет", async () => {
  const { browser, registered } = firefoxBrowser();
  browser.permissions.contains = async () => false;
  const { exported: inj } = loadScript("injector.js", "BridgeInjector", { browser });
  const r = await inj.applyPolicy({ match_patterns: PATTERNS });
  assert.equal(r.needHostPermission, true);
  assert.equal(registered.length, 0);
  assert.equal(browser.storage.store.needHostPermission, true);
});

test("MV3-ветка: chrome.scripting.registerContentScripts, persistAcrossSessions:false", async () => {
  const chrome = makeChrome();
  const browser = makeBrowser(); // без contentScripts → ветка mv3
  const { exported: inj } = loadScript("injector.js", "BridgeInjector", { browser, chrome });
  assert.equal(inj.detectMode(), "mv3");

  const r = await inj.applyPolicy({ match_patterns: PATTERNS });
  assert.equal(r.registered, true);
  const call = chrome.calls.find((c) => c[0] === "scripting.registerContentScripts");
  assert.ok(call, "registerContentScripts вызван");
  const spec = call[1][0];
  assert.deepEqual(j(spec.matches), j(PATTERNS));
  assert.equal(spec.persistAcrossSessions, false);
  assert.equal(spec.runAt, "document_idle");
  assert.deepEqual(j(spec.js), [
    "src/compat-browser.js",
    "src/snapshot.js",
    "src/consent-banner.js",
    "src/content-bridge.js",
  ]);
  assert.ok(spec.id.startsWith("bridge-"), "id с нашим префиксом");
});

test("MV3-ветка: смена политики — unregister старых id (включая sweep прошлой жизни SW)", async () => {
  const chrome = makeChrome();
  const browser = makeBrowser();
  const { exported: inj } = loadScript("injector.js", "BridgeInjector", { browser, chrome });
  await inj.applyPolicy({ match_patterns: PATTERNS });
  await inj.applyPolicy({ match_patterns: ["*://c.com/*"] });

  const unreg = chrome.calls.filter((c) => c[0] === "scripting.unregisterContentScripts");
  assert.ok(unreg.length >= 1, "старые регистрации сняты");
  // sweep через getRegisteredContentScripts при каждом applyPolicy
  const sweeps = chrome.calls.filter((c) => c[0] === "scripting.getRegisteredContentScripts");
  assert.ok(sweeps.length >= 2, "сверка с реально зарегистрированным после рестарта SW");
  const regs = chrome.calls.filter((c) => c[0] === "scripting.registerContentScripts");
  assert.equal(regs.length, 2);
  assert.deepEqual(j(regs[1][1][0].matches), ["*://c.com/*"]);
});

test("fallback: URL с явным портом матчит паттерн без порта (MDN: порт в match pattern недопустим)", async () => {
  const executed = [];
  const tabs = {
    onUpdated: makeEvent(),
    executeScript: async (tabId, opts) => {
      executed.push([tabId, opts.file]);
    },
  };
  const browser = makeBrowser({ tabs });
  const { exported: inj } = loadScript("injector.js", "BridgeInjector", { browser });
  assert.equal(inj.detectMode(), "fallback");

  const r = await inj.applyPolicy({ match_patterns: ["*://127.0.0.1/*"] });
  assert.equal(r.registered, true);

  tabs.onUpdated.fire(7, { status: "complete" }, { id: 7, url: "http://127.0.0.1:8077/" });
  await new Promise((resolve) => setTimeout(resolve, 0)); // hasHostPermission().then
  assert.ok(executed.length > 0, "content scripts инжектируются в URL с портом");
  assert.equal(executed[0][0], 7);
});
