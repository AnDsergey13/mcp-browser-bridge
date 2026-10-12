// background.smoke.test.mjs — загрузка background.js в связке со всеми
// модулями (порядок как в манифесте/importScripts) в одной песочнице:
// top-level не должен падать, start() мигрирует конфиг, создаёт подключение,
// keepalive вооружается, слушатели регистрируются синхронно (MV3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { makeBrowser, makeEvent, j } from "./helpers.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

function boot(storageData) {
  const browser = makeBrowser({
    storageData,
    extra: {
      webRequest: { onBeforeRequest: makeEvent() },
      notifications: {
        create: async () => "id",
        clear: async () => true,
        onButtonClicked: makeEvent(),
      },
      runtime: {
        getManifest: () => ({ version: "0.0.0-test" }),
        onMessage: makeEvent(),
        sendMessage: async () => ({}),
      },
    },
  });
  let alarmArmed = null;
  browser.alarms.create = async (name, info) => {
    alarmArmed = { name, info };
  };
  // WS-заглушка: сокет «мёртв» (CLOSED), события не приходят.
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 3;
    }
    send() {}
    close() {}
  }
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CONNECTING = 0;

  const sandbox = {
    console,
    browser,
    WebSocket: FakeWebSocket,
    navigator: { userAgent: "Firefox/test" },
    fetch: async () => {
      throw new Error("нет сети в тесте");
    },
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["config.js", "owners.js", "keepalive.js", "injector.js", "sha256.js", "file-relay.js", "background.js"]) {
    vm.runInContext(readFileSync(path.join(SRC, f), "utf8"), sandbox, { filename: f });
  }
  return { browser, getAlarm: () => alarmArmed, sandbox };
}

test("smoke: загрузка всех модулей, миграция legacy, старт подключения, keepalive", async () => {
  const { browser, getAlarm } = boot({ serverUrl: "ws://legacy:9999", secret: "old" });
  await new Promise((r) => setTimeout(r, 20)); // дать start() добежать

  // миграция legacy {serverUrl,secret} → servers
  assert.deepEqual(j(browser.storage.store.servers), [
    { label: "default", url: "ws://legacy:9999", secret: "old" },
  ]);
  assert.equal("serverUrl" in browser.storage.store, false);
  // keepalive вооружён
  assert.equal(getAlarm().name, "bridge-keepalive");
  assert.equal(getAlarm().info.periodInMinutes, 0.5);
  // connState появился для default-подключения
  assert.ok(browser.storage.store.connState.default, "connState.default создан");
  // слушатели top-level на месте (MV3-требование)
  assert.equal(browser.runtime.onMessage.count, 1);
  assert.equal(browser.webRequest.onBeforeRequest.count, 1);
  assert.equal(browser.alarms.onAlarm.count, 1);
});

test("smoke: чистый старт без конфига — дефолтное подключение, падений нет", async () => {
  const { browser } = boot({});
  await new Promise((r) => setTimeout(r, 20));
  // дефолт не персистится (как раньше serverUrl не писался до сохранения в popup),
  // но подключение создано и его состояние лежит в connState
  assert.ok(browser.storage.store.connState.default, "connState.default создан");
});

test("П.7: reinjectOpenTabs повторяется при росте union-паттернов, не дёргается без изменений", async () => {
  const { browser, sandbox } = boot({});
  await new Promise((r) => setTimeout(r, 20));
  const run = (src) => vm.runInContext(src, sandbox);

  const calls = [];
  browser.tabs.executeScript = async (tabId, inj) => {
    calls.push([tabId, inj.file]);
  };
  browser.tabs.query = async () => [
    { id: 1, url: "https://a.com/x" },
    { id: 2, url: "https://b.com/y" },
    { id: 3, url: "chrome://extensions/" },
  ];

  // первый policy.update с паттерном a.com — инжектим только вкладку 1 (4 файла)
  run(`connections.push({ label: "t1", policyPatterns: ["*://*.a.com/*"] })`);
  await run(`reinjectOpenTabs()`);
  assert.deepEqual([...new Set(calls.map((c) => c[0]))], [1]);
  assert.equal(calls.length, 4);
  assert.equal(j(browser.storage.store.lastReinject).tabs, 1);

  // повтор без изменений паттернов — ни одного вызова
  calls.length = 0;
  await run(`reinjectOpenTabs()`);
  assert.equal(calls.length, 0, "без смены паттернов переинжекции нет");

  // рост union (новый грант b.com) — повторная переинжекция, обе вкладки;
  // chrome://extensions/ по-прежнему пропускается
  run(`connections.push({ label: "t2", policyPatterns: ["*://*.b.com/*"] })`);
  await run(`reinjectOpenTabs()`);
  assert.deepEqual([...new Set(calls.map((c) => c[0]))].sort(), [1, 2]);
  assert.equal(j(browser.storage.store.lastReinject).tabs, 2);
});
