"use strict";

/**
 * consent-banner.js — баннер подтверждения gated-действий (N4) и баннер
 * download-гранта (П2-5, params.grant === true: домен ФАЙЛА, allow выдаёт
 * session-грант, кнопки «10 мин» нет).
 * Режим page.eval (Е, category:"eval" + params.expression): description первым,
 * затем title/URL вкладки-цели, затем ПОЛНЫЙ expression блоком кода с
 * прокруткой и кнопкой «Копировать». Без этих полей (старый сервер) — прежний вид.
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
    .tabline { margin: 0 0 8px; color: #9fb4cc; font-size: 13px; word-break: break-all; }
    .codebar {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; margin: 0 0 4px; color: #9fb4cc; font-size: 12px;
    }
    .code {
      margin: 0 0 12px; padding: 8px 10px; max-height: 240px; overflow: auto;
      background: #0d1117; border: 1px solid #334155; border-radius: 7px;
      font: 12px/1.4 ui-monospace, Consolas, monospace;
      white-space: pre-wrap; word-break: break-word; color: #d7e3f0;
    }
    .copy { padding: 3px 10px; font-size: 12px; background: #245073; color: #cfe4f7; border-color: #3b6e99; }
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

  // Копирование expression в буфер (Е): navigator.clipboard (secure context),
  // fallback — скрытый textarea + execCommand("copy") для небезопасных origins.
  function copyExpression(text, btn) {
    const done = (ok) => {
      btn.textContent = ok ? "Скопировано" : "Не удалось";
      setTimeout(() => { btn.textContent = "Копировать"; }, 1500);
    };
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { /* ignore */ }
      ta.remove();
      done(ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), fallback);
    } else fallback();
  }

  /**
   * @param {{category:string, domain:string, description:string, timeout_ms:number, grant?:boolean, expression?:string, title?:string, url?:string}} params
   * @returns {Promise<{decision:"allow"|"deny"|"allow_10min"}>}
   */
  B.showConsent = function showConsent(params) {
    return new Promise((resolve) => {
      // Один баннер за раз. П.1: прежний запрос ДОСРОЧНО завершаем deny —
      // раньше prev.remove() оставлял его промис висеть до таймаута, а сервер
      // ждал ответа. reason "replaced" — не «click», deny-кэш не отравляется.
      if (B.__activeConsent) B.__activeConsent.cancel();
      const prev = document.getElementById(HOST_ID);
      if (prev) prev.remove(); // страховка: host от копии скрипта без тикета

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

      // Е: баннер page.eval — description уже выше (первым), ниже добавляем
      // title/URL вкладки-цели и ПОЛНЫЙ expression блоком кода с прокруткой
      // (скрипт может быть больше экрана) + кнопку «Копировать». Поля
      // expression/title/url появились у сервера вместе с обязательным
      // description — старый сервер их не шлёт, баннер остаётся прежним.
      if (params && params.category === "eval" && typeof params.expression === "string" && params.expression) {
        const rowEl = wrap.querySelector(".row");
        if (params.title || params.url) {
          const tabline = document.createElement("div");
          tabline.className = "tabline";
          tabline.textContent = "Вкладка: " + (params.title || "—") + " — " + (params.url || "—");
          rowEl.before(tabline);
        }
        const codebar = document.createElement("div");
        codebar.className = "codebar";
        const codelabel = document.createElement("span");
        codelabel.textContent = "Скрипт целиком:";
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "copy";
        copyBtn.textContent = "Копировать";
        copyBtn.addEventListener("click", () => copyExpression(params.expression, copyBtn));
        codebar.append(codelabel, copyBtn);
        const code = document.createElement("pre");
        code.className = "code";
        code.textContent = params.expression; // только textContent: приходит по сети
        rowEl.before(codebar, code);
      }

      // П2-5: режим download-гранта (grant.ask): domain — домен ФАЙЛА, allow
      // выдаёт session-грант (подпись явно об этом); кнопка «10 мин» скрыта —
      // кэш allow_10min работает для gated-категорий, а не для грантов домену.
      if (params && params.grant === true) {
        wrap.querySelector(".allow").textContent = "Разрешить скачивание (на сессию)";
        const allow10 = wrap.querySelector(".allow10");
        if (allow10) allow10.remove();
      }

      let settled = false;
      // П.3: reason — «click» (явное решение пользователя) или «timeout»
      // (баннер сам закрылся по дедлайну). Сервер кэширует deny только при
      // явном клике: по таймауту пользователь мог баннер не видеть.
      function finish(decision, reason) {
        if (settled) return;
        settled = true;
        clearInterval(tick);
        observer.disconnect();
        if (B.__activeConsent === ticket) B.__activeConsent = null;
        host.remove();
        resolve({ decision, reason: reason || "click" });
      }
      // П.1: тикет активного баннера — следующий showConsent завершит этот досрочно.
      const ticket = { cancel: () => finish("deny", "replaced") };
      B.__activeConsent = ticket;

      wrap.querySelector(".allow").addEventListener("click", () => finish("allow", "click"));
      wrap.querySelector(".deny").addEventListener("click", () => finish("deny", "click"));
      // В grant-режиме (П2-5) кнопка «10 мин» удалена выше — слушатель только при наличии.
      const allow10Btn = wrap.querySelector(".allow10");
      if (allow10Btn) allow10Btn.addEventListener("click", () => finish("allow_10min", "click"));

      function renderTimer() {
        const left = Math.max(0, deadline - Date.now());
        timerEl.textContent = Math.ceil(left / 1000) + " c";
        if (left <= 0) finish("deny", "timeout"); // таймаут → автозапрет (N4), но без deny-кэша (П.3)
      }
      // П.1: SPA-перерисовка может выкинуть host из DOM — перевешиваем, пока
      // баннер не settled. Два плоских наблюдателя (host — прямой потомок
      // documentElement; body — страховка), subtree не нужен: дорого на
      // тяжёлых SPA. Счётчик — защита от страниц, зацикленно чистящих DOM.
      // document.open/write (новый documentElement) осознанно не обрабатываем.
      let reattachLeft = 10;
      const reattach = () => {
        if (settled || host.isConnected) return;
        if (reattachLeft-- <= 0) { observer.disconnect(); return; }
        (document.documentElement || document.body).appendChild(host);
      };
      const observer = new MutationObserver(reattach);
      if (document.documentElement) observer.observe(document.documentElement, { childList: true });
      if (document.body) observer.observe(document.body, { childList: true });

      const tick = setInterval(renderTimer, 250);
      renderTimer();

      (document.documentElement || document.body).appendChild(host);
    });
  };
})();
