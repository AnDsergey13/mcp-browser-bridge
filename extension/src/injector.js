/* global browser, chrome */
"use strict";

/**
 * injector.js — изоляция браузерозависимой инжекции content scripts.
 * Три реализации под одним интерфейсом BridgeInjector (D10):
 *  - "firefox":  browser.contentScripts.register() (MV2, как было);
 *  - "mv3":      chrome.scripting.registerContentScripts()
 *                (persistAcrossSessions:false — регистрации живут до перезапуска
 *                браузера и переживают рестарты service worker);
 *  - "fallback": executeScript по tabs.onUpdated (ни contentScripts, ни
 *                scripting нет — самолечение минимальными средствами).
 * Выбор — по доступным API (feature detection), не по манифесту.
 */
const BridgeInjector = (() => {
  // Порядок важен: compat-browser.js первым (шим `browser` в Chromium, no-op в
  // Firefox); snapshot.js и consent-banner.js определяют window.__BRIDGE__.*,
  // которыми пользуется content-bridge.js.
  const CONTENT_JS = [
    { file: "src/compat-browser.js" },
    { file: "src/snapshot.js" },
    { file: "src/consent-banner.js" },
    { file: "src/content-bridge.js" },
  ];
  const MV3_ID_PREFIX = "bridge-"; // префикс id динамических регистраций MV3

  /** @type {Array<{unregister: () => Promise<void>}>} активные регистрации */
  let registrations = [];
  /** Последние применённые match_patterns (для повторной регистрации после выдачи host-прав). */
  let currentPatterns = [];
  let detectedMode = null;

  function detectMode() {
    if (detectedMode) return detectedMode;
    if (
      typeof browser !== "undefined" &&
      browser.contentScripts &&
      typeof browser.contentScripts.register === "function"
    ) {
      detectedMode = "firefox";
    } else if (
      typeof chrome !== "undefined" &&
      chrome.scripting &&
      typeof chrome.scripting.registerContentScripts === "function"
    ) {
      detectedMode = "mv3";
    } else {
      detectedMode = "fallback";
    }
    return detectedMode;
  }

  async function hasHostPermission() {
    try {
      return await browser.permissions.contains({ origins: ["<all_urls>"] });
    } catch (e) {
      return false;
    }
  }

  /** chrome.scripting.* в MV3 возвращают промис, но callback тоже принимают. */
  function maybePromise(result) {
    return result && typeof result.then === "function" ? result : Promise.resolve(result);
  }

  // ---------- firefox (MV2) ----------
  async function registerOneFirefox(matches) {
    return browser.contentScripts.register({
      matches,
      js: CONTENT_JS.map((j) => ({ ...j })),
      runAt: "document_idle",
      // allFrames не задаём: работаем только с верхним фреймом (MVP).
    });
  }

  // ---------- mv3 (Chromium) ----------
  let mv3Seq = 0;
  async function registerOneMv3(matches) {
    const id = MV3_ID_PREFIX + "cs-" + ++mv3Seq;
    // id мог остаться от прошлой жизни SW — сначала снимаем, потом регистрируем.
    try {
      await maybePromise(chrome.scripting.unregisterContentScripts({ ids: [id] }));
    } catch (e) {}
    await maybePromise(
      chrome.scripting.registerContentScripts([
        {
          id,
          matches,
          js: CONTENT_JS.map((j) => j.file),
          runAt: "document_idle",
          persistAcrossSessions: false,
        },
      ])
    );
    return {
      unregister: () =>
        maybePromise(chrome.scripting.unregisterContentScripts({ ids: [id] })).catch(() => {}),
    };
  }

  /** Самолечение после рестарта SW: снять ВСЕ наши регистрации (in-memory список пуст). */
  async function sweepMv3() {
    try {
      const regs = await maybePromise(chrome.scripting.getRegisteredContentScripts());
      const ids = (regs || []).map((r) => r.id).filter((id) => id.startsWith(MV3_ID_PREFIX));
      if (ids.length) {
        await maybePromise(chrome.scripting.unregisterContentScripts({ ids }));
      }
    } catch (e) {
      // прав на scripting может не быть при старте без host-прав — не критично
    }
  }

  // ---------- fallback (executeScript + tabs.onUpdated) ----------
  // Локальный конвертер match pattern → RegExp (копия логики background.js —
  // инжектор самодостаточен, чтобы работать до загрузки background).
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function matchPatternToRegExp(pattern) {
    const m = /^(\*|https?):\/\/([^/]*)(\/.*)$/.exec(pattern || "");
    if (!m) return null;
    const scheme = m[1] === "*" ? "https?" : m[1];
    const host = m[2];
    const hostRe = host.startsWith("*.")
      ? "(?:[^/]*\\.)?" + escapeRe(host.slice(2))
      : host.split("*").map(escapeRe).join("[^/]*");
    const pathRe = m[3].split("*").map(escapeRe).join(".*");
    return new RegExp("^" + scheme + "://" + hostRe + pathRe + "$");
  }
  function fallbackMatches(url) {
    return currentPatterns.some((p) => {
      const re = matchPatternToRegExp(p);
      return re && re.test(url || "");
    });
  }

  let fallbackListenerOn = false;
  function ensureFallbackListener() {
    if (fallbackListenerOn) return;
    fallbackListenerOn = true;
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status !== "complete") return;
      if (!currentPatterns.length || !fallbackMatches(tab && tab.url)) return;
      hasHostPermission().then((ok) => {
        if (!ok) return;
        for (const j of CONTENT_JS) {
          browser.tabs
            .executeScript(tabId, { file: j.file, runAt: "document_idle" })
            .catch(() => {});
        }
      });
    });
  }

  // ---------- общее ----------
  async function unregisterAll() {
    const old = registrations;
    registrations = [];
    for (const reg of old) {
      try {
        await reg.unregister();
      } catch (e) {
        // регистрация могла быть уже снята — не критично
      }
    }
    if (detectMode() === "mv3") await sweepMv3();
  }

  /** Диагностика инжектора в storage.local — popup показывает пользователю. */
  async function writeDiagnostics(registered, patterns) {
    await browser.storage.local.set({
      injectorRegistered: registered,
      injectorPatterns: patterns,
      injectorMode: detectMode(),
      injectorTs: Date.now(),
    });
  }

  async function registerOne(matches) {
    return detectMode() === "mv3" ? registerOneMv3(matches) : registerOneFirefox(matches);
  }

  /**
   * Применить match_patterns из policy.update:
   * старые регистрации снимаются, новые создаются только под домены политики.
   * Требует host-права <all_urls>; если их нет — выставляет флаг needHostPermission
   * в storage.local (popup покажет кнопку; сам permissions.request вызывается
   * ТОЛЬКО по жесту пользователя в popup, N2).
   * Если пакетная регистрация падает — перебираем паттерны по одному:
   * валидные регистрируются, невалидные уходят в storage.local.lastError.
   * В fallback-режиме регистрации нет: паттерны запоминаются, инжекция идёт
   * по tabs.onUpdated через executeScript.
   */
  async function applyPolicy(policyData) {
    const patterns =
      policyData && Array.isArray(policyData.match_patterns)
        ? policyData.match_patterns.filter((p) => typeof p === "string" && p.length)
        : [];
    currentPatterns = patterns;
    await unregisterAll();

    if (!(await hasHostPermission())) {
      await browser.storage.local.set({ needHostPermission: true });
      await writeDiagnostics(false, []);
      return { registered: false, needHostPermission: true };
    }
    await browser.storage.local.set({ needHostPermission: false });

    if (patterns.length === 0) {
      await writeDiagnostics(true, []);
      return { registered: true, count: 0 };
    }

    if (detectMode() === "fallback") {
      ensureFallbackListener();
      await writeDiagnostics(true, patterns);
      return { registered: true, fallback: true, count: patterns.length };
    }

    let valid = [];
    try {
      registrations.push(await registerOne(patterns));
      valid = patterns;
    } catch (batchErr) {
      // Пакет не прошёл — перебор по одному паттерну.
      const bad = [];
      for (const p of patterns) {
        try {
          registrations.push(await registerOne([p]));
          valid.push(p);
        } catch (e) {
          bad.push(p + " (" + e.message + ")");
        }
      }
      if (bad.length) {
        await browser.storage.local.set({
          lastError: "injector: невалидные паттерны: " + bad.join("; "),
        });
      } else if (valid.length === 0) {
        await browser.storage.local.set({
          lastError: "injector: register failed: " + batchErr.message,
        });
      }
    }

    await writeDiagnostics(valid.length > 0, valid);
    return { registered: valid.length > 0, count: valid.length };
  }

  /** Вызывается background'ом после того, как popup выдал <all_urls> по жесту пользователя. */
  async function onHostPermissionGranted() {
    return applyPolicy({ match_patterns: currentPatterns });
  }

  return { applyPolicy, onHostPermissionGranted, hasHostPermission, detectMode };
})();
