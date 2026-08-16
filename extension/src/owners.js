/* global browser */
"use strict";

/**
 * owners.js — реестр владельцев вкладок (D11): tabId → label подключения.
 *
 * Изоляция агентов на уровне вкладок:
 *  - вкладка с владельцем доступна только подключению-владельцу, командам
 *    от чужого подключения — ошибка TAB_NOT_OWNED;
 *  - неназначенная вкладка (открытая человеком) при ОДНОМ настроенном
 *    подключении авто-назначается ему при первой команде — это сохраняет
 *    прежнее одиночное поведение без жестов в popup;
 *  - при двух и более подключениях неназначенные вкладки НЕ доступны и НЕ
 *    видны никому (default-deny), пока popup явно не назначит владельца.
 *
 * Хранение — storage.local["tabOwners"] ({tabId: label}), переживает
 * рестарты MV3 service worker. Закрытие вкладки (tabs.onRemoved) чистит
 * запись (слушатель — в background.js).
 */
const BridgeOwners = (() => {
  const STORAGE_KEY = "tabOwners";

  /** @type {Map<number, string>} tabId → label */
  let owners = new Map();
  let loaded = false;

  function errNotOwned(tabId, owner) {
    const e = new Error(
      owner
        ? "вкладка " + tabId + " принадлежит подключению «" + owner + "»"
        : "вкладка " + tabId + " не назначена ни одному подключению (назначение — в popup)"
    );
    e.code = "TAB_NOT_OWNED";
    return e;
  }

  /** Загрузить реестр из storage.local (идемпотентно). */
  async function load() {
    let stored = {};
    try {
      stored = await browser.storage.local.get({ [STORAGE_KEY]: {} });
    } catch (e) {
      stored = {};
    }
    const raw = stored[STORAGE_KEY];
    owners = new Map();
    if (raw && typeof raw === "object") {
      for (const [tabId, label] of Object.entries(raw)) {
        const id = Number(tabId);
        if (id && typeof label === "string" && label) owners.set(id, label);
      }
    }
    loaded = true;
  }

  async function persist() {
    const obj = {};
    for (const [tabId, label] of owners) obj[tabId] = label;
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: obj });
    } catch (e) {
      console.warn("[bridge] tabOwners persist failed:", e);
    }
  }

  /** Владелец вкладки: label подключения или null. */
  function ownerOf(tabId) {
    return owners.get(Number(tabId)) || null;
  }

  /** Явное назначение владельца (tab.open, popup-жест, авто-назначение). */
  async function assign(tabId, label) {
    owners.set(Number(tabId), String(label));
    await persist();
  }

  /** Снять владельца (закрытие вкладки, popup-жест «сделать неназначенной»). */
  async function release(tabId) {
    if (owners.delete(Number(tabId))) await persist();
  }

  /** Освободить все вкладки подключения (подключение удалено из конфига). */
  async function releaseAll(label) {
    let changed = false;
    for (const [tabId, owner] of owners) {
      if (owner === label) {
        owners.delete(tabId);
        changed = true;
      }
    }
    if (changed) await persist();
  }

  /**
   * Проверка доступа подключения label к вкладке.
   * connCount — число настроенных подключений.
   * Бросает TAB_NOT_OWNED; при авто-назначении (одиночный режим) возвращает true.
   */
  async function assertAccess(tabId, label, connCount) {
    const owner = ownerOf(tabId);
    if (owner === label) return false;
    if (owner) throw errNotOwned(tabId, owner);
    if (connCount <= 1) {
      await assign(tabId, label); // авто-режим одиночного подключения
      return true;
    }
    throw errNotOwned(tabId, null);
  }

  /**
   * Вкладки, видимые подключению: свои; при одиночном подключении — все
   * (неназначенные авто-назначатся при первой команде — поведение как раньше).
   */
  function filterVisible(tabs, label, connCount) {
    if (connCount <= 1) return tabs;
    return tabs.filter((t) => ownerOf(t.id) === label);
  }

  return {
    load,
    ownerOf,
    assign,
    release,
    releaseAll,
    assertAccess,
    filterVisible,
    isLoaded: () => loaded,
  };
})();
