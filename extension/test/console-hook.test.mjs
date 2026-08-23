// console-hook.test.mjs — MAIN-world хук консоли (page.console): перехват
// console.*/onerror/unhandledrejection, отправка записей через postMessage
// с маркером __bridge_console, защита от двойной инъекции, rate-limit спама.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const HOOK = readFileSync(path.join(SRC, "console-hook.js"), "utf8");

/** Песочница «страницы»: window с postMessage-сборщиком и живой console. */
function boot() {
  const posted = [];
  const listeners = {};
  const origCalls = [];
  const sandbox = {
    Date,
    JSON,
    Error,
    String,
    console: {
      log: (...a) => origCalls.push(["log", ...a]),
      info: (...a) => origCalls.push(["info", ...a]),
      warn: (...a) => origCalls.push(["warn", ...a]),
      error: (...a) => origCalls.push(["error", ...a]),
      debug: (...a) => origCalls.push(["debug", ...a]),
    },
  };
  sandbox.window = {
    postMessage: (data, origin) => posted.push([data, origin]),
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(HOOK, sandbox, { filename: "console-hook.js" });
  return { sandbox, posted, listeners, origCalls };
}

test("console.* перехватывается: запись с маркером уходит в postMessage, оригинал вызван", () => {
  const { sandbox, posted, origCalls } = boot();
  sandbox.console.error("boom", { code: 42 });
  assert.equal(posted.length, 1);
  const [data, origin] = posted[0];
  assert.equal(origin, "*");
  assert.equal(data.__bridge_console, true);
  assert.equal(data.level, "error");
  assert.match(data.text, /boom \{"code":42\}/);
  assert.ok(typeof data.ts === "number");
  assert.deepEqual(origCalls, [["error", "boom", { code: 42 }]], "оригинальный console.error вызван");
});

test("onerror и unhandledrejection превращаются в записи уровня error", () => {
  const { posted, listeners } = boot();
  listeners.error[0]({ message: "Uncaught TypeError: x is null", filename: "app.js", lineno: 10 });
  listeners.unhandledrejection[0]({ reason: new Error("nope") });
  assert.equal(posted.length, 2);
  assert.match(posted[0][0].text, /onerror: Uncaught TypeError: x is null \(app\.js:10\)/);
  assert.match(posted[1][0].text, /unhandledrejection: Error: nope/);
  assert.ok(posted.every(([d]) => d.level === "error"));
});

test("защита от двойной инъекции: повторная загрузка не добавляет вторую обёртку", () => {
  const { sandbox, posted } = boot();
  vm.runInContext(HOOK, sandbox, { filename: "console-hook.js" }); // повтор
  sandbox.console.warn("once");
  assert.equal(posted.length, 1, "запись одна, а не две");
});

test("rate-limit: сверх 50 записей/с идёт одна честная запись об урезании", () => {
  const { sandbox, posted } = boot();
  for (let i = 0; i < 70; i++) sandbox.console.log("spam " + i);
  assert.equal(posted.length, 51, "50 записей + маркер урезания");
  assert.equal(posted[50][0].level, "warn");
  assert.match(posted[50][0].text, /поток урезан/);
});

test("длинный текст грубо обрезается (точный лимит 500 — на стороне content script)", () => {
  const { sandbox, posted } = boot();
  sandbox.console.log("x".repeat(2000));
  assert.equal(posted[0][0].text.length, 1000);
});
