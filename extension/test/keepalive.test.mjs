// keepalive.test.mjs — будильник alarms: мёртвый ws → connect(), живой — нет.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScript, makeBrowser } from "./helpers.mjs";

function setup() {
  const browser = makeBrowser();
  const { exported: keepalive } = loadScript("keepalive.js", "BridgeKeepalive", { browser });
  return { keepalive, browser };
}

test("wsAlive: OPEN/CONNECTING живы, CLOSED/CLOSING/null мертвы", () => {
  const { keepalive } = setup();
  assert.equal(keepalive.wsAlive({ readyState: 0 }), true); // CONNECTING
  assert.equal(keepalive.wsAlive({ readyState: 1 }), true); // OPEN
  assert.equal(keepalive.wsAlive({ readyState: 2 }), false); // CLOSING
  assert.equal(keepalive.wsAlive({ readyState: 3 }), false); // CLOSED
  assert.equal(keepalive.wsAlive(null), false);
});

test("alarm handler: мёртвый ws → connect(), живой — не трогаем", () => {
  const { keepalive, browser } = setup();
  const calls = [];
  const conns = [
    { ws: { readyState: 3 }, connect: () => calls.push("dead") }, // CLOSED
    { ws: { readyState: 1 }, connect: () => calls.push("alive") }, // OPEN
    { ws: null, connect: () => calls.push("null") }, // нет сокета
  ];
  keepalive.install(() => conns);
  browser.alarms.onAlarm.fire({ name: "bridge-keepalive" });
  assert.deepEqual(calls, ["dead", "null"]);
});

test("чужой будильник игнорируется", () => {
  const { keepalive, browser } = setup();
  const calls = [];
  keepalive.install(() => [{ ws: null, connect: () => calls.push("x") }]);
  browser.alarms.onAlarm.fire({ name: "other-alarm" });
  assert.deepEqual(calls, []);
});

test("arm(): создаёт периодический будильник 0.5 мин", async () => {
  const { keepalive, browser } = setup();
  let created = null;
  browser.alarms.create = async (name, info) => {
    created = { name, info };
  };
  await keepalive.arm();
  assert.equal(created.name, "bridge-keepalive");
  assert.equal(created.info.periodInMinutes, 0.5);
});
