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
- `extractMarkdown` `{tabId, selector?}` → `{url,title,markdown,images:[{n,src,alt,w,h}],flags}`
  Картинки и embed'ы стоят ИНЛАЙН в markdown на своих местах: `![alt](src)`,
  `[embedded: iframe-src]`, `[video|audio: src]`. Манифест `images` — для
  скачивания по номеру n (инлайн data: URI → `"data:(inline)"`).
  Локализация (скачать картинки, подменить URL на локальные пути) —
  `bridge-server/scripts/localize-page.py`.
- `findText` `{tabId,query,role?}` → `{matches:[{ref,text}],flags}` (≤20)
- `screenshot` `{tabId}` → `{data_jpeg_base64}` (≤1280px, q70)
- `netList` `{tabId}` → `{requests:[{ts,url,type,frameId}]}` — пассивный лог
  media-запросов вкладки (webRequest, тип `media` + URL `*.m3u8|*.mpd`;
  кольцевой буфер 50 записей, чистится при навигации/закрытии вкладки).
  MCP-инструмент: `net.list`, capability `read` по домену вкладки.
- `click` `{tabId,ref}` → `{url,title,flags,navigated}`
- `type` `{tabId,ref,text,clear?:bool}` → `{url,title,flags}`
- `select` `{tabId,ref,value}` → `{url,title,flags}`
- `scroll` `{tabId,dy}` / `scrollIntoView` `{tabId,ref}` → `{url,title,flags}`
- `pressKey` `{tabId,key}` (`"Enter"`,`"Tab"`,`"Escape"`…) → `{url,title,flags}`
- `hover` `{tabId,ref}` → `{url,title,flags}`
- `getStateHash` `{tabId}` → `{url,dom_hash}` — для reconcile при resume
- `fetchFile` `{tabId,url,name?}` → поток событий (§8); финальный res:
  `{transferId,size,sha256}` — res приходит ПОСЛЕ evt `file.end`.
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
исполнена), `NOT_FOUND`/`AMBIGUOUS` (click-by-text: кандидатов ноль или >1).

`click` принимает `ref` ИЛИ `text` (атомарный поиск+клик в момент исполнения,
устойчив к перерисовкам). Ответы act.* содержат `after` — свежие
интерактивные элементы скоупа (если DOM/URL изменились; ≤2KB) — отдельный
snapshot после действия обычно не нужен.

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

Content script делает `fetch(url, {credentials:"include"})`, читает
`response.body` чанками по 256 КБ:

```jsonc
{"type":"evt","event":"file.start","data":{"transferId":"t_7","name":"lesson.pdf","size":123456,"mime":"application/pdf"}}
{"type":"evt","event":"file.chunk","data":{"transferId":"t_7","seq":0,"data_base64":"..."}}
{"type":"evt","event":"file.end","data":{"transferId":"t_7","sha256":"..."}}
```

Backpressure: расширение ждёт evt `file.ack {transferId, seq}` от сервера перед
отправкой следующего чанка (таймаут ack 15 c → `file.abort`). Ошибка →
evt `file.abort {transferId, reason}` и res ошибкой `FETCH_FAILED`.
Сервер пишет в `/workspace/downloads/<uniquified name>` и строку в
`downloads/manifest.jsonl` `{ts,url,name,size,sha256,status}`.

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
  `scope:"full"` — вся страница.
- Карта ref→элемент живёт в content script и ИНВАЛИДИРУЕТСЯ при навигации и
  DOM-мутациях; команда по мёртвому ref → `STALE_REF`.
- `dom_hash` — сервер хэширует строку snapshot (sha256, короткий).

## 10. Коды ошибок сервера (MCP → агент)

`BROWSER_OFFLINE`, `SESSION_NOT_APPROVED`, `SESSION_DENIED`,
`DOMAIN_NOT_ALLOWED`, `CAPABILITY_DENIED`, `ACTION_DENIED` (consent deny/timeout),
`PAUSED`, `AUTO_PAUSED_HUMAN_NEEDED`, `STATE_DIVERGED`, `PACING_LIMIT`,
`STALE_REF`, `RESPONSE_TOO_LARGE` (после резки — hint), `TIMEOUT`, `INTERNAL`.

Формат ответа MCP-инструмента: `{ok, data|error_code, hint, policy_reminder}`.
`policy_reminder`: активный пресет + security-ограничения домена +
содержимое `memory/domains/<domain>.md` и `memory/global-notes.md`, если есть.
