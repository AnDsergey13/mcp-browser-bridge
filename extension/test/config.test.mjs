// config.test.mjs — миграция конфига single→list и нормализация серверов.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript, makeBrowser, j } from "./helpers.mjs";

function loadConfig(storageData) {
  const browser = makeBrowser({ storageData });
  const { exported } = loadScript("config.js", "BridgeConfig", { browser });
  return { cfg: exported, browser };
}

test("legacy {serverUrl, secret} → servers:[{label:'default',...}], migrated=true", () => {
  const { cfg } = loadConfig();
  const r = cfg.migrate({ servers: [], serverUrl: "ws://10.0.0.1:18777", secret: "s3cret" });
  assert.equal(r.migrated, true);
  assert.deepEqual(j(r.servers), [
    { label: "default", url: "ws://10.0.0.1:18777", secret: "s3cret" },
  ]);
});

test("уже список — без миграции, записи нормализуются", () => {
  const { cfg } = loadConfig();
  const r = cfg.migrate({
    servers: [
      { label: "main", url: "ws://a:1", secret: "x" },
      { url: " ws://b:2 " }, // без label → server-2, url тримится
      { label: "broken" }, // без url → отброшен
    ],
  });
  assert.equal(r.migrated, false);
  assert.deepEqual(j(r.servers), [
    { label: "main", url: "ws://a:1", secret: "x" },
    { label: "server-2", url: "ws://b:2", secret: "" },
  ]);
});

test("пустой конфиг → один сервер по умолчанию (поведение прежней версии)", () => {
  const { cfg } = loadConfig();
  const r = cfg.migrate({ servers: [], serverUrl: "", secret: "" });
  assert.equal(r.migrated, false);
  assert.deepEqual(j(r.servers), [
    { label: "default", url: "ws://127.0.0.1:18777", secret: "" },
  ]);
});

test("load(): миграция пишет servers и удаляет legacy-ключи", async () => {
  const { cfg, browser } = loadConfig({
    serverUrl: "ws://legacy:1",
    secret: "old",
    unrelated: 42,
  });
  const servers = await cfg.load();
  assert.deepEqual(j(servers), [{ label: "default", url: "ws://legacy:1", secret: "old" }]);
  assert.deepEqual(j(browser.storage.store.servers), j(servers));
  assert.equal("serverUrl" in browser.storage.store, false);
  assert.equal("secret" in browser.storage.store, false);
  assert.equal(browser.storage.store.unrelated, 42, "чужие ключи не тронуты");
});

test("load(): валидный список читается как есть, миграция не срабатывает", async () => {
  const { cfg, browser } = loadConfig({
    servers: [{ label: "a", url: "ws://a:1", secret: "" }],
    serverUrl: "ws://legacy:1", // мусор после прошлой миграции — игнорируется
  });
  const servers = await cfg.load();
  assert.deepEqual(j(servers), [{ label: "a", url: "ws://a:1", secret: "" }]);
  assert.equal(browser.storage.store.serverUrl, "ws://legacy:1", "legacy не удаляли зря");
});
