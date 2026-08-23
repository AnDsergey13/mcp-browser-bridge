/* global browser */
"use strict";

/**
 * content-bridge.js — исполнитель команд страницы.
 * Получает от background сообщения {kind:"cmd", method, params},
 * отвечает {ok:true, result} | {ok:false, error:{code,message}}.
 * События (pause.auto) шлёт в background через runtime.sendMessage.
 * Файлового релея здесь больше нет: fetchFile исполняется в background
 * (file-relay.js) — CORS-редиректы на CDN и потребление памяти вкладкой.
 * Общие модули: window.__BRIDGE__.snapshot / .refs (snapshot.js),
 * window.__BRIDGE__.showConsent (consent-banner.js).
 */
(() => {
  if (window.__BRIDGE_CONTENT_LOADED__) return; // защита от двойной загрузки
  window.__BRIDGE_CONTENT_LOADED__ = true;
  const B = (window.__BRIDGE__ = window.__BRIDGE__ || {});

  const QUIET_MS = 500; // «тихое окно»: столько без DOM-мутаций (N9)
  const QUIET_TIMEOUT_MS = 10000; // общий таймаут тихого окна
  const CONSENT_HOST_ID = "__bridge-consent-host";

  // ---------- ошибки с кодом протокола ----------
  function cerr(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------- MutationObserver: тихое окно + dirty-флаг ref-карты (N8) ----------
  // Мутации НЕ стирают ref-карту — только помечают её dirty; точечная
  // ревалидация происходит в B.refs.resolve() при команде по конкретному ref.
  let lastMutation = Date.now();

  function isOwnNode(n) {
    return n && n.nodeType === 1 && n.id === CONSENT_HOST_ID;
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      // Свой баннер не считаем внешней мутацией (не глушим тихое окно и ref-карту).
      const own =
        isOwnNode(m.target) ||
        (m.addedNodes.length > 0 &&
          m.removedNodes.length === 0 &&
          Array.prototype.every.call(m.addedNodes, isOwnNode)) ||
        (m.removedNodes.length > 0 &&
          m.addedNodes.length === 0 &&
          Array.prototype.every.call(m.removedNodes, isOwnNode));
      if (own) continue;
      lastMutation = Date.now();
      if (B.refs) B.refs.markDirty();
      return;
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  /** «Тихое окно» (N9): readyState >= interactive и QUIET_MS без мутаций. */
  function waitQuiet(timeoutMs) {
    const timeout = timeoutMs || QUIET_TIMEOUT_MS;
    const start = Date.now();
    return new Promise((resolve) => {
      (function check() {
        const readyOk =
          document.readyState === "interactive" || document.readyState === "complete";
        if (readyOk && Date.now() - lastMutation >= QUIET_MS) {
          return resolve({ truncated: false });
        }
        if (Date.now() - start >= timeout) {
          return resolve({ truncated: true }); // продолжаем с тем, что есть (§7)
        }
        setTimeout(check, 100);
      })();
    });
  }

  // ---------- флаги DOM-маркеров ----------
  function computeFlags() {
    // Только ВИДИМЫЕ элементы: script-теги и невидимые интеграции (invisible
    // reCAPTCHA/Turnstile, пустые 0px div.g-recaptcha) флагов не дают — иначе
    // ложные авто-паузы на сайтах с фоновой антибот-защитой (Teachable и пр.).
    const vis = (sel) => {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (el.getClientRects().length && el.offsetWidth > 0 && el.offsetHeight > 0) {
            return true;
          }
        }
        return false;
      } catch (e) {
        return false;
      }
    };
    const flags = [];
    if (
      vis(
        '[id*="cf-chl"],[class*="cf-chl"],[id*="challenge-platform"],[class*="challenge-platform"],' +
          '[id*="turnstile"],[class*="turnstile"],' +
          'iframe[src*="challenges.cloudflare.com"]'
      )
    )
      flags.push("cloudflare_challenge");
    if (
      vis(
        '.g-recaptcha,[class*="g-recaptcha"],iframe[src*="recaptcha"],' +
          '.h-captcha,[class*="h-captcha"],iframe[src*="hcaptcha"]'
      )
    )
      flags.push("captcha");
    if (vis('input[autocomplete="one-time-code"]')) flags.push("otp");
    if (vis('input[type="password"]')) flags.push("login_form");
    return flags;
  }

  let lastAutoPauseKey = "";
  function maybeAutoPause(flags) {
    const auto = flags.filter(
      (f) => f === "captcha" || f === "cloudflare_challenge" || f === "otp"
    );
    const key = auto.slice().sort().join(",");
    if (auto.length === 0) {
      lastAutoPauseKey = "";
      return;
    }
    if (key === lastAutoPauseKey) return; // не спамим повторными pause.auto
    lastAutoPauseKey = key;
    browser.runtime
      .sendMessage({
        kind: "evt",
        event: "pause.auto",
        data: { reason: "auto:" + key, flags },
      })
      .catch(() => {});
  }

  /** Состояние страницы после команды: url/title/flags + авто-пауза при маркерах. */
  function pageState() {
    const flags = computeFlags();
    maybeAutoPause(flags);
    return { url: location.href, title: document.title, flags };
  }

  /**
   * Блок after для act.*: если была навигация или DOM менялся (dirty) —
   * компактный список интерактивных текущего скоупа (ref-метки живые).
   * pivot — элемент команды: прижимает after к месту действия (без навигации).
   * Ничего не изменилось → поле не добавляется.
   */
  function withAfter(state, navigated, pivot) {
    if (!navigated && !(B.refs && B.refs.dirty)) return state;
    if (!B.snapshot || !B.snapshot.afterBlock) return state;
    return Object.assign(state, B.snapshot.afterBlock(navigated ? null : pivot || null));
  }

  /**
   * Ожидание асинхронных подсказок (автокомплит приходит по сети ПОСЛЕ
   * ввода) — СОБЫТИЙНОЕ, без тайминговой подгонки: MutationObserver следит
   * за childList-вставками. Выходим, когда ОДНА вставка приносит пачку
   * (>=3) новых интерактивных элементов — сигнатура выпадающего списка.
   * Атрибутные мутации (флап классов, спиннеры) игнорируются. Дедлайн —
   * только страховка от зависания: под нагрузкой ждём дольше, на быстрой
   * системе выходим раньше. Диагностика — в window.__BRIDGE__.debugSettle.
   */
  const SUGGEST_TIMEOUT_MS = 8000; // страховочный потолок ожидания
  const SUGGEST_MIN_DELTA = 3; // минимум новых интерактивных за вставку = «появился список»
  async function settleForSuggestions() {
    if (!B.snapshot || !B.snapshot.countInteractive) return;
    await waitQuiet(3000); // основное тихое окно (укороченный таймаут для ввода)
    const isInter = B.snapshot.isInteractiveEl;
    const dbg = { v: 4, baseline: B.snapshot.countInteractive(), exit: "deadline", added: 0 };
    B.debugSettle = dbg;
    await new Promise((resolve) => {
      const deadline = Date.now() + SUGGEST_TIMEOUT_MS;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearInterval(timer);
        resolve();
      };
      const obs = new MutationObserver((mutations) => {
        let added = 0;
        let first = "";
        for (const m of mutations) {
          if (m.type !== "childList") continue; // флап атрибутов — не подсказки
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            const countIn = (el) => {
              let c = 0;
              try {
                if (isInter(el)) {
                  c++;
                  if (!first) first = el.tagName.toLowerCase() + ":" + String(el.innerText || "").slice(0, 40);
                }
                for (const d of el.querySelectorAll("*")) if (isInter(d)) c++;
              } catch (e) {}
              return c;
            };
            added += countIn(n);
          }
        }
        if (added > dbg.added) {
          dbg.added = added;
          dbg.first = first;
        }
        if (added >= SUGGEST_MIN_DELTA) {
          dbg.exit = "list";
          finish();
        }
      });
      obs.observe(document.documentElement, { subtree: true, childList: true });
      const timer = setInterval(() => {
        if (Date.now() >= deadline) finish();
      }, 300);
    });
  }

  // ---------- ref ----------
  function mustResolve(ref) {
    const el = B.refs && B.refs.resolve(ref);
    if (!el) throw cerr("STALE_REF", "ref " + ref + " инвалидирован — сделайте свежий snapshot");
    return el;
  }

  /** Цель клика: по ref (как раньше) или атомарно по тексту (click-by-text). */
  function resolveClickTarget(params) {
    if (params.text == null) return mustResolve(params.ref);
    const r = B.snapshot.findByText(String(params.text));
    if (r.status === "one") return r.el;
    if (r.status === "many") {
      throw cerr("AMBIGUOUS", "несколько кандидатов: " + r.texts.join(" | "));
    }
    throw cerr(
      "NOT_FOUND",
      "кликабельный элемент «" + params.text + "» не найден. Ближайшие: " +
        (r.texts.length ? r.texts.join(" | ") : "—")
    );
  }

  // ---------- N3: реалистичные события ----------
  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function dispatchMouse(el, type) {
    const { x, y } = centerOf(el);
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
      })
    );
  }

  function dispatchPointer(el, type) {
    if (typeof PointerEvent !== "function") return;
    const { x, y } = centerOf(el);
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
        pointerType: "mouse",
        isPrimary: true,
      })
    );
  }

  /**
   * pointerover→mouseover→pointerdown→mousedown→focus→pointerup→mouseup,
   * затем el.click(): он даёт default action (навигацию/сабмит).
   * Синтетическое click-событие НЕ диспатчим, чтобы хендлеры не сработали дважды.
   */
  function realisticClick(el) {
    dispatchPointer(el, "pointerover");
    dispatchMouse(el, "mouseover");
    dispatchPointer(el, "pointerdown");
    dispatchMouse(el, "mousedown");
    try {
      el.focus();
    } catch (e) {}
    dispatchPointer(el, "pointerup");
    dispatchMouse(el, "mouseup");
    el.click();
  }

  // N3: клавиатурное событие — автокомплиты часто слушают keydown/keyup,
  // а не input; isTrusted=false подделать нельзя, но ключевые поля честные.
  function dispatchKey(el, type, key) {
    el.dispatchEvent(
      new KeyboardEvent(type, {
        key: key,
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );
  }

  // Нативный сеттер value с прототипа — React-совместимая установка значения.
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  // ---------- sha256 (dom_hash) ----------
  async function sha256Hex(bytes) {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.prototype.map
        .call(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    // Не-secure context (http-страница): crypto.subtle недоступен (ограничение MVP).
    return "";
  }

  async function sha256Short(str) {
    const hex = await sha256Hex(new TextEncoder().encode(str));
    return hex.slice(0, 16);
  }

  // ---------- pressKey ----------
  const KEY_PROPS = {
    Enter: { code: "Enter", keyCode: 13 },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    " ": { code: "Space", keyCode: 32 },
  };

  function pressKey(key) {
    const props = KEY_PROPS[key] || { code: "Key" + key.toUpperCase(), keyCode: 0 };
    const target = document.activeElement || document.body;
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(
        new KeyboardEvent(type, {
          key,
          code: props.code,
          keyCode: props.keyCode,
          which: props.keyCode,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  // ---------- waitFor: событийное ожидание условия (page.wait_for, П1-1) ----------
  // Один активный wait на вкладку (очередей в протоколе нет — осознанно).
  // Проверка — по DOM-мутациям (childList/characterData) + редкий тик для
  // url_contains (history-навигация мутаций не даёт). Таймаут — НЕ ошибка:
  // condition_met:false, чтобы модель планировала дальше.
  let activeWait = null;

  function evalWaitCondition(cond, state) {
    const negate = state === "disappear" || state === "stale";
    let has = false;
    if (cond.url_contains != null) {
      has = location.href.includes(String(cond.url_contains));
    } else if (cond.ref != null) {
      has = !!(B.refs && B.refs.resolve(String(cond.ref)));
    } else if (cond.text != null) {
      has = ((document.body && document.body.innerText) || "").includes(String(cond.text));
    }
    return negate ? !has : has;
  }

  async function waitForHandler(params) {
    if (activeWait) {
      throw cerr("WAIT_BUSY", "на вкладке уже есть активный page.wait_for — дождись его завершения");
    }
    const cond = params.condition || {};
    const state = params.state || "appear";
    if (cond.text == null && cond.ref == null && cond.url_contains == null) {
      throw cerr("INTERNAL", "wait_for: нужно condition.text, condition.ref или condition.url_contains");
    }
    const timeoutMs = Math.min(Math.max(Number(params.timeout_ms) || 10000, 500), 30000);
    const wait = new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const cleanup = () => {
        obs.disconnect();
        clearInterval(timer);
        activeWait = null;
      };
      const check = () => {
        let met = false;
        try {
          met = evalWaitCondition(cond, state);
        } catch (e) {
          met = false;
        }
        if (met || Date.now() >= deadline) {
          cleanup();
          resolve(met);
        }
      };
      const obs = new MutationObserver((mutations) => {
        // Флап атрибутов (классы, спиннеры) не трогает текст/структуру —
        // реагируем на реальные вставки и изменения текста.
        for (const m of mutations) {
          if (m.type === "childList" || m.type === "characterData") return check();
        }
      });
      obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      const timer = setInterval(check, 300); // страховка + url_contains
      check(); // условие может быть уже выполнено
    });
    activeWait = wait;
    const met = await wait;
    return Object.assign(pageState(), { condition_met: met, waited_state: state });
  }

  // ---------- page.console: кольцевой буфер записей MAIN-world хука ----------
  // Content script в isolated world НЕ видит console.*/onerror страницы —
  // записи присылает console-hook.js (MAIN world, web_accessible_resources)
  // через window.postMessage с маркером __bridge_console. Модель «боковой
  // линии» (как net.list): пассивный сбор, чтение по команде consoleLog.
  // Буфер живёт в контексте документа → при полной навигации очищается сам.
  const CONSOLE_CAP = 100; // кольцевой буфер, записей на вкладку
  const CONSOLE_TEXT_MAX = 500; // обрезка text записи
  const consoleEntries = [];
  let consoleHookState = "pending"; // pending | ok | failed

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__bridge_console !== true) return;
    const level = ["log", "info", "warn", "error", "debug"].includes(d.level) ? d.level : "log";
    const text = String(d.text == null ? "" : d.text).slice(0, CONSOLE_TEXT_MAX);
    // Дедуп подряд идущих одинаковых — складываем в count (спам-защита поверх
    // rate-limit хука: маркер может подделать сама страница, untrusted by design).
    const last = consoleEntries[consoleEntries.length - 1];
    if (last && last.level === level && last.text === text) {
      last.count = (last.count || 1) + 1;
      last.ts = Number(d.ts) || Date.now();
      return;
    }
    consoleEntries.push({ ts: Number(d.ts) || Date.now(), level, text });
    if (consoleEntries.length > CONSOLE_CAP) {
      consoleEntries.splice(0, consoleEntries.length - CONSOLE_CAP);
    }
  });

  // Инъекция хука — сразу при загрузке content script (document_idle): записи
  // до инъекции теряются (честное ограничение, задокументировано в PROTOCOL.md).
  // Страница с жёстким CSP может запретить загрузку расширенческого скрипта —
  // тогда onerror и consoleLog отвечает маркером console_unavailable.
  (function injectConsoleHook() {
    try {
      const s = document.createElement("script");
      s.src = browser.runtime.getURL("src/console-hook.js");
      s.onload = () => {
        consoleHookState = "ok";
        s.remove();
      };
      s.onerror = () => {
        consoleHookState = "failed";
        s.remove();
      };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      consoleHookState = "failed";
    }
  })();

  // ---------- обработчики команд ----------
  const handlers = {
    // Опрос после навигации, инициированной background'ом или полной перезагрузкой.
    // Страница новая → after прилагается всегда (экономит отдельный snapshot).
    async __postNav() {
      const q = await waitQuiet();
      const st = Object.assign(pageState(), { truncated: q.truncated });
      return withAfter(st, true);
    },

    async __consent(params) {
      if (!B.showConsent) throw cerr("INTERNAL", "consent-banner не загружен");
      return B.showConsent(params);
    },

    async click(params) {
      const el = resolveClickTarget(params); // ref-путь и атомарный click-by-text
      const urlBefore = location.href;
      const docBefore = document;

      // Якорь цели (сам элемент или предок) с абсолютным http(s) href —
      // кандидат на фолбэк навигации, если JS проигнорировал/подавил клик.
      let anchorHref = null;
      const anchor = el.closest ? el.closest("a[href]") : null;
      if (anchor) {
        try {
          const u = new URL(anchor.getAttribute("href"), location.href);
          if (u.protocol === "http:" || u.protocol === "https:") anchorHref = u.href;
        } catch (e) {}
      }
      // Диагностика цели — возвращается в ответе click.
      const clicked = {
        tag: el.tagName.toLowerCase(),
        text: String(el.innerText || el.value || el.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80),
        href: anchorHref,
      };

      el.scrollIntoView({ block: "center" });
      realisticClick(el);
      // Полная навигация убьёт этот контекст — background обработает fallback.
      // Ждём смену location/документа до ~2 c (SPA/hash-навигация), затем тихое окно.
      const navDeadline = Date.now() + 2000;
      while (Date.now() < navDeadline) {
        if (location.href !== urlBefore || document !== docBefore) break;
        await sleep(100);
      }
      const q = await waitQuiet();
      // Честный флаг: смена URL (SPA/hash) ИЛИ замена документа (document.open/write).
      const navigated = location.href !== urlBefore || document !== docBefore;
      const out = Object.assign(pageState(), {
        navigated,
        clicked,
        truncated: q.truncated,
      });
      // Навигации не случилось, но якорь есть → отдаём background'у на фолбэк
      // (after со старой страницы в этом случае бесполезен).
      if (!navigated && anchorHref) {
        out.anchor_href = anchorHref;
        return out;
      }
      return withAfter(out, navigated, el);
    },

    async type(params) {
      const el = mustResolve(params.ref);
      const text = String(params.text == null ? "" : params.text);
      el.scrollIntoView({ block: "center" });
      el.focus();
      if (el.isContentEditable) {
        const key = text.slice(-1) || "Unidentified";
        dispatchKey(el, "keydown", key);
        el.textContent = params.clear ? text : el.textContent + text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        dispatchKey(el, "keyup", key);
      } else {
        // Посимвольно: keydown → value+input → keyup на каждый символ —
        // так срабатывают автокомплиты, слушающие клавиатуру, а не input.
        let cur = params.clear ? "" : el.value;
        for (const ch of text) {
          dispatchKey(el, "keydown", ch);
          cur += ch;
          setNativeValue(el, cur);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          dispatchKey(el, "keyup", ch);
        }
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await settleForSuggestions(); // автокомплит приходит по сети после ввода
      // Диагностика ожидания подсказок — в window.__BRIDGE__.debugSettle
      // (в ответ не включаем: П0-4, экономия токенов).
      return withAfter(pageState(), false, el);
    },
    async select(params) {
      const el = mustResolve(params.ref);
      if (el.tagName !== "SELECT") throw cerr("INTERNAL", "ref " + params.ref + " не <select>");
      const value = String(params.value);
      el.focus();
      setNativeValue(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (el.value !== value) throw cerr("INTERNAL", "option не найден: " + value);
      return withAfter(pageState(), false, el);
    },

    async scroll(params) {
      window.scrollBy(0, Number(params.dy) || 0);
      await sleep(150);
      return withAfter(pageState(), false);
    },

    async scrollIntoView(params) {
      const el = mustResolve(params.ref);
      el.scrollIntoView({ block: "center" });
      await sleep(150);
      return withAfter(pageState(), false, el);
    },

    async pressKey(params) {
      pressKey(String(params.key || ""));
      await settleForSuggestions(); // Enter/стрелки в поле поиска тоже ждут автокомплит
      return withAfter(pageState(), false, document.activeElement);
    },

    async hover(params) {
      const el = resolveClickTarget(params); // ref или атомарный поиск по тексту (как click)
      el.scrollIntoView({ block: "center" });
      dispatchPointer(el, "pointerover");
      dispatchMouse(el, "mouseover");
      dispatchMouse(el, "mousemove");
      await sleep(150); // дать JS-хендлерам hover раскрыть меню/тултип до after
      return withAfter(pageState(), false, el);
    },

    async snapshot(params) {
      const r = B.snapshot.build(params || {});
      const dom_hash = await sha256Short(r.snapshot);
      return Object.assign(pageState(), {
        snapshot: r.snapshot,
        dom_hash,
        truncated: r.truncated,
      });
    },

    async extractMarkdown(params) {
      const r = B.snapshot.extractMarkdown(params || {});
      return Object.assign(pageState(), { markdown: r.markdown, images: r.images });
    },

    async findText(params) {
      const matches = B.snapshot.findText(params || {});
      return Object.assign(pageState(), { matches });
    },

    async getStateHash() {
      const r = B.snapshot.build({});
      const dom_hash = await sha256Short(r.snapshot);
      return { url: location.href, dom_hash };
    },

    async waitFor(params) {
      return waitForHandler(params || {});
    },

    async scan(params) {
      const r = await B.snapshot.scan(params || {});
      return Object.assign(pageState(), r);
    },

    async consoleLog(params) {
      const limit = Math.min(Math.max(Number(params && params.limit) || CONSOLE_CAP, 1), CONSOLE_CAP);
      const out = Object.assign(pageState(), { entries: consoleEntries.slice(-limit) });
      // CSP запретил MAIN-world хук — честный маркер деградации (как
      // netlog_unavailable), а не молчаливый пустой буфер.
      if (consoleHookState === "failed") {
        out.console_unavailable = "MAIN-world хук не загрузился (CSP страницы?) — буфер не пишется";
      }
      return out;
    },
  };

  // ---------- шина сообщений от background ----------
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object" || msg.kind !== "cmd") return undefined;
    const h = handlers[msg.method];
    if (!h) {
      return Promise.resolve({
        ok: false,
        error: { code: "INTERNAL", message: "неизвестный метод: " + msg.method },
      });
    }
    return Promise.resolve()
      .then(() => h(msg.params || {}))
      .then((result) => ({ ok: true, result }))
      .catch((e) => ({
        ok: false,
        error: {
          code: (e && e.code) || "INTERNAL",
          message: String((e && e.message) || e),
        },
      }));
  });
})();
