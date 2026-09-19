"use strict";

/**
 * consent-banner.js — баннер подтверждения gated-действий (N4) и баннер
 * download-гранта (П2-5, params.grant === true: домен ФАЙЛА, allow выдаёт
 * session-грант, кнопки «10 мин» нет).
 * Shadow DOM (mode:"closed") поверх страницы: страница не может ни прочитать,
 * ни нажать баннер. По таймауту сам возвращает deny.
 * Экспортирует window.__BRIDGE__.showConsent(params) → Promise<{decision}>.
 */
(() => {
  const B = (window.__BRIDGE__ = window.__BRIDGE__ || {});

  const HOST_ID = "__bridge-consent-host";
  const CATEGORY_LABELS = {
    pay: "Оплата",
    login: "Логин / 2FA",
    submit: "Отправка формы",
    delete: "Удаление / отмена",
    eval: "Выполнение JS",
    download_grant: "Загрузка файла с домена",
    custom: "Действие агента",
  };

  const CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      display: flex; justify-content: center;
      font: 14px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
      pointer-events: none;
    }
    .banner {
      pointer-events: auto;
      margin: 10px; padding: 14px 18px; max-width: 640px; width: 100%;
      background: #1c2430; color: #e8edf3;
      border: 1px solid #d97706; border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,.55);
    }
    .head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .cat {
      background: #d97706; color: #111; font-weight: 700;
      padding: 2px 10px; border-radius: 999px; font-size: 12px;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .domain { color: #9fb4cc; font-size: 13px; word-break: break-all; }
    .timer { margin-left: auto; color: #f2c14e; font-variant-numeric: tabular-nums; }
    .desc { margin: 6px 0 12px; color: #e8edf3; word-break: break-word; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    button {
      font: inherit; padding: 7px 14px; border-radius: 7px; border: 1px solid transparent;
      cursor: pointer;
    }
    .allow { background: #15803d; color: #fff; }
    .allow10 { background: #245073; color: #cfe4f7; border-color: #3b6e99; }
    .deny { background: #7f1d1d; color: #fff; }
    button:focus-visible { outline: 2px solid #f2c14e; outline-offset: 2px; }
  `;

  /**
   * @param {{category:string, domain:string, description:string, timeout_ms:number, grant?:boolean}} params
   * @returns {Promise<{decision:"allow"|"deny"|"allow_10min"}>}
   */
  B.showConsent = function showConsent(params) {
    return new Promise((resolve) => {
      // Один баннер за раз: повторный запрос заменяет прежний.
      const prev = document.getElementById(HOST_ID);
      if (prev) prev.remove();

      const timeoutMs = Number(params && params.timeout_ms) || 120000;
      const deadline = Date.now() + timeoutMs;

      const host = document.createElement("div");
      host.id = HOST_ID;
      const root = host.attachShadow({ mode: "closed" });

      const style = document.createElement("style");
      style.textContent = CSS;
      root.appendChild(style);

      const wrap = document.createElement("div");
      wrap.className = "wrap";
      wrap.innerHTML =
        '<div class="banner" role="alertdialog" aria-modal="false">' +
        '  <div class="head">' +
        '    <span class="cat"></span>' +
        '    <span class="domain"></span>' +
        '    <span class="timer"></span>' +
        "  </div>" +
        '  <div class="desc"></div>' +
        '  <div class="row">' +
        '    <button type="button" class="allow">Разрешить</button>' +
        '    <button type="button" class="deny">Запретить</button>' +
        '    <button type="button" class="allow10">Разрешить подобные 10 мин</button>' +
        "  </div>" +
        "</div>";
      root.appendChild(wrap);

      // Тексты — только через textContent: description приходит по сети.
      wrap.querySelector(".cat").textContent =
        CATEGORY_LABELS[params && params.category] || CATEGORY_LABELS.custom;
      wrap.querySelector(".domain").textContent = (params && params.domain) || "";
      wrap.querySelector(".desc").textContent = (params && params.description) || "";
      const timerEl = wrap.querySelector(".timer");

      // П2-5: режим download-гранта (grant.ask): domain — домен ФАЙЛА, allow
      // выдаёт session-грант (подпись явно об этом); кнопка «10 мин» скрыта —
      // кэш allow_10min работает для gated-категорий, а не для грантов домену.
      if (params && params.grant === true) {
        wrap.querySelector(".allow").textContent = "Разрешить скачивание (на сессию)";
        const allow10 = wrap.querySelector(".allow10");
        if (allow10) allow10.remove();
      }

      let settled = false;
      function finish(decision) {
        if (settled) return;
        settled = true;
        clearInterval(tick);
        host.remove();
        resolve({ decision });
      }

      wrap.querySelector(".allow").addEventListener("click", () => finish("allow"));
      wrap.querySelector(".deny").addEventListener("click", () => finish("deny"));
      // В grant-режиме (П2-5) кнопка «10 мин» удалена выше — слушатель только при наличии.
      const allow10Btn = wrap.querySelector(".allow10");
      if (allow10Btn) allow10Btn.addEventListener("click", () => finish("allow_10min"));

      function renderTimer() {
        const left = Math.max(0, deadline - Date.now());
        timerEl.textContent = Math.ceil(left / 1000) + " c";
        if (left <= 0) finish("deny"); // таймаут → автозапрет (N4)
      }
      const tick = setInterval(renderTimer, 250);
      renderTimer();

      (document.documentElement || document.body).appendChild(host);
    });
  };
})();
