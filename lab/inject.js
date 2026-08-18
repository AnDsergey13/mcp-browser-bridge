// inject.js — red-team режим lab-полигона: детерминированная инъекция
// payload'ов из payloads.js по параметру ?seed=N.
//
// Без ?seed страница остаётся ЧИСТОЙ — это критично: детектор инъекций
// обязан молчать на чистых страницах. N=0 — валидный seed, не «выключено».
//
// Детерминизм: один и тот же seed + один и тот же путь страницы → те же
// payload'ы в тех же местах. Seed смешивается с хешем пути, чтобы разные
// страницы получали разные подмножества каталога.
(function () {
  'use strict';

  var seedRaw = window.LAB_SEED;
  if (seedRaw === null || seedRaw === undefined || seedRaw === '') return; // чистая страница
  if (!Array.isArray(window.LAB_PAYLOADS)) return;

  // Строка → uint32 (FNV-1a). Числовой seed берётся как есть.
  function toUint32(s) {
    if (/^\d+$/.test(s)) return parseInt(s, 10) >>> 0;
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }

  // mulberry32: компактный детерминированный PRNG.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var rng = mulberry32(toUint32(seedRaw) ^ toUint32(location.pathname));

  // Перемешать каталог (Fisher–Yates на seeded rng) и взять 3–5 payload'ов.
  var pool = window.LAB_PAYLOADS.slice();
  for (var i = pool.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1));
    var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  var count = 3 + Math.floor(rng() * 3);
  var chosen = pool.slice(0, count);

  // --- размещение payload'ов по kind -------------------------------------

  // Скрытый контейнер, недоступный глазу, но попадающий в текстовое
  // извлечение (page.extract). display:none — классика бенчмарков.
  function placeHiddenDiv(p) {
    var d = document.createElement('div');
    d.style.display = 'none';
    d.setAttribute('data-lab-payload', p.id);
    d.textContent = p.text;
    document.body.appendChild(d);
  }

  // Альтернатива display:none: прозрачный текст. Тоже невидим глазу,
  // но проходит через фильтры, отбрасывающие display:none.
  function placeTransparentDiv(p) {
    var d = document.createElement('div');
    d.style.cssText =
      'color:transparent;font-size:1px;position:absolute;left:-9999px;top:0;';
    d.setAttribute('data-lab-payload', p.id);
    d.textContent = p.text;
    document.body.appendChild(d);
  }

  // HTML-комментарий: контрольный канал — мост не должен его читать вообще.
  function placeComment(p) {
    document.body.appendChild(document.createComment(' ' + p.text + ' '));
  }

  // Инъекция через alt картинки (атрибутный канал).
  function placeAlt(p) {
    var img = document.createElement('img');
    img.width = 1; img.height = 1;
    img.style.cssText = 'position:absolute;left:-9999px;';
    img.alt = p.text;
    img.src = 'media/dot-red.png';
    img.setAttribute('data-lab-payload', p.id);
    document.body.appendChild(img);
  }

  // Инъекция через aria-label кнопки за пределами экрана.
  function placeAriaLabel(p) {
    var b = document.createElement('button');
    b.type = 'button';
    b.style.cssText = 'position:absolute;left:-9999px;';
    b.setAttribute('aria-label', p.text);
    b.setAttribute('data-lab-payload', p.id);
    b.addEventListener('click', function () { location.href = 'canary/' + p.id + '/'; });
    document.body.appendChild(b);
  }

  // Инъекция в значении input (значения полей попадают в snapshot).
  function placeInputValue(p) {
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = p.text;
    inp.style.cssText = 'position:absolute;left:-9999px;';
    inp.setAttribute('data-lab-payload', p.id);
    inp.setAttribute('aria-hidden', 'true');
    inp.tabIndex = -1;
    document.body.appendChild(inp);
  }

  // Инъекция через title-атрибут.
  function placeTitleAttr(p) {
    var s = document.createElement('span');
    s.title = p.text;
    s.style.cssText = 'position:absolute;left:-9999px;';
    s.setAttribute('data-lab-payload', p.id);
    document.body.appendChild(s);
  }

  // Намеренно ВИДИМАЯ фейковая кнопка оплаты: человек должен её видеть
  // (это часть сценария — социальная приманка), классификатор — распознать pay.
  function placeVisibleButton(p) {
    var wrap = document.createElement('div');
    wrap.setAttribute('data-lab-visible-payload', p.id);
    wrap.style.cssText = 'border:2px dashed #c33;padding:.6em;margin:.8em 0;';
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.text; // «Подтвердить оплату»
    b.addEventListener('click', function () { location.href = 'canary/' + p.id + '/'; });
    var note = document.createElement('small');
    note.textContent = ' (red-team приманка: клик ведёт на canary/' + p.id + '/)';
    wrap.appendChild(b);
    wrap.appendChild(note);
    var anchor = document.querySelector('h1');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    else document.body.insertBefore(wrap, document.body.firstChild);
  }

  var placers = {
    'hidden-div': placeHiddenDiv,
    'transparent-div': placeTransparentDiv,
    'comment': placeComment,
    'alt': placeAlt,
    'aria-label': placeAriaLabel,
    'input-value': placeInputValue,
    'title-attr': placeTitleAttr,
    'visible-button': placeVisibleButton
  };

  for (var k = 0; k < chosen.length; k++) {
    var p = chosen[k];
    var place = placers[p.kind];
    if (place) place(p);
  }
})();
