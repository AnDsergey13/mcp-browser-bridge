// eval-runner.test.mjs — MAIN-world исполнитель page.eval: протокол
// request/response по postMessage (маркеры __bridge_eval*), safeSerialize
// (circular/DOM/Error/Map/Set/BigInt/function), awaitPromise, защита от
// двойной инъекции.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const RUNNER = readFileSync(path.join(SRC, "eval-runner.js"), "utf8");

/** Песочница «страницы»: window с postMessage-сборщиком; выражения исполняются в vm-контексте. */
function boot() {
  const posted = [];
  const listeners = {};
  const sandbox = { JSON, String, Number, Object, Array, Map, Set, WeakSet, Error, TypeError, Promise, Date };
  sandbox.window = {
    postMessage: (data, origin) => posted.push([data, origin]),
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RUNNER, sandbox, { filename: "eval-runner.js" });
  return { sandbox, posted, listeners };
}

async function evalIn(boot_, expression, awaitPromise) {
  const before = boot_.posted.length;
  boot_.listeners.message[0]({
    source: boot_.sandbox.window,
    data: { __bridge_eval: true, requestId: "r1", expression, awaitPromise },
  });
  // ответ асинхронный (run — async): ждём микротаски
  for (let i = 0; i < 50 && boot_.posted.length === before; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(boot_.posted.length, before + 1, "ответ на eval не пришёл");
  const [data, origin] = boot_.posted[boot_.posted.length - 1];
  assert.equal(origin, "*");
  assert.equal(data.__bridge_eval_result, true);
  assert.equal(data.requestId, "r1");
  return data;
}

test("простое выражение: результат сериализуется в json, value_type заполнен", async () => {
  const b = boot();
  const res = await evalIn(b, "({a: 1, b: [1, 2], s: 'текст'})");
  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(res.json), { a: 1, b: [1, 2], s: "текст" });
  assert.equal(res.value_type, "object");
});

test("awaitPromise:true (дефолт) await'ит Promise результата", async () => {
  const b = boot();
  const res = await evalIn(b, "Promise.resolve(42)");
  assert.equal(res.ok, true);
  assert.equal(res.json, "42");
  assert.equal(res.value_type, "number");
});

test("awaitPromise:false — Promise отдаётся как есть ({}), без await", async () => {
  const b = boot();
  const res = await evalIn(b, "Promise.resolve(42)", false);
  assert.equal(res.ok, true);
  assert.equal(res.json, "{}");
});

test("исключение в выражении → ok:false EVAL_ERROR с сообщением", async () => {
  const b = boot();
  const res = await evalIn(b, "(() => { throw new Error('boom'); })()");
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "EVAL_ERROR");
  assert.match(res.error.message, /boom/);
});

test("safeSerialize: circular → [Circular], не падает", async () => {
  const b = boot();
  const res = await evalIn(b, "(() => { const x = {n: 1}; x.self = x; return x; })()");
  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(res.json), { n: 1, self: "[Circular]" });
});

test("safeSerialize: Map/Set → массивы, function и BigInt — строки", async () => {
  const b = boot();
  const res = await evalIn(
    b,
    "({m: new Map([['a', 1]]), s: new Set([1, 2]), f: function named() {}, b: 10n})"
  );
  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(res.json), {
    m: [["a", 1]],
    s: [1, 2],
    f: "[Function named]",
    b: "10n",
  });
});

test("safeSerialize: Error → {name,message,stack}", async () => {
  const b = boot();
  const res = await evalIn(b, "new TypeError('bad')");
  assert.equal(res.ok, true);
  const v = JSON.parse(res.json);
  assert.equal(v.name, "TypeError");
  assert.equal(v.message, "bad");
  assert.match(v.stack, /TypeError/);
});

test("пустое expression → ok:false без исполнения", async () => {
  const b = boot();
  const res = await evalIn(b, "   ");
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "EVAL_ERROR");
});

test("защита от двойной инъекции: повторная загрузка не добавляет второй listener", async () => {
  const b = boot();
  vm.runInContext(RUNNER, b.sandbox, { filename: "eval-runner.js" }); // повтор
  assert.equal(b.listeners.message.length, 1);
  const res = await evalIn(b, "1 + 1");
  assert.equal(res.ok, true);
  assert.equal(res.json, "2");
});

test("чужие сообщения (без маркера / чужой source) игнорируются", async () => {
  const b = boot();
  b.listeners.message[0]({ source: b.sandbox.window, data: { foo: 1 } });
  b.listeners.message[0]({ source: {}, data: { __bridge_eval: true, requestId: "r9", expression: "1" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(b.posted.length, 0);
});
