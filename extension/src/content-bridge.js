/* global browser */
"use strict";

/**
 * content-bridge.js — исполнитель команд страницы.
 * Получает от background сообщения {kind:"cmd", method, params},
 * отвечает {ok:true, result} | {ok:false, error:{code,message}}.
 * События (pause.auto, file.*) шлёт в background через runtime.sendMessage.
 * Общие модули: window.__BRIDGE__.snapshot / .refs (snapshot.js),
 * window.__BRIDGE__.showConsent (consent-banner.js).
 */
(() => {
  if (window.__BRIDGE_CONTENT_LOADED__) return; // защита от двойной загрузки
  window.__BRIDGE_CONTENT_LOADED__ = true;
  const B = (window.__BRIDGE__ = window.__BRIDGE__ || {});

  const QUIET_MS = 500; // «тихое окно»: столько без DOM-мутаций (N9)
  const QUIET_TIMEOUT_MS = 10000; // общий таймаут тихого окна
  const CHUNK_SIZE = 256 * 1024; // чанк файлового релея (§8)
  const ACK_TIMEOUT_MS = 15000; // таймаут file.ack на чанк
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
    const q = (sel) => {
      try {
        return !!document.querySelector(sel);
      } catch (e) {
        return false;
      }
    };
    const flags = [];
    if (
      q(
        '[id*="cf-chl"],[class*="cf-chl"],[id*="challenge-platform"],[class*="challenge-platform"],' +
          '[id*="turnstile"],[class*="turnstile"],' +
          'iframe[src*="challenges.cloudflare.com"],script[src*="challenges.cloudflare.com"]'
      )
    )
      flags.push("cloudflare_challenge");
    if (
      q(
        '.g-recaptcha,[class*="g-recaptcha"],iframe[src*="recaptcha"],script[src*="recaptcha"],' +
          '.h-captcha,[class*="h-captcha"],iframe[src*="hcaptcha"]'
      )
    )
      flags.push("captcha");
    if (q('input[autocomplete="one-time-code"]')) flags.push("otp");
    if (q('input[type="password"]')) flags.push("login_form");
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

  // ---------- ref ----------
  function mustResolve(ref) {
    const el = B.refs && B.refs.resolve(ref);
    if (!el) throw cerr("STALE_REF", "ref " + ref + " инвалидирован — сделайте свежий snapshot");
    return el;
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

  // ---------- sha256 ----------
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

  // ---------- файловый релей (§8) ----------
  function u8ToBase64(bytes) {
    let bin = "";
    const SLICE = 0x8000; // fromCharCode.apply не переживает большие spread'ы
    for (let i = 0; i < bytes.length; i += SLICE) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE));
    }
    return btoa(bin);
  }

  function sendFileMsg(sub, data) {
    return browser.runtime.sendMessage({ kind: "file", sub, data });
  }

  async function fetchFileRelay(params) {
    const transferId = params.transferId;
    let resp;
    try {
      resp = await fetch(params.url, { credentials: "include" });
    } catch (e) {
      await sendFileMsg("abort", { transferId, reason: "network: " + e.message }).catch(() => {});
      throw cerr("FETCH_FAILED", "fetch failed: " + e.message);
    }
    if (!resp.ok || !resp.body) {
      await sendFileMsg("abort", { transferId, reason: "http_" + resp.status }).catch(() => {});
      throw cerr("FETCH_FAILED", "HTTP " + resp.status);
    }

    const mime = resp.headers.get("content-type") || "application/octet-stream";
    const sizeHdr = Number(resp.headers.get("content-length")) || 0;
    const fname =
      params.name ||
      decodeURIComponent((params.url.split("/").pop() || "file").split("?")[0]) ||
      "file";
    await sendFileMsg("start", {
      transferId,
      name: fname,
      size: sizeHdr || undefined,
      mime,
    });

    const reader = resp.body.getReader();
    const parts = [];
    let total = 0;
    let seq = 0;
    let buf = new Uint8Array(0);

    async function emitChunk(bytes) {
      const ack = await Promise.race([
        sendFileMsg("chunk", { transferId, seq, data_base64: u8ToBase64(bytes) }),
        sleep(ACK_TIMEOUT_MS).then(() => ({ ok: false, error: "ACK_TIMEOUT" })),
      ]);
      if (!ack || !ack.ok) {
        throw cerr("FETCH_FAILED", "file.ack не получен: " + ((ack && ack.error) || "нет ответа"));
      }
      seq++;
    }

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value && value.length) {
          const merged = new Uint8Array(buf.length + value.length);
          merged.set(buf, 0);
          merged.set(value, buf.length);
          buf = merged;
          while (buf.length >= CHUNK_SIZE) {
            const chunkBytes = buf.slice(0, CHUNK_SIZE);
            buf = buf.slice(CHUNK_SIZE);
            parts.push(chunkBytes);
            total += chunkBytes.length;
            await emitChunk(chunkBytes); // backpressure: ждём file.ack (§8)
          }
        }
        if (done) break;
      }
      if (buf.length) {
        parts.push(buf);
        total += buf.length;
        await emitChunk(buf);
      }
    } catch (e) {
      try {
        await reader.cancel();
      } catch (_) {}
      await sendFileMsg("abort", { transferId, reason: String((e && e.message) || e) }).catch(
        () => {}
      );
      if (e && e.code) throw e;
      throw cerr("FETCH_FAILED", String((e && e.message) || e));
    }

    // Склейка в память для sha256 — ограничение MVP (очень большие файлы).
    const whole = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      whole.set(p, off);
      off += p.length;
    }
    const sha256 = await sha256Hex(whole);
    await sendFileMsg("end", { transferId, sha256 });
    return { size: total, sha256 };
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

  // ---------- обработчики команд ----------
  const handlers = {
    // Опрос после навигации, инициированной background'ом или полной перезагрузкой.
    async __postNav() {
      const q = await waitQuiet();
      return Object.assign(pageState(), { truncated: q.truncated });
    },

    async __consent(params) {
      if (!B.showConsent) throw cerr("INTERNAL", "consent-banner не загружен");
      return B.showConsent(params);
    },

    async click(params) {
      const el = mustResolve(params.ref);
      const urlBefore = location.href;
      el.scrollIntoView({ block: "center" });
      realisticClick(el);
      // Полная навигация убьёт этот контекст — background обработает fallback.
      const q = await waitQuiet();
      return Object.assign(pageState(), {
        navigated: location.href !== urlBefore,
        truncated: q.truncated,
      });
    },

    async type(params) {
      const el = mustResolve(params.ref);
      const text = String(params.text == null ? "" : params.text);
      el.scrollIntoView({ block: "center" });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = params.clear ? text : el.textContent + text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        setNativeValue(el, params.clear ? text : el.value + text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return pageState();
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
      return pageState();
    },

    async scroll(params) {
      window.scrollBy(0, Number(params.dy) || 0);
      await sleep(150);
      return pageState();
    },

    async scrollIntoView(params) {
      const el = mustResolve(params.ref);
      el.scrollIntoView({ block: "center" });
      await sleep(150);
      return pageState();
    },

    async pressKey(params) {
      pressKey(String(params.key || ""));
      return pageState();
    },

    async hover(params) {
      const el = mustResolve(params.ref);
      el.scrollIntoView({ block: "center" });
      dispatchPointer(el, "pointerover");
      dispatchMouse(el, "mouseover");
      dispatchMouse(el, "mousemove");
      return pageState();
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

    async fetchFile(params) {
      return fetchFileRelay(params);
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
