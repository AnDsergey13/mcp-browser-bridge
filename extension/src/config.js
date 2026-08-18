/* global browser */
"use strict";

/**
 * config.js — конфиг подключений к серверам (D11).
 * Хранилище: storage.local["servers"] = [{label, url, secret}].
 * Миграция: legacy-формат одного сервера {serverUrl, secret} переносится
 * в servers при старте, legacy-ключи удаляются.
 */
const BridgeConfig = (() => {
  const DEFAULT_SERVER_URL = "ws://127.0.0.1:18777";
  const LEGACY_KEYS = ["serverUrl", "secret"];

  /** Нормализация записи сервера; невалидная (без url) → null. */
  function normalizeServer(raw, idx) {
    if (!raw || typeof raw !== "object") return null;
    const url = typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : "";
    if (!url) return null;
    return {
      label: String(raw.label || "server-" + (idx + 1)),
      url,
      secret: typeof raw.secret === "string" ? raw.secret : "",
    };
  }

  /**
   * Из сырых данных storage.local → список серверов.
   * Возвращает {servers, migrated}: migrated=true, если использован
   * legacy-формат и storage надо перезаписать (set servers + remove legacy).
   * Пустой конфиг → один сервер по умолчанию (поведение прежней версии).
   */
  function migrate(stored) {
    const raw = stored && typeof stored === "object" ? stored : {};
    const list = Array.isArray(raw.servers) ? raw.servers : [];
    const servers = list.map((s, i) => normalizeServer(s, i)).filter(Boolean);
    if (servers.length) return { servers, migrated: false };
    // legacy: явно заданные serverUrl/secret (пустые строки = «нет конфига»)
    const legacyUrl = typeof raw.serverUrl === "string" ? raw.serverUrl : "";
    const legacySecret = typeof raw.secret === "string" ? raw.secret : "";
    if (legacyUrl || legacySecret) {
      return {
        servers: [
          { label: "default", url: legacyUrl || DEFAULT_SERVER_URL, secret: legacySecret },
        ],
        migrated: true,
      };
    }
    return {
      servers: [{ label: "default", url: DEFAULT_SERVER_URL, secret: "" }],
      migrated: false,
    };
  }

  /** Прочитать конфиг из storage.local с миграцией legacy-ключей. */
  async function load() {
    const stored = await browser.storage.local.get({
      servers: [],
      serverUrl: "",
      secret: "",
    });
    const { servers, migrated } = migrate(stored);
    if (migrated) {
      await browser.storage.local.set({ servers });
      await browser.storage.local.remove(LEGACY_KEYS);
    }
    return servers;
  }

  return { DEFAULT_SERVER_URL, LEGACY_KEYS, normalizeServer, migrate, load };
})();
