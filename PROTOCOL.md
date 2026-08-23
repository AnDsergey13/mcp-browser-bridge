# Bridge Protocol v1 — контракт между bridge-server (контейнер) и extension (браузер)

Одна WS-строка = одно JSON-сообщение (текстовые фреймы). Порт: `18777`
(в контейнере слушает `0.0.0.0:18777`, снаружи публикуется на `127.0.0.1:18777`).

## 1. Конверты

```jsonc
// запрос (в обе стороны)
{"type":"req","id":"m_1","method":"...","params":{...}}
// ответ
{"type":"res","id":"m_1","result":{...}}
{"type":"res","id":"m_1","error":{"code":"SOME_CODE","message":"..."}}
// событие (в обе стороны, без id, без ответа)
{"type":"evt","event":"...","data":{...}}
```

`id` — уникальный в рамках соединения (`m_<n>` со стороны сервера, `e_<n>` со
стороны расширения). Таймаут ожидания `res` на `req` — 30 c, если иное не
указано у метода; по таймауту — ошибка `TIMEOUT`.

## 2. Сессия: handshake, подтверждение, policy push

1. ext → req `hello` `{secret, ext_version, browser, ua}`.
   - Неверный секрет → res error `AUTH_FAILED`, сервер закрывает сокет.
   - Верный → res `{status:"pending_approval", server_session_id, presets:["course",...]}`.
2. Сервер блокирует ВСЕ команды (ошибка `SESSION_NOT_APPROVED`), пока
   пользователь не подтвердит сессию в расширении (notification + кнопка в popup).
3. Подтвердил → ext → req `session.approve` `{}` → res `{status:"active"}` и
   следом сервер шлёт evt `policy.update` (см. ниже).
   Отклонил → ext → req `session.deny` `{}` → все команды → `SESSION_DENIED`.
4. evt `policy.update` (server→ext) — при approve и при каждом hot-reload
   policy.yaml / смене пресета / разовом гранте:

```jsonc
{"type":"evt","event":"policy.update","data":{
  "preset":"course",
  "match_patterns":["*://*.course.cpsdrone.com/*"],   // для register content scripts
  "domains":{                                          // resolved view для UI/логов
    "course.cpsdrone.com":{"capabilities":["read","interact","download"],
                           "gated":{"pay":"confirm","login":"confirm","submit":"confirm","delete":"confirm"}}
  },
  "gated_defaults":{"pay":"confirm","login":"confirm","submit":"confirm","delete":"confirm"},
  "version": 3                                          // монотонный счётчик
}}
```

Сервер — единственный источник политики и финальный арбитр каждой команды;
расширение использует policy только для регистрации content scripts и UI.

## 3. Поддержание соединения

- Сервер шлёт WS ping каждые 15 c; нет pong 45 c → соединение мёртво → состояние
  сервера `BROWSER_OFFLINE` (все MCP-инструменты сразу ошибкой `BROWSER_OFFLINE`).
- Очереди команд на дисконнекте НЕТ: незавершённые req → `BROWSER_OFFLINE`.
- Расширение переподключается с backoff: 1, 2, 4, … макс 30 c, бесконечно;
  после reconnect повторяет `hello`. Если server_session_id сменился — сессия
  снова `pending_approval`.

## 4. Команды сервер → расширение (req)

Все page-команды принимают `tabId`. Ответ расширения на любую page-команду
включает `url` и `title` вкладки после выполнения (для reconcile на сервере).

### Вкладки
- `tab.list` `{}` → `{tabs:[{tabId,url,title,active}]}`
- `tab.open` `{url, active?:bool}` → `{tabId,url,title}` (после load).
  MCP-вариант: с `tabId` — навигация существующей вкладки (`navigate`), без — новая.
- `tab.close` `{tabId}` → `{}`

