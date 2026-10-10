"use strict";

/**
 * snapshot.js — семантический снапшот страницы (PROTOCOL.md §9),
 * extractMarkdown и findText. Внешних зависимостей нет.
 * Экспортирует в общий namespace контент-скриптов window.__BRIDGE__:
 *   B.refs     — карта ref→запись {el, tag, role, text, path} (N8: точечная
 *                ревалидация; глобальная инвалидация только при навигации);
 *   B.snapshot = { build, findText, extractMarkdown }.
 */
(() => {
  const B = (window.__BRIDGE__ = window.__BRIDGE__ || {});

  // ---------- сигнатура элемента и css-путь ----------
  // Текст сигнатуры: для полей формы value/innerText НЕ берём — value меняется
  // при вводе (type) без DOM-мутаций и не должен убивать ref.
  function sigText(el) {
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return clean(
        el.getAttribute("aria-label") || el.placeholder || el.title || el.getAttribute("name") || "",
        80
      );
    }
    return labelBits(el).text;
  }

  function sigRole(el) {
    return (el.getAttribute("role") || implicitRole(el)).toLowerCase();
  }

  // Компактный css-путь для перепоиска: tag#id / tag.class.class / :nth-of-type.
  function cssPath(el) {
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 8) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(part + "#" + CSS.escape(cur.id));
        break; // id достаточно уникален — выше не поднимаемся
      }
      const cls = (cur.getAttribute("class") || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);
      if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(
          parent.children,
          (c) => c.tagName === cur.tagName
        );
        if (sameTag.length > 1) part += ":nth-of-type(" + (sameTag.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      if (cur === document.body) break;
      cur = parent;
      depth++;
    }
    return parts.join(">");
  }

  // ---------- ref-реестр (eN → запись) ----------
  // Счётчик монотонный: старый eN никогда не переиспользуется для другого
  // элемента → мёртвый ref даёт STALE_REF, а не клик «мимо».
  // Мутации DOM НЕ стирают карту — только ставят dirty (markDirty из
  // content-bridge.js); команда по ref на dirty-странице ревалидирует
  // ИМЕННО эту запись. Полная инвалидация — только при смене URL (навигация,
  // включая SPA history-навигацию).
  const refs = {
    counter: 0,
    map: new Map(),
    byEl: new WeakMap(), // Element → ref: O(1) дедуп в assign (П1-4)
    dirty: false,
    mapUrl: location.href,

    markDirty() {
      this.dirty = true;
    },

    /** Полная инвалидация — только навигация. */
    checkNavigation() {
      if (location.href !== this.mapUrl) {
        this.map.clear();
        this.byEl = new WeakMap();
        this.mapUrl = location.href;
        this.dirty = false;
      }
    },

    matchesSignature(el, entry) {
      return (
        el.tagName.toLowerCase() === entry.tag &&
        sigRole(el) === entry.role &&
        sigText(el) === entry.text
      );
    },

    /**
     * Перепоиск по css-пути + сигнатуре. Несколько кандидатов — НЕ ошибка
     * (AMBIGUOUS существует только для click-by-text); tie-breaking:
     *  (а) точное совпадение пересчитанного css-пути;
     *  (б) самый глубокий узел (чаще всего цель — <li> внутри <ul> с тем же текстом);
     *  (в) по-прежнему >1 — null (→ STALE_REF).
     */
    refind(entry) {
      let nodes;
      try {
        nodes = document.querySelectorAll(entry.path);
      } catch (e) {
        return null;
      }
      const candidates = [];
      for (const n of nodes) {
        if (this.matchesSignature(n, entry)) candidates.push(n);
      }
      if (candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0];
      // (а) точное совпадение пути
      const exactPath = candidates.filter((n) => cssPath(n) === entry.path);
      if (exactPath.length === 1) return exactPath[0];
      const pool = exactPath.length > 1 ? exactPath : candidates;
      // (б) самый глубокий узел
      let best = null;
      let bestDepth = -1;
      let tie = false;
      for (const n of pool) {
        let d = 0;
        for (let c = n; c && c.parentElement; c = c.parentElement) d++;
        if (d > bestDepth) {
          best = n;
          bestDepth = d;
          tie = false;
        } else if (d === bestDepth) {
          tie = true;
        }
      }
      // (в) неоднозначно — честный STALE_REF
      return tie ? null : best;
    },

    resolve(ref) {
      this.checkNavigation();
      const entry = this.map.get(ref);
      if (!entry) return null;
      const el = entry.el;
      if (!this.dirty) {
        return el && el.isConnected ? el : null;
      }
      // Точечная ревалидация (N8): элемент на месте и сигнатура совпала.
      if (el && el.isConnected && this.matchesSignature(el, entry)) {
        return el;
      }
      // Перерисовка (SPA): пробуем перенайти по css-пути + тексту.
      const found = this.refind(entry);
      if (found) {
        entry.el = found;
        entry.path = cssPath(found);
        return found;
      }
      return null;
    },

    assign(el) {
      this.checkNavigation();
      // Дедупликация: живой ref для того же элемента переиспользуется (O(1)).
      const known = this.byEl.get(el);
      if (known && el.isConnected) {
        const entry = this.map.get(known);
        if (entry && entry.el === el) return known;
      }
      const r = "e" + ++this.counter;
      this.map.set(r, {
        el,
        tag: el.tagName.toLowerCase(),
        role: sigRole(el),
        text: sigText(el),
        path: cssPath(el),
      });
      this.byEl.set(el, r);
      return r;
    },
  };
  B.refs = refs;

  // ---------- селекторы ----------
  const INTERACTIVE_SEL = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="option"]',
    '[role="slider"]',
    "[contenteditable]",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  const HEADING_SEL = "h1,h2,h3";
  const MAX_ELEMENTS = 300; // страховочный лимит снапшота
  const TEXT_LIMIT = 1500; // лимит сжатого видимого текста

  // ---------- утилиты ----------
  function clean(s, max) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return max && s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    if (!el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return (
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < (window.innerHeight || 0) &&
      r.left < (window.innerWidth || 0)
    );
  }

  function isSkippable(el) {
    return el.tagName === "INPUT" && (el.type || "").toLowerCase() === "hidden";
  }

  // ---------- Д2: метки элементов (visible-first) ----------
  // Приоритет ВИДИМОГО текста; aria-label/title/name — с маркером источника.
  // При расхождении видимого и aria показываем оба: "видимое" + [aria: "…"] —
  // подмена (человек видит одно, assistive-дерево другое) становится явной.
  function visibleTextOf(el) {
    const it = el.innerText;
    if (it && it.trim()) return it; // у input/textarea innerText пуст — ниже
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? n.innerText || n.textContent || "" : "";
        })
        .join(" ");
      if (t.trim()) return t;
    }
    const img = el.querySelector && el.querySelector("img[alt]");
    if (img) return img.getAttribute("alt") || "";
    const svgT = el.querySelector && el.querySelector("svg title");
    if (svgT && svgT.textContent && svgT.textContent.trim()) return svgT.textContent;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const t = (el.type || "").toLowerCase();
      if (t === "checkbox" || t === "radio") {
        // value у чекбокса/радио — технический ("on"), не метка; видимая
        // подпись — связанный <label> (for= или обёртка), API .labels.
        const lab = el.labels && el.labels[0];
        return (lab && lab.innerText) || "";
      }
      return el.value || el.placeholder || "";
    }
    return "";
  }

  // В маркер глушим " и = — текст приходит со страницы и не должен ломать
  // quoted-формат строки или подделывать key=value биты (classifier.ts).
  function sanitizeMarker(s) {
    return s.replace(/"/g, "'").replace(/=/g, ":");
  }

  function labelBits(el) {
    const visible = clean(visibleTextOf(el), 80);
    const aria = clean(el.getAttribute("aria-label") || "", 80);
    if (aria && visible && aria !== visible) {
      return { text: visible, marker: ` [aria: "${sanitizeMarker(aria)}"]` };
    }
    if (aria && !visible) return { text: aria, marker: " [из aria-label]" };
    if (visible) return { text: visible, marker: "" };
    const title = clean(el.getAttribute("title") || "", 80);
    if (title) return { text: title, marker: " [из title]" };
    const name = clean(el.getAttribute("name") || "", 80);
    return { text: name, marker: name ? " [из name]" : "" };
  }

  // Фрагмент строки снапшота: "текст" + маркер ВНЕ кавычек — первый
  // quoted-литерал строки должен оставаться видимым текстом (classifier).
  function labelFrag(el) {
    const b = labelBits(el);
    return `"${b.text.replace(/"/g, "'")}"${b.marker}`;
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (t === "button" || t === "submit" || t === "reset") return "button";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return tag;
  }

  // ---------- строка описания интерактивного элемента ----------
  function describe(el) {
    const ref = refs.assign(el);
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const name = el.getAttribute("name");
    const nameBit = name ? " name=" + name : "";

    if (tag === "a") {
      return `[${ref}] link ${labelFrag(el)} → ${el.getAttribute("href") || ""}`;
    }
    if (tag === "select") {
      const opts = [];
      const total = el.options.length;
      for (let i = 0; i < Math.min(total, 10); i++) {
        opts.push('"' + clean(el.options[i].text, 30) + '"');
      }
      return `[${ref}] select${nameBit} [${opts.join(",")}]${total > 10 ? " …" : ""}`;
    }
    if (tag === "textarea") {
      return `[${ref}] textbox${nameBit} placeholder="${clean(el.placeholder, 40)}" value="${clean(el.value, 60)}"`;
    }
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return `[${ref}] ${type} ${labelFrag(el)} checked=${el.checked}`;
      }
      if (type === "button" || type === "submit" || type === "reset") {
        // Д4: type=submit в строке — classifier.ts ищет этот бит (gated submit).
        const tBit = type === "submit" ? " type=submit" : "";
        return `[${ref}] button ${labelFrag(el)}${tBit}`;
      }
      if (type === "password") {
        // Д4: бит type=password (classifier → login, mcp.ts маскирует журнал),
        // само значение в снапшот не попадает — только факт заполнения.
        return `[${ref}] textbox${nameBit} type=password placeholder="${clean(el.placeholder, 40)}" value="${el.value ? "***" : ""}"`;
      }
      return `[${ref}] textbox${nameBit} placeholder="${clean(el.placeholder, 40)}" value="${clean(el.value, 60)}"`;
    }
    if (tag === "button" || role === "button") {
      // Д4: <button> без type внутри <form> — неявный submit
      // (HTMLButtonElement.type по умолчанию "submit"); вне формы не помечаем.
      const submitBit =
        tag === "button" && el.type === "submit" && el.closest("form")
          ? " type=submit"
          : "";
      return `[${ref}] button ${labelFrag(el)}${submitBit}`;
    }
    if (role === "link") return `[${ref}] link ${labelFrag(el)}`;
    if (role === "checkbox" || role === "switch" || role === "radio") {
      return `[${ref}] checkbox ${labelFrag(el)} checked=${el.getAttribute("aria-checked") === "true"}`;
    }
    if (tag === "summary") return `[${ref}] summary ${labelFrag(el)}`;
    if (el.isContentEditable) return `[${ref}] textbox${nameBit} ${labelFrag(el)}`;
    return `[${ref}] ${role || tag} ${labelFrag(el)}`;
  }

  // ---------- скоуп ----------
  function scopeRoot(params) {
    if (params.selector) return document.querySelector(params.selector);
    return document.querySelector("main, article") || document.body;
  }

  // ---------- расширенная эвристика интерактивности ----------
  // Базовый INTERACTIVE_SEL (см. выше: роли option/menuitem/tab/switch/combobox
  // и др.) + [onclick] + li/span/div с вычисленным cursor:pointer.
  // getComputedStyle вызывается ЛЕНИВО: только для li/span/div без других
  // признаков, и только после проверки видимости.
  function isInteractiveEl(el) {
    if (el.matches(INTERACTIVE_SEL)) return true;
    if (el.hasAttribute("onclick")) return true;
    const tag = el.tagName;
    if (tag === "LI" || tag === "SPAN" || tag === "DIV") {
      return isVisible(el) && getComputedStyle(el).cursor === "pointer";
    }
    return false;
  }

  /** Обход интерактивных элементов root в порядке документа (без скоуп/видимость-фильтров). */
  function forEachInteractive(root, cb) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (isInteractiveEl(el)) cb(el);
    }
  }

  function compressedText(root) {
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll("script,style,noscript,svg,nav,header,footer,aside,form")
      .forEach((n) => n.remove());
    // На отсоединённом клоне innerText деградирует до textContent — нас устраивает.
    let text = clean(clone.textContent || "");
    if (text.length > TEXT_LIMIT) text = text.slice(0, TEXT_LIMIT) + "…";
    return text;
  }

  // ---------- семантический снапшот (§9) ----------
  // П1-5: ≥5 подряд идущих строк с одинаковой сигнатурой (роль + текст,
  // напр. 50 кнопок «Купить») сворачиваются в `[e12..e61] button "Купить" ×50`.
  // Свёртка только визуальная: refs выданы всем элементам, act.* по любому
  // ref из диапазона работает (сервер раскрывает диапазон в parseSnapshotRefs).
  // Сворачиваем только численно ПОСЛЕДОВАТЕЛЬНЫЕ refs — переиспользованный
  // старый ref ломал бы нотацию диапазона.
  function collapseRepeats(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const m = /^\[(e(\d+))\]\s(.*)$/.exec(lines[i]);
      if (!m) {
        out.push(lines[i]);
        i++;
        continue;
      }
      let j = i + 1;
      let prevNum = Number(m[2]);
      let consecutive = true;
      while (j < lines.length) {
        const m2 = /^\[(e(\d+))\]\s(.*)$/.exec(lines[j]);
        if (!m2 || m2[3] !== m[3]) break;
        if (Number(m2[2]) !== prevNum + 1) consecutive = false;
        prevNum = Number(m2[2]);
        j++;
      }
      if (j - i >= 5 && consecutive) {
        out.push("[" + m[1] + "..e" + prevNum + "] " + m[3] + " ×" + (j - i));
      } else {
        for (let k = i; k < j; k++) out.push(lines[k]);
      }
      i = j;
    }
    return out;
  }

  function build(params) {
    params = params || {};
    const root = scopeRoot(params) || document.body;
    const noViewportFilter = params.scope === "full" || !!params.selector;
    const lines = [];
    // П1-4б: хром страницы (меню/шапка/подвал) при дефолтном скоупе опускаем
    // В КОНЕЦ снапшота — контент идёт первым, но элементы остаются адресуемыми.
    // scope:"full" и явный selector — старое поведение (порядок документа).
    const deferred = [];
    let truncated = false;
    let count = 0;
    // П1-4а: эмитнутые cursor-pointer элементы → {idx, text} для дедупа цепочек.
    const pointerSeen = new Map();

    // Один проход в порядке документа: заголовки + интерактивные (база + расширенная эвристика).
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode())) {
      if (el.matches(HEADING_SEL)) {
        if (!isVisible(el)) continue;
        if (!noViewportFilter && !inViewport(el)) continue;
        const t = clean(el.innerText || el.textContent);
        if (t) lines.push("#".repeat(Number(el.tagName[1])) + " " + t);
        continue;
      }
      if (!isInteractiveEl(el)) continue;
      if (isSkippable(el) || !isVisible(el)) continue;
      if (!noViewportFilter && !inViewport(el)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if (count >= MAX_ELEMENTS) {
        truncated = true;
        break;
      }
      count++;

      // П1-4а: pointer-цепочка (div в div с cursor:pointer и тем же текстом) —
      // оставляем только НИЖНИЙ элемент: он ближе к тексту, клик надёжнее.
      const tag = el.tagName;
      const cursorOnly =
        (tag === "LI" || tag === "SPAN" || tag === "DIV") &&
        !el.matches(INTERACTIVE_SEL) &&
        !el.hasAttribute("onclick");
      if (cursorOnly) {
        const text = clean(el.innerText || "");
        for (let p = el.parentElement; p; p = p.parentElement) {
          const rec = pointerSeen.get(p);
          if (rec && rec.text === text) {
            lines[rec.idx] = null; // предок-дубль с тем же текстом
            pointerSeen.delete(p);
          }
        }
        const idx = lines.length;
        lines.push(describe(el));
        pointerSeen.set(el, { idx, text });
        continue;
      }

      const line = describe(el);
      if (!noViewportFilter && el.closest("header,nav,footer,aside")) deferred.push(line);
      else lines.push(line);
    }

    const body = collapseRepeats(lines.filter(Boolean).concat(deferred));
    const text = compressedText(root);
    const snapshot =
      "url: " +
      location.href +
      "\ntitle: " +
      document.title +
      "\n" +
      body.join("\n") +
      (text ? "\n" + text : "");
    // Свежий снапшот = свежий взгляд на DOM: снимаем dirty, записи актуальны.
    refs.dirty = false;
    return { snapshot, truncated };
  }

  // ---------- findText ----------
  function findText(params) {
    params = params || {};
    const query = String(params.query || "").toLowerCase();
    const roleFilter = String(params.role || "").toLowerCase();
    const matches = [];
    if (!query) return matches;
    forEachInteractive(document.body, (el) => {
      if (matches.length >= 20) return;
      if (!isVisible(el) || isSkippable(el)) return;
      const role = (el.getAttribute("role") || implicitRole(el)).toLowerCase();
      if (roleFilter && role !== roleFilter) return;
      const text = labelBits(el).text;
      if (text.toLowerCase().includes(query)) {
        matches.push({ ref: refs.assign(el), text: clean(text, 120) });
      }
    });
    return matches;
  }

  // ---------- поиск кликабельного по тексту (act.click {text}) ----------
  // Точное совпадение → prefix → substring. Ровно один лучший — ok;
  // 0 → {status:"none", texts: ближайшие}; >1 равнозначных → {status:"many"}.
  function findByText(query) {
    const q = clean(query).toLowerCase();
    if (!q) return { status: "none", texts: [] };
    const firstToken = q.split(/\s+/)[0];
    const exact = [];
    const prefix = [];
    const partial = [];
    const near = [];
    forEachInteractive(document.body, (el) => {
      if (!isVisible(el) || isSkippable(el)) return;
      const t = clean(labelBits(el).text);
      if (!t) return;
      const lt = t.toLowerCase();
      if (near.length < 5 && lt.indexOf(firstToken) !== -1) near.push(t.slice(0, 60));
      if (lt === q) exact.push({ el, t });
      else if (lt.startsWith(q)) prefix.push({ el, t });
      else if (lt.indexOf(q) !== -1) partial.push({ el, t });
    });
    const best = exact.length ? exact : prefix.length ? prefix : partial;
    if (best.length === 1) return { status: "one", el: best[0].el };
    if (best.length > 1) {
      return { status: "many", texts: best.slice(0, 5).map((c) => c.t.slice(0, 60)) };
    }
    return { status: "none", texts: near };
  }

  /** Число видимых интерактивных текущего скоупа — детектор появления автокомплита. */
  function countInteractive() {
    const root = scopeRoot({}) || document.body;
    let n = 0;
    forEachInteractive(root, (el) => {
      if (isSkippable(el) || !isVisible(el) || !inViewport(el)) return;
      n++;
    });
    return n;
  }

  // ---------- компактный after-блок для act.* ----------
  // Строки в формате снапшота для текущего скоупа (main|article ∩ viewport),
  // мягкий лимит ~2KB. ref-метки реальные: assign() — ими можно сразу пользоваться.
  // pivot — элемент, с которым работала команда: интерактивные сортируются по
  // ВИЗУАЛЬНОЙ близости к нему (центры rect'ов), чтобы реакция на действие
  // (автокомплит, раскрывшийся блок) попадала в лимит первой. Визуальная, а
  // не DOM-близость: выпадающие списки часто монтируются в конец <body> и по
  // порядку документа далеки от поля ввода, хотя рисуются рядом с ним.
  const AFTER_LIMIT = 2048;

  function afterBlock(pivot) {
    const root = scopeRoot({}) || document.body;
    const entries = [];
    forEachInteractive(root, (el) => {
      if (isSkippable(el) || !isVisible(el) || !inViewport(el)) return;
      if (el.closest('[aria-hidden="true"]')) return;
      entries.push({ el, line: describe(el) });
    });
    if (pivot && pivot.getBoundingClientRect && entries.length > 1) {
      const pr = pivot.getBoundingClientRect();
      const px = pr.left + pr.width / 2;
      const py = pr.top + pr.height / 2;
      const dist2 = (el) => {
        const r = el.getBoundingClientRect();
        const dx = r.left + r.width / 2 - px;
        const dy = r.top + r.height / 2 - py;
        return dx * dx + dy * dy;
      };
      entries.sort((a, b) => dist2(a.el) - dist2(b.el));
    }
    const lines = [];
    let size = 0;
    let truncated = false;
    for (const { line } of entries) {
      if (size + line.length + 1 > AFTER_LIMIT) {
        truncated = true;
        break;
      }
      lines.push(line);
      size += line.length + 1;
    }
    if (!lines.length) return {};
    refs.dirty = false; // after — мини-снапшот: записи актуальны
    const out = { after: lines.join("\n") };
    if (truncated) out.after_truncated = true;
    return out;
  }

  // ---------- extractMarkdown ----------
  const STRIP_SEL = "script,style,noscript,nav,footer,aside,form,svg";
  const MD_MAX_CHARS = 15000; // П2-1: лимит ДО серверного capResponse (резка по абзацу)

  // Детектор div-супа (П2-1): семантических блоков мало при большом тексте.
  function isDivSoup(root) {
    const textLen = (root.textContent || "").replace(/\s+/g, "").length;
    if (textLen <= 2000) return false;
    return root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li").length < 10;
  }

  // Доля текста внутри <a>: у меню/футеров/related-ссылок высокая, у контента низкая.
  function linkDensityOf(el) {
    const textLen = (el.textContent || "").replace(/\s+/g, " ").trim().length;
    if (!textLen) return 0;
    let linkLen = 0;
    el.querySelectorAll("a").forEach((a) => {
      linkLen += (a.textContent || "").length;
    });
    return linkLen / textLen;
  }

  /**
   * Density-режим (П2-1, свои эвристики, без внешних библиотек): выбираем
   * самый «текстовый» контейнер (score = длина текста × (1 − link-density)),
   * поднимаемся к верхнему хорошему предку, чтобы захватить соседние абзацы.
   */
  function pickDensityContainer(root) {
    let best = null;
    let bestScore = 0;
    root.querySelectorAll("div,section,article,main").forEach((b) => {
      const textLen = (b.textContent || "").replace(/\s+/g, " ").trim().length;
      if (textLen < 200) return;
      const ld = linkDensityOf(b);
      if (ld > 0.5) return; // меню/список ссылок — не контент
      const score = textLen * (1 - ld);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    });
    if (!best) return null;
    let cur = best;
    while (cur.parentElement && cur.parentElement !== root) {
      const p = cur.parentElement;
      const textLen = (p.textContent || "").replace(/\s+/g, " ").trim().length;
      const ld = linkDensityOf(p);
      if (textLen < 200 || ld > 0.5) break;
      if (textLen * (1 - ld) < bestScore * 0.75) break;
      cur = p;
    }
    return cur;
  }

  function extractMarkdown(params) {
    params = params || {};
    // П2-2: images — "inline" (по умолчанию, контракт localize-page.py),
    // "manifest" (только манифест, без инлайна в тексте), "off" (чистое чтение).
    const imagesMode = params.images || "inline";
    const maxChars = Number(params.max_chars) > 0 ? Number(params.max_chars) : MD_MAX_CHARS;
    const src =
      (params.selector && document.querySelector(params.selector)) ||
      document.querySelector("main, article") ||
      document.body;

    // Манифест картинок: src нужен для скачивания (file.download) по номеру n.
    // Инлайн data: URI не тащим — только пометка.
    const images = [];
    // Видимость проверяем ДО клонирования: клон отсоединён от DOM,
    // getClientRects() на нём пуст, isVisible внутри walkMd бесполезен.
    const visibleImgs = new Set();
    if (imagesMode !== "off") {
      let n = 0;
      src.querySelectorAll("img").forEach((img) => {
        if (!isVisible(img)) return;
        visibleImgs.add(img);
        let srcUrl = img.currentSrc || img.src || "";
        if (srcUrl.startsWith("data:")) srcUrl = "data:(inline)";
        images.push({
          n: ++n,
          src: clean(srcUrl, 1000),
          alt: clean(img.getAttribute("alt") || "", 80),
          w: img.naturalWidth || img.width || 0,
          h: img.naturalHeight || img.height || 0,
        });
      });
    }

    // Маркировка видимых img — НА ОРИГИНАЛЕ до клонирования (П2-1): клон
    // унаследует атрибут, хрупкая индексная синхронизация img[i] не нужна.
    // Атрибут временный: сразу после клонирования снимаем его с оригинала.
    if (imagesMode === "inline") {
      visibleImgs.forEach((img) => img.setAttribute("data-bridge-visible", "1"));
    }
    const clone = src.cloneNode(true);
    if (imagesMode === "inline") {
      visibleImgs.forEach((img) => img.removeAttribute("data-bridge-visible"));
    }
    clone.querySelectorAll(STRIP_SEL).forEach((x) => x.remove());

    const opts = { density: false, inlineImages: imagesMode === "inline" };
    let target = clone;
    if (isDivSoup(clone)) {
      const container = pickDensityContainer(clone);
      if (container) {
        opts.density = true;
        target = container;
      }
    }
    const out = [];
    walkMd(target, out, opts);
    let markdown = out
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    // Лимит по границе абзаца (лучше, чем обрубок строки серверным резаком).
    if (markdown.length > maxChars) {
      const boundary = markdown.lastIndexOf("\n\n", maxChars);
      markdown =
        markdown.slice(0, boundary > maxChars / 2 ? boundary : maxChars) +
        "\n\n… [обрезано по max_chars]";
    }
    return { markdown, images };
  }

  function pushFrag(out, s) {
    if (!s) return;
    // Склейка соседних инлайн-фрагментов: <strong>/<a> внутри фразы рвут
    // текст на узлы — граница узлов почти всегда граница слов, поэтому
    // по умолчанию вставляем пробел. Не вставляем после открывающей скобки
    // и перед закрывающей пунктуацией/скобкой.
    const last = out.length ? out[out.length - 1] : "";
    const lastC = last.replace(/\s+$/, "").slice(-1);
    const headC = s.replace(/^[*_`\[\]]+/, "").charAt(0);
    if (lastC && !/\s$/.test(last) && !"([/".includes(lastC) &&
        !/^[,.!?;:%\]\)}]/.test(headC)) {
      out.push(" ");
    }
    out.push(s);
  }

  function walkMd(node, out, opts) {
    opts = opts || {};
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        pushFrag(out, clean(child.textContent));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "button") continue; // UI-кнопки ("Enable fullscreen") — не контент
      if (/^h[1-6]$/.test(tag)) {
        const t = clean(child.textContent);
        if (t) out.push("\n\n" + "#".repeat(Number(tag[1])) + " " + t + "\n\n");
      } else if (tag === "p") {
        const buf = [];
        walkMd(child, buf, opts);
        const t = buf.join("").trim();
        if (t) out.push("\n\n" + t + "\n\n");
      } else if (opts.density && (tag === "div" || tag === "section" || tag === "article")) {
        // П2-1 density-режим: текстовые div склеиваем в абзацы; блоки-«хвосты»
        // (футеры, related-ссылки, link-density > 0.5) отсекаем.
        if (linkDensityOf(child) > 0.5) continue;
        const buf = [];
        walkMd(child, buf, opts);
        const t = buf.join("").trim();
        if (t) out.push("\n\n" + t + "\n\n");
      } else if (tag === "li") {
        const buf = [];
        walkMd(child, buf, opts);
        const t = buf.join("").trim();
        if (t) out.push("\n- " + t);
      } else if (tag === "br") {
        out.push("\n");
      } else if (tag === "a") {
        // img внутри ссылки: ссылка-обёртка не нужна, важна сама картинка.
        const imgOnly = child.querySelector("img") && !clean(child.textContent);
        if (imgOnly) {
          walkMd(child, out, opts);
          continue;
        }
        const t = clean(child.textContent);
        const href = child.getAttribute("href");
        if (t && href) pushFrag(out, "[" + t + "](" + href + ")");
        else if (t) pushFrag(out, t);
      } else if (tag === "img") {
        // Картинка инлайн — на своём месте в тексте (скачивается по src,
        // локализация путей — на стороне агента/скриптов). Видимость помечена
        // на оригинале до клонирования (data-bridge-visible унаследован клоном).
        // images:"manifest"/"off" — без инлайна в тексте (П2-2).
        if (!opts.inlineImages) continue;
        const srcUrl = child.currentSrc || child.src || "";
        if (srcUrl && !srcUrl.startsWith("data:") &&
            child.hasAttribute("data-bridge-visible")) {
          const alt = clean(child.getAttribute("alt") || "", 80);
          out.push("\n\n![" + alt + "](" + srcUrl + ")\n\n");
        }
      } else if (tag === "iframe") {
        // Встраиваемый плеер/виджет: оставляем маркер с URL — видео-скрипты
        // находят поток по net.list и подменяют маркер локальным файлом.
        const srcUrl = child.getAttribute("src") || "";
        if (srcUrl) out.push("\n\n[embedded: " + srcUrl + "]\n\n");
      } else if (tag === "video" || tag === "audio") {
        const srcUrl = child.currentSrc || child.src || "";
        if (srcUrl && !srcUrl.startsWith("blob:")) {
          out.push("\n\n[" + tag + ": " + srcUrl + "]\n\n");
        }
      } else if (tag === "strong" || tag === "b") {
        const t = clean(child.textContent);
        if (t) pushFrag(out, "**" + t + "**");
      } else if (tag === "em" || tag === "i") {
        const t = clean(child.textContent);
        if (t) pushFrag(out, "*" + t + "*");
      } else {
        walkMd(child, out, opts);
      }
    }
  }

  // ---------- scan: автоскролл ленты с агрегацией (П2-3) ----------
  // Каждый экран: сбор интерактивных viewport'а → дедуп по сигнатуре (строка
  // без ref-префикса) → скролл. Стоп: 3 экрана без новых уникальных ИЛИ упор
  // в низ ленты, лимиты: max_screens (≤20) и 45 с (страховка от «бесконечных»
  // лент). refs живые (та же страница) — адресуемы сразу.
  const SCAN_LINE_REF = /^\[(e\d+)\]\s(.*)$/;
  const SCAN_LIMIT = 12000; // символов агрегата (до серверного capResponse)

  async function scan(params) {
    params = params || {};
    const maxScreens = Math.min(Math.max(Number(params.max_screens) || 10, 1), 20);
    const deadline = Date.now() + 45000;
    const step = Math.max(300, Math.round((window.innerHeight || 800) * 0.9));
    const seen = new Set();
    const lines = [];
    let size = 0;
    let truncated = false;
    let stableRounds = 0;
    let screens = 0;
    let lastScrollY = -1;

    while (screens < maxScreens && stableRounds < 3 && Date.now() < deadline) {
      screens++;
      let added = 0;
      const root = scopeRoot({}) || document.body;
      forEachInteractive(root, (el) => {
        if (isSkippable(el) || !isVisible(el) || !inViewport(el)) return;
        if (el.closest('[aria-hidden="true"]')) return;
        const line = describe(el); // assign живого ref
        const m = SCAN_LINE_REF.exec(line);
        const sig = m ? m[2] : line;
        if (seen.has(sig)) return;
        seen.add(sig);
        if (size + line.length + 1 > SCAN_LIMIT) {
          truncated = true;
          return;
        }
        lines.push(line);
        size += line.length + 1;
        added++;
      });
      if (truncated) break;
      const y = window.scrollY;
      if (added === 0 || y === lastScrollY) stableRounds++;
      else stableRounds = 0;
      lastScrollY = y;
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 400)); // человеческий темп + догрузка ленты
    }
    refs.dirty = false; // scan — по сути серия мини-снапшотов, записи актуальны
    const out = { scan: lines.join("\n"), screens, unique: lines.length };
    if (truncated) out.scan_truncated = true;
    return out;
  }

  B.snapshot = { build, findText, findByText, afterBlock, countInteractive, extractMarkdown, isInteractiveEl, scan };
})();
