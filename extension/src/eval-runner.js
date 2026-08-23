"use strict";

/**
 * eval-runner.js — MAIN-world исполнитель для page.eval (L1.1).
 *
 * Почему отдельный MAIN-world скрипт: content script работает в изолированном
 * мире и НЕ видит window-состояние страницы (SPA-сторы, GraphQL-клиенты,
 * переменные). Выбран тот же путь, что у console-hook.js: <script src> из
 * web_accessible_resources (внедряет content-bridge.js — только на доменах
 * политики), обмен через window.postMessage с requestId. Единый для Firefox
 * MV2 и Chromium MV3 (wrappedJSObject/cloneInto не нужны). Жёсткий CSP
 * страницы может запретить загрузку — тогда content script отвечает
 * EVAL_UNAVAILABLE (по образцу console_unavailable).
 *
 * Протокол (request/response, один запрос — один ответ):
 *   → {__bridge_eval:true, requestId, expression, awaitPromise?}
 *   ← {__bridge_eval_result:true, requestId, ok:true, json, value_type}
 *     | {__bridge_eval_result:true, requestId, ok:false,
 *        error:{code:"EVAL_ERROR", message}}
 *
 * Безопасность НЕ здесь: любой JS по определению обходит action-модель
 * gated, поэтому весь гейтинг — на сервере (capability eval + gated
 * eval:confirm + аудит expression + pacing). Runner лишь честно исполняет
 * то, что уже пропустила политика. Страница может подделать маркер ответа —
 * это untrusted-канал by design (N15): результат всегда маркируется
 * untrusted_page_content, а исполнение без серверного consent не начинается.
 */
var BridgeEvalRunner = (() => {
  const VALUE_TYPE_MAX = 80;

  function valueType(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
  }

  /**
   * Безопасная JSON-сериализация результата eval: страница может вернуть
   * циклы, DOM-узлы, функции, BigInt, Proxy — всё это ломает JSON.stringify
   * или раздувает ответ. Возвращает СТРОКУ json (обрезка по размеру и выбор
   * inline/relay — на стороне content script).
   */
  function safeSerialize(value) {
    const seen = new WeakSet();
    const replacer = (key, v) => {
      if (typeof v === "bigint") return String(v) + "n";
      if (typeof v === "function") return "[Function" + (v.name ? " " + v.name : "") + "]";
      if (typeof v === "undefined") return null;
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: String(v.stack || "").slice(0, 500) };
      }
      if (v instanceof Map) return Array.from(v.entries());
      if (v instanceof Set) return Array.from(v.values());
      if (v && typeof v === "object") {
        // DOM-узел — компактное описание, а не обход живого дерева.
        if (typeof v.nodeType === "number" && typeof v.nodeName === "string") {
          const id = v.id ? "#" + v.id : "";
          const cls =
            typeof v.className === "string" && v.className
              ? "." + v.className.trim().split(/\s+/).slice(0, 3).join(".")
              : "";
          return "[" + v.nodeName + id + cls + "]";
        }
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    };
    try {
      const json = JSON.stringify(value, replacer);
      return json !== undefined ? json : "null";
    } catch (e) {
      // Proxy с вредным then/toJSON и пр. — честный текстовый фолбэк.
      try {
        return JSON.stringify("[unserializable: " + String(value).slice(0, 200) + "]");
      } catch (e2) {
        return JSON.stringify("[unserializable]");
      }
    }
  }

  /**
   * Исполнение выражения в глобальном scope (косвенный eval — как консоль
   * DevTools). awaitPromise !== false → Promise результата await'ится (L.0:
   * fetch(...).then(r=>r.json()) к внутренним API страницы — основной кейс).
   * Возвращает Promise<{value}> — НЕ async-функция: async-функция усваивает
   * возвращаемый thenable, и ветка awaitPromise:false была бы неотличима.
   */
  function run(expression, awaitPromise) {
    const indirectEval = eval; // eslint-disable-line no-eval
    const result = indirectEval(expression); // sync-исключение летит вызывающему
    if (awaitPromise !== false && result && typeof result.then === "function") {
      return Promise.resolve(result).then((v) => ({ value: v }));
    }
    return Promise.resolve({ value: result });
  }

  /** Подписка на запросы. windowImpl — точка внедрения для тестов. */
  function attach(windowImpl) {
    const w = windowImpl || window;
    if (w.__BRIDGE_EVAL_RUNNER__) return; // защита от двойной инъекции
    w.__BRIDGE_EVAL_RUNNER__ = true;
    w.addEventListener("message", (event) => {
      if (event.source !== w) return;
      const d = event.data;
      if (!d || d.__bridge_eval !== true) return;
      const requestId = String(d.requestId || "");
      const reply = (msg) => {
        try {
          w.postMessage(
            Object.assign({ __bridge_eval_result: true, requestId }, msg),
            "*"
          );
        } catch (e) {}
      };
      const expression = String(d.expression || "");
      if (!expression.trim()) {
        reply({ ok: false, error: { code: "EVAL_ERROR", message: "пустое expression" } });
        return;
      }
      Promise.resolve()
        .then(() => run(expression, d.awaitPromise))
        .then(({ value }) => {
          reply({ ok: true, json: safeSerialize(value), value_type: valueType(value).slice(0, VALUE_TYPE_MAX) });
        })
        .catch((err) => {
          reply({
            ok: false,
            error: {
              code: "EVAL_ERROR",
              message: String((err && (err.stack || err.message)) || err).slice(0, 1000),
            },
          });
        });
    });
  }

  return { attach, run, safeSerialize, valueType };
})();

// В браузере — самоподписка; в тестах модуль импортируют и зовут attach(windowImpl).
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  BridgeEvalRunner.attach(window);
}