### Страница
- `navigate` `{tabId,url}` → `{url,title,flags}` после «тихого окна» (см. §7)
- `back` `{tabId}` → `{url,title,flags}`
- `reload` `{tabId}` → `{url,title,flags}`
- `snapshot` `{tabId, scope?:"viewport"|"main"|"full", selector?}` →
  `{url,title,snapshot,dom_hash,flags,truncated}` — семантический снапшот (§6)
- `extractMarkdown` `{tabId, selector?, images?:"inline"|"manifest"|"off", max_chars?:число}` →
  `{url,title,markdown,images:[{n,src,alt,w,h}],flags}`
  Картинки и embed'ы стоят ИНЛАЙН в markdown на своих местах: `![alt](src)`,
  `[embedded: iframe-src]`, `[video|audio: src]`. Манифест `images` — для
  скачивания по номеру n (инлайн data: URI → `"data:(inline)"`).
  `images:"manifest"` — только манифест, без инлайна в тексте; `"off"` — без
  картинок вовсе (чистое чтение). Дефолт `"inline"` — контракт
  `localize-page.py`, не менять. `max_chars` (дефолт 15000) — лимит markdown
  по границе абзаца ДО серверной резки. Div-суп (мало p/h/li при большом
  тексте) — density-режим: выбор самого текстового контейнера по
  text-density/link-density, склейка текстовых div в абзацы, отсечение
  «хвостов» с link-density > 0.5 (П2-1, свои эвристики, без библиотек).
  Локализация (скачать картинки, подменить URL на локальные пути) —
  `bridge-server/scripts/localize-page.py`.
- `findText` `{tabId,query,role?}` → `{matches:[{ref,text}],flags}` (≤20)
- `waitFor` `{tabId, condition:{text?|ref?|url_contains?}, state?:"appear"|"disappear"|"stale", timeout_ms?:≤30000}` →
  `{url,title,flags,condition_met:bool}` — событийное ожидание условия на
  MutationObserver (П1-1), без polling снапшотами. Таймаут — НЕ ошибка:
  `condition_met:false`. Один активный wait на вкладку: повторный вызов во
  время ожидания → ошибка `WAIT_BUSY`. MCP-инструмент: `page.wait_for`,
  capability `read`.
- `screenshot` `{tabId}` → `{data_jpeg_base64}` (≤1280px, q70)
- `netList` `{tabId}` → `{requests:[{ts,url,type,frameId}]}` — пассивный лог
  media-запросов вкладки (webRequest, тип `media` + URL `*.m3u8|*.mpd`;
  кольцевой буфер 50 записей, чистится при навигации/закрытии вкладки).
  MCP-инструмент: `net.list`, capability `read` по домену вкладки.
