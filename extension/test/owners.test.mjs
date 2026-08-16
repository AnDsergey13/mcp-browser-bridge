// owners.test.mjs — реестр владельцев вкладок: авто-назначение при одном
// подключении, TAB_NOT_OWNED, default-deny при мульти, popup-назначение,
// очистка по onRemoved (release), персистентность в storage.local.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript, makeBrowser, j } from "./helpers.mjs";

async function freshOwners(storageData) {
  const browser = makeBrowser({ storageData });
  const { exported: owners } = loadScript("owners.js", "BridgeOwners", { browser });
  await owners.load();
  return { owners, browser };
}

test("одиночный режим: команда к неназначенной вкладке авто-назначает её", async () => {
  const { owners } = await freshOwners();
  const assigned = await owners.assertAccess(10, "main", 1);
  assert.equal(assigned, true);
  assert.equal(owners.ownerOf(10), "main");
  // повторная команда владельца — без изменений
  assert.equal(await owners.assertAccess(10, "main", 1), false);
});

test("чужая вкладка → TAB_NOT_OWNED", async () => {
  const { owners } = await freshOwners();
  await owners.assign(10, "main");
  await assert.rejects(owners.assertAccess(10, "other", 2), /принадлежит/);
  await owners.assertAccess(10, "other", 2).catch((e) => {
    assert.equal(e.code, "TAB_NOT_OWNED");
  });
});

test("мульти-подключение: неназначенная вкладка недоступна (default-deny)", async () => {
  const { owners } = await freshOwners();
  await assert.rejects(owners.assertAccess(20, "main", 2), (e) => {
    assert.equal(e.code, "TAB_NOT_OWNED");
    assert.match(e.message, /не назначена/);
    return true;
  });
  assert.equal(owners.ownerOf(20), null, "авто-назначения при двух подключениях нет");
});

test("popup-назначение меняет владельца; unassign делает неназначенной", async () => {
  const { owners } = await freshOwners();
  await owners.assign(30, "main");
  await owners.assign(30, "other"); // popup передал вкладку
  assert.equal(owners.ownerOf(30), "other");
  await owners.assertAccess(30, "other", 2); // не бросает
  await owners.release(30);
  assert.equal(owners.ownerOf(30), null);
});

test("закрытие вкладки (release по onRemoved) чистит запись и storage", async () => {
  const { owners, browser } = await freshOwners();
  await owners.assign(40, "main");
  assert.equal(browser.storage.store.tabOwners["40"], "main");
  await owners.release(40);
  assert.deepEqual(j(browser.storage.store.tabOwners), {});
});

test("releaseAll освобождает все вкладки удалённого подключения", async () => {
  const { owners } = await freshOwners();
  await owners.assign(1, "a");
  await owners.assign(2, "a");
  await owners.assign(3, "b");
  await owners.releaseAll("a");
  assert.equal(owners.ownerOf(1), null);
  assert.equal(owners.ownerOf(2), null);
  assert.equal(owners.ownerOf(3), "b");
});

test("tab.list: при одном подключении видны все вкладки, при двух — только свои", async () => {
  const { owners } = await freshOwners();
  await owners.assign(1, "a");
  await owners.assign(2, "b");
  const tabs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.equal(owners.filterVisible(tabs, "a", 1).length, 3);
  assert.deepEqual(
    j(owners.filterVisible(tabs, "a", 2).map((t) => t.id)),
    [1]
  );
});

test("реестр переживает перезагрузку (storage.local → load)", async () => {
  const { browser } = await freshOwners();
  browser.storage.store.tabOwners = { 5: "main" };
  const { exported: owners2 } = loadScript("owners.js", "BridgeOwners", { browser });
  await owners2.load();
  assert.equal(owners2.ownerOf(5), "main");
});
