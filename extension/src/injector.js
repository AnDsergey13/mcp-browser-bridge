/* global browser */
"use strict";

/**
 * injector.js — изоляция браузерозависимой инжекции content scripts.
 * Firefox MV2: browser.contentScripts.register().
 * При портировании на Chromium заменить реализацию на
 * chrome.scripting.registerContentScripts() — интерфейс BridgeInjector сохранить.
 */
const BridgeInjector = (() => {
  // Порядок важен: snapshot.js и consent-banner.js определяют window.__BRIDGE__.*,
  // которыми пользуется content-bridge.js.
  const CONTENT_JS = [
    { file: "src/snapshot.js" },
    { file: "src/consent-banner.js" },
    { file: "src/content-bridge.js" },
  ];

  /** @type {Array<{unregister: () => Promise<void>}>} активные регистрации */
  let registrations = [];
  /** Последние применённые match_patterns (для повторной регистрации после выдачи host-прав). */
  let currentPatterns = [];

  async function hasHostPermission() {
    try {
      return await browser.permissions.contains({ origins: ["<all_urls>"] });
    } catch (e) {
      return false;
    }
  }

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
  }

  /** Диагностика инжектора в storage.local — popup показывает пользователю. */
  async function writeDiagnostics(registered, patterns) {
    await browser.storage.local.set({
      injectorRegistered: registered,
      injectorPatterns: patterns,
      injectorTs: Date.now(),
    });
  }

  async function registerOne(matches) {
    return browser.contentScripts.register({
      matches,
      js: CONTENT_JS.map((j) => ({ ...j })),
      runAt: "document_idle",
      // allFrames не задаём: работаем только с верхним фреймом (MVP).
    });
  }

  /**
   * Применить match_patterns из policy.update:
   * старые регистрации снимаются, новые создаются только под домены политики.
   * Требует host-права <all_urls>; если их нет — выставляет флаг needHostPermission
   * в storage.local (popup покажет кнопку; сам permissions.request вызывается
   * ТОЛЬКО по жесту пользователя в popup, N2).
   * Если пакетная регистрация падает — перебираем паттерны по одному:
   * валидные регистрируются, невалидные уходят в storage.local.lastError.
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

  return { applyPolicy, onHostPermissionGranted, hasHostPermission };
})();
