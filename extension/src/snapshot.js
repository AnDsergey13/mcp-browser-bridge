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
    return labelOf(el);
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
    dirty: false,
    mapUrl: location.href,

    markDirty() {
      this.dirty = true;
    },

    /** Полная инвалидация — только навигация. */
    checkNavigation() {
      if (location.href !== this.mapUrl) {
        this.map.clear();
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

    /** Перепоиск по css-пути + сигнатуре; принимаем только ровно одного кандидата. */
    refind(entry) {
      let nodes;
      try {
        nodes = document.querySelectorAll(entry.path);
      } catch (e) {
        return null;
      }
      let found = null;
      for (const n of nodes) {
        if (!this.matchesSignature(n, entry)) continue;
        if (found) return null; // кандидатов несколько — неоднозначно
        found = n;
      }
      return found;
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
      // Дедупликация: живой ref для того же элемента переиспользуется.
      for (const [r, entry] of this.map) {
        if (entry.el === el && el.isConnected) return r;
      }
      const r = "e" + ++this.counter;
      this.map.set(r, {
        el,
        tag: el.tagName.toLowerCase(),
        role: sigRole(el),
        text: sigText(el),
        path: cssPath(el),
      });
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

  function labelOf(el) {
    return clean(
      el.getAttribute("aria-label") ||
        el.innerText ||
        el.value ||
        el.placeholder ||
        el.title ||
        el.getAttribute("name") ||
        "",
      80
    );
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
      return `[${ref}] link "${labelOf(el)}" → ${el.getAttribute("href") || ""}`;
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
        return `[${ref}] ${type} "${labelOf(el)}" checked=${el.checked}`;
      }
      if (type === "button" || type === "submit" || type === "reset") {
        return `[${ref}] button "${labelOf(el) || clean(el.value, 60)}"`;
      }
      return `[${ref}] textbox${nameBit} placeholder="${clean(el.placeholder, 40)}" value="${clean(el.value, 60)}"`;
    }
    if (tag === "button" || role === "button") return `[${ref}] button "${labelOf(el)}"`;
    if (role === "link") return `[${ref}] link "${labelOf(el)}"`;
    if (role === "checkbox" || role === "switch" || role === "radio") {
      return `[${ref}] checkbox "${labelOf(el)}" checked=${el.getAttribute("aria-checked") === "true"}`;
    }
    if (tag === "summary") return `[${ref}] summary "${labelOf(el)}"`;
    if (el.isContentEditable) return `[${ref}] textbox${nameBit} "${labelOf(el)}"`;
    return `[${ref}] ${role || tag} "${labelOf(el)}"`;
  }

  // ---------- скоуп ----------
  function scopeRoot(params) {
    if (params.selector) return document.querySelector(params.selector);
    return document.querySelector("main, article") || document.body;
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
  function build(params) {
    params = params || {};
    const root = scopeRoot(params) || document.body;
    const noViewportFilter = params.scope === "full" || !!params.selector;
    const lines = [];
    let truncated = false;
    let count = 0;

    const nodes = root.querySelectorAll(INTERACTIVE_SEL + "," + HEADING_SEL);
    for (const el of nodes) {
      if (!isVisible(el) || isSkippable(el)) continue;
      if (!noViewportFilter && !inViewport(el)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if (count >= MAX_ELEMENTS) {
        truncated = true;
        break;
      }
      if (el.matches(HEADING_SEL)) {
        const t = clean(el.innerText || el.textContent);
        if (t) lines.push("#".repeat(Number(el.tagName[1])) + " " + t);
        continue;
      }
      count++;
      lines.push(describe(el));
    }

    const text = compressedText(root);
    const snapshot =
      "url: " +
      location.href +
      "\ntitle: " +
      document.title +
      "\n" +
      lines.join("\n") +
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
    for (const el of document.querySelectorAll(INTERACTIVE_SEL)) {
      if (matches.length >= 20) break;
      if (!isVisible(el) || isSkippable(el)) continue;
      const role = (el.getAttribute("role") || implicitRole(el)).toLowerCase();
      if (roleFilter && role !== roleFilter) continue;
      const text = labelOf(el);
      if (text.toLowerCase().includes(query)) {
        matches.push({ ref: refs.assign(el), text: clean(text, 120) });
      }
    }
    return matches;
  }

  // ---------- extractMarkdown ----------
  const STRIP_SEL = "script,style,noscript,nav,footer,aside,form,iframe,svg";

  function extractMarkdown(params) {
    params = params || {};
    const src =
      (params.selector && document.querySelector(params.selector)) ||
      document.querySelector("main, article") ||
      document.body;

    // Манифест картинок — без URL (скачивание по номеру манифеста).
    const images = [];
    let n = 0;
    src.querySelectorAll("img").forEach((img) => {
      if (!isVisible(img)) return;
      images.push({
        n: ++n,
        alt: clean(img.getAttribute("alt") || "", 80),
        w: img.naturalWidth || img.width || 0,
        h: img.naturalHeight || img.height || 0,
      });
    });

    const clone = src.cloneNode(true);
    clone.querySelectorAll(STRIP_SEL).forEach((x) => x.remove());
    const out = [];
    walkMd(clone, out);
    const markdown = out
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    return { markdown, images };
  }

  function walkMd(node, out) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const t = clean(child.textContent);
        if (t) out.push(t);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const t = clean(child.textContent);
        if (t) out.push("\n\n" + "#".repeat(Number(tag[1])) + " " + t + "\n\n");
      } else if (tag === "p") {
        const buf = [];
        walkMd(child, buf);
        const t = buf.join("").trim();
        if (t) out.push("\n\n" + t + "\n\n");
      } else if (tag === "li") {
        const buf = [];
        walkMd(child, buf);
        const t = buf.join("").trim();
        if (t) out.push("\n- " + t);
      } else if (tag === "br") {
        out.push("\n");
      } else if (tag === "a") {
        const t = clean(child.textContent);
        const href = child.getAttribute("href");
        if (t && href) out.push("[" + t + "](" + href + ")");
        else if (t) out.push(t);
      } else if (tag === "strong" || tag === "b") {
        const t = clean(child.textContent);
        if (t) out.push("**" + t + "**");
      } else if (tag === "em" || tag === "i") {
        const t = clean(child.textContent);
        if (t) out.push("*" + t + "*");
      } else {
        walkMd(child, out);
      }
    }
  }

  B.snapshot = { build, findText, extractMarkdown };
})();
