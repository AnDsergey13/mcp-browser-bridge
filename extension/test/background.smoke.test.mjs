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
  for (const f of ["config.js", "owners.js", "keepalive.js", "injector.js", "background.js"]) {
    vm.runInContext(readFileSync(path.join(SRC, f), "utf8"), sandbox, { filename: f });
  }
  return { browser, getAlarm: () => alarmArmed };
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