- `consoleLog` `{tabId, limit?:≤100}` →
  `{url,title,flags,entries:[{ts,level,text,count?}][,console_unavailable]}` —
  пассивный лог `console.*` + `window.onerror`/`unhandledrejection` страницы
  (боковая линия, как net.list). Кольцевой буфер 100 записей на вкладку,
  `text` ≤500 символов, подряд идущие одинаковые записи складываются в `count`.
  Content script в isolated world console страницы НЕ видит — сбор делает
  MAIN-world хук `src/console-hook.js` (web_accessible_resources; внедряется
  content script'ом через `<script src>`, т.е. только на доменах политики),
  записи идут в content script через `window.postMessage` (маркер
  `__bridge_console`; rate-limit 50 записей/с в хуке). Буфер живёт в контексте
  документа → чистится при полной навигации сам; записи до инъекции хука
  (document_idle) теряются. Страница с жёстким CSP может запретить загрузку
  хука → честный маркер `console_unavailable` (по образцу
  `netlog_unavailable`), а не молчаливый пустой буфер.
  MCP-инструмент: `page.console`, capability `read`.
- `eval` `{tabId, expression, awaitPromise?:bool (дефолт true), timeout_ms?:≤30000 (дефолт 10000)}` →
  `{url,title,flags,value_json,value_type,bytes}` — инлайн (≤16000 символов
  JSON) — или `{url,title,flags,relayed:true,transferId,value_type,bytes}` —
  большой результат ушёл файловым релеем (§8) в `downloads/eval-result-*.json`
  (сервер ждёт трансфер по expectTransfer, как file.download, и отвечает
  `{relayed:true, file, size, sha256, …}`).
  Выполнение JS в MAIN world вкладки (window-состояние SPA, `fetch(...)` к
  внутренним API страницы — L1.1). Content script в isolated world страницу
  не видит — исполняет MAIN-world runner `src/eval-runner.js`
  (web_accessible_resources; внедряется content script'ом через `<script src>`,
  т.е. только на доменах политики), обмен — `window.postMessage` с requestId
  (маркеры `__bridge_eval` / `__bridge_eval_result`; косвенный eval в
  глобальном scope, awaitPromise await'ит Promise результата; сериализация
  устойчива к circular/DOM/функциям/BigInt/Map/Set/Error). Жёсткий CSP
  страницы может запретить загрузку runner'а → ошибка `EVAL_UNAVAILABLE`
  (честный маркер, как `console_unavailable`). Таймаут исполнения →
  `EVAL_TIMEOUT`; исключение в выражении → `EVAL_ERROR` с сообщением страницы.
  MCP-инструмент: `page.eval`. Гейтинг — двойной: capability `eval`
  per-domain (default-deny) + gated `eval: confirm` (по умолчанию; consent-
  баннер показывает expression, рекомендуется `eval: confirm` в hard_floor).
  Expression пишется в policy-audit.jsonl (preview + sha256), вызов
  учитывается в pacing-окне 30 act/мин, ответ маркируется
  `untrusted_page_content` (N15 — страница может подделать ответ runner'а).
- `scan` `{tabId, max_screens?:≤20}` → `{url,title,flags,scan,screens,unique[,scan_truncated]}` —
  автоскролл ленты с агрегацией уникальных интерактивных (П2-3): дедуп по
  сигнатуре строки, стоп после 3 экранов без роста или у дна ленты, жёсткие
  лимиты 20 экранов / 45 с. Строки в формате снапшота, refs живые.
  MCP-инструмент: `page.scan`, capability `interact` (скролл) + pacing.
- `click` `{tabId,ref}` → `{url,title,flags,navigated}`
- `type` `{tabId,ref,text,clear?:bool}` → `{url,title,flags}`
- `select` `{tabId,ref,value}` → `{url,title,flags}`
- `scroll` `{tabId,dy}` / `scrollIntoView` `{tabId,ref}` → `{url,title,flags}`
- `pressKey` `{tabId,key}` (`"Enter"`,`"Tab"`,`"Escape"`…) → `{url,title,flags}`
- `hover` `{tabId,ref|text}` → `{url,title,flags}` — наведение без клика
  (pointerover/mouseover/mousemove): раскрыть hover-меню/тултип. MCP-инструмент
  `act.hover`: capability `interact` + pacing, gated-классификация ref/text —
  как у `act.click`, авто-retry после STALE_REF общий (П1-3).
- `getStateHash` `{tabId}` → `{url,dom_hash}` — для reconcile при resume
- `fetchFile` `{tabId,url,name?}` → поток событий (§8); res:
  `{transferId,size,mime}` — приходит СРАЗУ после HTTP-заголовков, ДО
  окончания трансфера (завершение — evt `file.end`). Ошибки до `file.start`
  (HTTP != 2xx, сетевой сбой) — res ошибкой `FETCH_FAILED`.
  Policy проверяет домен ФАЙЛА (`url`), а не вкладки: capability `download`
  должна быть выдана домену, с которого скачиваем.

`flags` — массив строк из `["captcha","cloudflare_challenge","otp","login_form"]`,
вычисляется content script'ом по ВИДИМЫМ DOM-маркерам после каждой команды
(`cf-chl`, `challenge-platform`, `turnstile`, `g-recaptcha`, `h-captcha`,
`input[autocomplete=one-time-code]`, `input[type=password]`). Невидимые
интеграции (invisible reCAPTCHA/Turnstile, script-теги, 0px-контейнеры)
флагов не дают — защита от ложных авто-пауз.

Ошибки расширения: `NO_TAB`, `STALE_REF` (ref инвалидирован — агент должен
сделать свежий snapshot), `NAV_TIMEOUT`, `FETCH_FAILED`, `CONTENT_SCRIPT_ABSENT`
(домен вне match_patterns — значит и политика бы не пустила), `DOMAIN_MISMATCH`
(текущий URL вкладки не совпадает с match_patterns политики — команда не
исполнена), `NOT_FOUND`/`AMBIGUOUS` (click-by-text: кандидатов ноль или >1),
`WAIT_BUSY` (на вкладке уже активен waitFor — дождаться его завершения).

`click` принимает `ref` ИЛИ `text` (атомарный поиск+клик в момент исполнения,
устойчив к перерисовкам). Ответы act.* содержат `after` — свежие
интерактивные элементы скоупа (если DOM/URL изменились; ≤2KB) — отдельный
snapshot после действия обычно не нужен.

MCP-инструмент `act.batch` (П1-2, отдельной wire-команды нет — сервер сам
вызывает click/type/select/pressKey по шагам): `{tabId, steps:[{do:"click"|
"type"|"select"|"key", ref?|text?, value?, clear?, key?}]}`, ≤10 шагов.
Policy-check всех шагов — атомарно ДО исполнения (gated-шаг без гранта
отклоняет весь пакет); pacing — уменьшенный jitter 0.3–0.8 c между шагами,
каждый шаг идёт в окно 30 act/мин; ёмкость окна проверяется на весь пакет
заранее. Шаг получает авто-retry после STALE_REF (один, поиск по тексту из
кэша refs; >1 кандидата — AMBIGUOUS). Ответ — состояние после последнего
шага + `steps:[{do,ref,ok}]`. Падение шага → `BATCH_STEP_FAILED` с
`data:{steps, batch_completed}` (partial execution не скрывается).

## 5. Запросы расширение → сервер (req)

- `consent.response` НЕ нужен — согласие это res на серверный req (ниже).
- `grant.add` `{domain, capabilities:["read","interact",...], scope:"session"}` →
  `{granted:true}` — разовый грант из popup. REPLACE-семантика: popup шлёт полный
  набор capabilities (чекбоксы), повторная выдача = редактирование (можно снять
  capability). Невалидные capability отбрасываются. Сервер пишет аудит и шлёт
  свежий `policy.update` всем.
- `grant.remove` `{domain}` → `{removed:bool}` — отзыв разового гранта из popup
  (только session-гранты; пресетные домены — правкой policy.yaml). Сервер пишет
  аудит (`session_revoke`) и шлёт свежий `policy.update` — инжектор
  перерегистрирует content scripts без этого домена.
- `preset.switch` `{name}` → `{preset}` — переключение пресета из popup
  (user gesture, разрешено всегда). Сервер шлёт `policy.update`.

## 6. Согласие (gating) и пауза

Gated-действие: сервер → ext req `consent.ask`
`{requestId, category:"pay"|"login"|"submit"|"delete"|"custom", description,
 domain, tabId, timeout_ms:120000}`.
Расширение рисует shadow-DOM баннер во вкладке `tabId`. Ответы:
`{decision:"allow"|"deny"|"allow_10min"}`. По таймауту расширение само шлёт
`deny`. `allow_10min` — сервер кэширует решение на (domain, category) на 10 мин.

События паузы (ext→server evt):
- `pause.global` `{paused:bool}` — красная кнопка в popup.
- `pause.auto` `{tabId, reason, flags}` — контент-скрипт увидел капчу/челлендж/2FA.
- `resume` `{tabId}` — пользователь снял авто-паузу вкладки. Сервер тогда
  вызывает `getStateHash`, сверяет с чекпоинтом (url+dom_hash на момент паузы)
  и помечает сессию `STATE_DIVERGED` при расхождении.

## 7. Тихое окно (SPA-стабилизация)

После navigate/back/reload/click content script ждёт: `document.readyState` ≥
interactive И 500 мс без DOM-мутаций (MutationObserver). Общий таймаут 10 c
(далее — продолжаем с тем что есть, `truncated:true` если окно не наступило).

## 8. Файловый релей (ext → server, всё через WS)

fetch выполняет BACKGROUND расширения (MV2 page / MV3 SW), НЕ content script
(перенос 2026-08, живой кейс HuggingFace): background с host-правами
`<all_urls>` не связан CORS страницы — cross-origin редиректы на CDN
(xet/LFS → `cas-bridge.xethub.hf.co`) проходят. Куки — браузерная банка
(`credentials:"include"`, та же сессия, что у вкладки). `tabId` в `fetchFile`
по-прежнему обязателен: `assertTabDomain` + источник Referer/Origin (ниже).

Читается `response.body.getReader()` потоково: накопление до 256 КБ →
`file.chunk` → ожидание `file.ack` → следующий чанк. Файл целиком в память
не собирается (устранено тройное буферирование: parts[] + склейка + base64);
sha256 считается инкрементально (extension/src/sha256.js — чистый JS, без
внешних зависимостей; `crypto.subtle` в background-контекстах не гарантирован).

```jsonc
{"type":"evt","event":"file.start","data":{"transferId":"t_7","name":"lesson.pdf","size":123456,"mime":"application/pdf"}}
{"type":"evt","event":"file.chunk","data":{"transferId":"t_7","seq":0,"data_base64":"..."}}
{"type":"evt","event":"file.end","data":{"transferId":"t_7","sha256":"..."}}
```

res на `fetchFile` — `{transferId,size,mime}` СРАЗУ после HTTP-заголовков
(до стриминга): серверный transport-timeout 120 c покрывает только «старт»,
а не весь трансфер; сервер дожидается завершения по `file.end`
(`expectTransfer`, параллельно с res). Ошибки ДО `file.start` (HTTP != 2xx,
сетевой сбой fetch) — res ошибкой `FETCH_FAILED`, ожидание в релее снимается
(`cancelExpect`). Сбой ПОСРЕДИ стрима (в т.ч. отказ/таймаут ack) →
evt `file.abort {transferId, reason}` — трансфер фейлится на сервере.

Backpressure: расширение ждёт evt `file.ack {transferId, seq}` от сервера перед
отправкой следующего чанка (таймаут ack 20 c → `file.abort`).
Сервер пишет в `<repo>/downloads/<uniquified name>` и строку в
`downloads/manifest.jsonl` `{ts,url,name,size,sha256,status}`.

Referer/Origin: CDN редирект-целей проверяет их, а фоновый запрос расширения
по умолчанию нёс бы `Origin: moz-extension://…`. На время трансфера background
ставит точечный webRequest-rewriter (MV2, `onBeforeSendHeaders` + blocking,
право `webRequestBlocking`): `Referer` = URL вкладки, `Origin` = её origin;
правятся только запросы этого трансфера (первый хоп — фоновый запрос ровно на
url из fetchFile, дальше — хопы редиректа по requestId), слушатель снимается
по завершении. В MV3 service worker webRequest без bindings → rewriter не
ставится, fetch идёт с заголовками по умолчанию (известная деградация
Chromium-варианта).

Нюанс trust-model: background-fetch следует cross-origin редиректам свободно;
политика проверяет только НАЧАЛЬНЫЙ url (`fetchFile.url` + домен вкладки) —
цель редиректа отдельно не проверяется (тот же trust-model, что навигация
браузера по редиректу).

MV3: трансфер минутами живёт в service worker — WS-трафик (file.chunk/ack)
сбрасывает idle-таймер (Chrome 116+, подтверждено спайком G1); страховка —
штатный alarms-keepalive (keepalive.js), отдельного механизма под трансфер
не требуется.

Известное ограничение: сайты, отдающие файл через СОБСТВЕННЫЙ service worker
(раздача из Cache API / синтезированный Response только в контексте страницы),
background-fetch обойдёт — такой ответ увидит только запрос из контекста
страницы. Обходного content-script-пути нет (единый путь — осознанное решение:
меньше расхождений).

MCP-прогресс (П.5): на каждый принятый чанк сервер (поверх релея, без влияния
на ack/backpressure) шлёт MCP-клиенту `notifications/progress`
`{progressToken, progress: байты, total: size?}` — только если вызов
`tools/call file.download` нёс `_meta.progressToken`. Троттлинг: первое
уведомление сразу, дальше не чаще 1/с. SDK-клиенты с
`resetTimeoutOnProgress: true` сбрасывают по этим уведомлениям таймаут запроса
и не видят `-32001` на больших файлах; клиенты без этого флага (или без
progressToken) работают ровно как раньше — правило «при -32001 не ретраить,
проверить manifest.jsonl» остаётся в силе.

## 9. Семантический снапшот (формат `snapshot`)

Текст, человеко-ориентированный (агент видит «что видит человек», не HTML):

```
url: https://…
title: …
[e1] link "Войти" → /login
[e2] button "Добавить в корзину"
[e3] textbox name=q placeholder="Поиск" value=""
[e4] select name=city ["Минск","Гродно"]
[e5] checkbox "Согласен" checked=false
# Заголовок раздела
Текст абзаца… (видимый текст main/viewport, сжатый)
```

- ref-метки `eN` — только интерактивные: a, button, input, select, textarea,
  summary, [role=button|link|checkbox|…], [contenteditable], [tabindex].
- Скоуп по умолчанию: пересечение viewport и `main|article` (fallback body);
  `scope:"full"` — вся страница. При дефолтном скоупе интерактивные элементы
  из `header/nav/footer/aside` опускаются В КОНЕЦ снапшота (П1-4), при
  `scope:"full"`/явном `selector` — в порядке документа.
- Повторы: ≥5 подряд строк с одинаковой сигнатурой сворачиваются в
  `[e12..e61] button "Купить" ×50` (П1-5). Свёртка визуальная: любой ref из
  диапазона адресуем, сервер раскрывает диапазон для классификатора.
- Pointer-цепочки (вложенные div/span/li с cursor:pointer и одним текстом)
  дают одну строку — нижний элемент (П1-4).
- Карта ref→элемент живёт в content script и ИНВАЛИДИРУЕТСЯ при навигации и
  DOM-мутациях; команда по мёртвому ref → `STALE_REF` (сервер один раз
  переснимает снапшот и повторяет действие по тексту элемента — П1-3).
- `dom_hash` — сервер хэширует строку snapshot (sha256, короткий). Повторный
  snapshot с тем же dom_hash и тем же скоупом → `{unchanged:true}` (П0-3).

## 10. Коды ошибок сервера (MCP → агент)

`BROWSER_OFFLINE`, `SESSION_NOT_APPROVED`, `SESSION_DENIED`,
`DOMAIN_NOT_ALLOWED`, `CAPABILITY_DENIED`, `ACTION_DENIED` (consent deny/timeout),
`PAUSED`, `AUTO_PAUSED_HUMAN_NEEDED`, `STATE_DIVERGED`, `PACING_LIMIT`,
`STALE_REF`, `AMBIGUOUS` (авто-retry нашёл >1 кандидата по тексту),
`AMBIGUOUS_BROWSER` (§11: tabId есть в нескольких браузерах — указать `browser`),
`BATCH_STEP_FAILED` (act.batch: шаг упал, `data.batch_completed` — сколько успело),
`WAIT_BUSY` (на вкладке уже активен page.wait_for),
`SCREENSHOT_TOO_LARGE` (скриншот за потолком — base64 не отдан),
`EVAL_UNAVAILABLE` (CSP запретил MAIN-world eval-runner), `EVAL_TIMEOUT`,
`EVAL_ERROR` (исключение в выражении — текст страницы, untrusted),
`RESPONSE_TOO_LARGE` (после резки — hint), `TIMEOUT`, `INTERNAL`.

Формат ответа MCP-инструмента: `{ok, data|error_code, hint, policy_reminder}`.
`policy_reminder`: активный пресет + security-ограничения домена +
содержимое `memory/domains/<domain>.md` и `memory/global-notes.md`, если есть.

## 11. Мультиклиентность (несколько браузеров у одного сервера)

**Wire-формат сообщений не изменился** — конверты req/res/evt, методы и поля
те же (§1–§8). Меняется только серверная маршрутизация: расширение вообще не
знает о других браузерах.

- **clientId = `browser` из `hello`** (§2; без поля — `'default'`). Сервер
  держит `Map<clientId, Connection>`; до `hello` соединение безымянное.
  Переподключение с тем же clientId заменяет старый сокет (незавершённые req
  старого сокета → `BROWSER_OFFLINE`).
- **Состояния и approve — per-client** (§2–§3 применяются к каждому клиенту
  отдельно): `offline`/`pending_approval`/`active`/`denied` свои у каждого
  браузера; approve переживает реконнект в рамках серверной сессии (тот же
  `server_session_id`); дисконнект одного браузера не меняет состояние
  остальных. Heartbeat (ping 15 c / offline 45 c) — per-connection.
- **Политика per-browser (D4):** у записи домена в пресете policy.yaml может
  быть поле `browsers: [clientId, …]` — домен доступен только перечисленным
  браузерам; без поля — всем (обратная совместимость). Session-гранты
  (`grant.add`/`grant.remove`, §5) привязаны к браузеру-источнику: грант из
  popup firefox не действует в chromium. Проверка домена, не грантованного
  этому браузеру, → `DOMAIN_NOT_ALLOWED`.
- **`policy.update` — per-client:** каждому клиенту сервер шлёт вид только его
  доменов (match_patterns и domains отфильтрованы по clientId; глобальные
  `gated_defaults`/`version` — общие).
- **MCP-инструменты:** во все tab-инструменты добавлен опциональный параметр
  `browser` (clientId из `tab.list`/`policy.status`; не нужен, когда онлайн
  один браузер). Резолв цели: `browser` → clientId; иначе по `tabId` в реестре
  (0 владельцев → `NO_TAB`; >1 → `AMBIGUOUS_BROWSER` с hint «укажи browser: …»);
  `tab.open` без `tabId` при нескольких онлайн-браузерах требует `browser`.
  Реестры вкладок/снапшотов/пауз ключированы `clientId:tabId` (tabId в wire
  остаётся числом браузера и может совпадать у разных клиентов).
- **`tab.list`** опрашивает всех active-клиентов и объединяет ответ; каждая
  вкладка тегируется полем `browser`. `hidden_tabs` считается по политике
  браузера-владельца вкладки. `policy.status` дополнен полем
  `browsers: [{id, browser, state, ext_version, ua}]`.
- **События тегируются clientId** на стороне сервера (по соединению-источнику;
  wire не меняется): `pause.auto`/`resume`/`pause.global` и `consent.ask`
  маршрутизируются в браузер-владелец вкладки. `pause.global` (красная кнопка)
  остаётся глобальной паузой агента.
- **Параллельные файловые трансферы (§8):** релей связывает `file.start` с
  ожиданием `file.download` того же клиента (FIFO по клиенту),
  `file.ack {transferId, seq}` уходит только клиенту-владельцу трансфера;
  трансферы разных браузеров (или несколько у одного) завершаются независимо.
  Дисконнект клиента отменяет только его трансферы и ожидания.
