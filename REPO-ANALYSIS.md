# Глубокий анализ репозитория kimi-code browser bridge

Дата анализа: 2026-08-17. Основан на чтении исходников `bridge-server/src/`, `extension/src/`, `bridge-server/scripts/`, `policy.yaml`, `PROTOCOL.md`, `README.md`, `SETUP.md`, `optimization_plan.md`, `kimi-code-browser-bridge-plan.md`, `memory/`.

---

## 1. Назначение и состав проекта

Мост между AI-агентом (Kimi Code CLI, работает в контейнере без egress) и браузером пользователя на хосте. Агент получает 19 MCP-инструментов (`mcp__browser-bridge__*`) для чтения страниц, действий в них и скачивания файлов через сессию браузера (с куками пользователя).

Три компонента:

- **`bridge-server/`** — MCP-сервер на Node ≥22.6 (TypeScript через `tsx`, без сборки). Стек: `@modelcontextprotocol/sdk` ^1.30, `ws`, `yaml`, `zod` v4.
- **`extension/`** — одно кроссбраузерное расширение: Firefox MV2 (persistent background) и Chromium MV3 (service worker, `sw-loader.js` + `importScripts` тех же модулей; сборка `build-chromium.sh` → `dist/chromium/`).
- **`policy.yaml`** — единственный источник правил безопасности (hot-reload), правит только человек.

Вспомогательное: `bridge-server/scripts/` (hls-download.py, localize-page.py, token-stats.py, playbook-draft.py, live-repl.mjs и др.), `memory/` (журнал, аудит, плейбуки доменов), `userscripts/` (внешний userscript, к мосту не относится по политике), `tools/ffmpeg` (ремукс видео).

### Модули сервера (`bridge-server/src/`)

| Файл | Строк | Роль |
|---|---|---|
| `index.ts` | 205 | entry: секрет, транспорты, файл-REPL, связывание policy ↔ transport |
| `transport.ts` | 380 | WS-сервер, мультиклиентность, auth, heartbeat, состояния сессии |
| `policy.ts` | 461 | PolicyEngine: пресеты, гранты, gating, hard_floor, аудит, hot-reload |
| `mcp.ts` | 740 | 19 MCP-инструментов + `BridgeCore.callTool` — единый конвейер |
| `classifier.ts` | 79 | классификация действий в gated-категории, парсер refs снапшота |
| `compress.ts` | 93 | страховочная резка ответов >20 KB (N7) |
| `downloads.ts` | 241 | файловый релей: чанки, ack, sha256, dedup, manifest |
| `memory.ts` | 86 | journal.jsonl + policy_reminder из плейбуков |
| `pacing.ts` | 51 | human-pacing (N6): jitter + rate limit |

### Транспорты и поток данных

1. **Агент ↔ сервер**: MCP по stdio (`StdioServerTransport`); stdout занят протоколом, логи — в stderr.
2. **Сервер ↔ расширение**: WebSocket, строка = JSON-конверт `req/res/evt`. Два слушателя: TCP `0.0.0.0:18777` и unix-сокет `/workspace/.bridge/bridge.sock` (обход изоляции rootless podman; на хосте `socat` релеит сокет в `127.0.0.1:18777`). Handshake `hello{secret, browser, …}` → approve человеком → push `policy.update` с per-browser `match_patterns`.
3. **Файл-REPL** (встроен в MCP-процесс, `index.ts:171`): poll `.bridge/cmd.json` каждые 700 мс → `core.callTool(tool, args, {uncap:true})` → `result.json`. Канал для скриптов, идёт мимо модели (поэтому без резки N7). Защита — только тем, что писать в `.bridge/` может лишь процесс внутри контейнера (осознанно, optimization_plan §5.1).
4. **Background ↔ content script**: runtime messaging `{kind:"cmd"|"evt"|"file"}`; **background → popup**: `storage.local`.

Поток одной команды (`BridgeCore.callTool`, mcp.ts:225–371): резолв клиента (`resolveClientId`) → состояние сессии → паузы (PAUSED / AUTO_PAUSED_HUMAN_NEEDED / STATE_DIVERGED) → определение capability (read/interact/download; для `file.download` проверяется домен **файла**, не вкладки) → классификация + `policy.check` (+consent) → pacing → исполнение через `transport.request` → авто-retry при STALE_REF → маркировка untrusted → capResponse → журнал + версионированный policy_reminder.

Мультибраузерность (фаза 9, D1–D7): `Transport.clients = Map<clientId, Connection>`, реестры вкладок/снапшотов/пауз ключированы `clientId:tabId`; коллизии tabId → `AMBIGUOUS_BROWSER`, офлайн-браузер → `BROWSER_OFFLINE`, остальные работают.

Файловый релей: content script делает `fetch(url, {credentials:"include"})` в контексте страницы (наследует сессию сайта) → чанки 256 КБ base64 по WS с ack-backpressure → `DownloadRelay` пишет в `/workspace/downloads` + строка в `manifest.jsonl`. Это единственный канал загрузок — egress у контейнера нет.

---

## 2. Модель безопасности

### 2.1 Аутентификация и сессия

- Секрет 32 байта hex в `.bridge/secret` (0600, генерируется при первом старте, `index.ts:50`). Сравнение через `crypto.timingSafeEqual` с проверкой длины (`transport.ts:299–307`) — защита от timing-атаки. Провал → `AUTH_FAILED`, сокет закрывается.
- **Human-in-the-loop**: после `hello` клиент в `pending_approval`, все команды → `SESSION_NOT_APPROVED`; approve — per-browser из popup (notification с кнопками + popup). Approve переживает реконнект в рамках серверной сессии (`server_session_id`), deny — нет (`transport.ts:349–353`). Смена `server_session_id` сбрасывает session-гранты на стороне расширения.

### 2.2 Политика доступа: default-deny, пресеты, capabilities

- `default: deny`; пресеты (`local-services`/`course`/`shop`); capabilities `read | interact | download`.
- Матчинг доменов (`policy.ts:217–239`): точный `host:port`, host и поддомены, любой порт.
- **Per-browser изоляция (D4)**: у домена пресета поле `browsers: [...]`; грант одного браузера не действует в другом. Session-гранты ключированы `${clientId}\n${domain}`. `policy.update` каждому клиенту содержит только его домены.
- **Минимизация раскрытия**: `tab.list` скрывает URL/title вкладок с негрантованных доменов (только счётчик `hidden_tabs`, mcp.ts:548–554).
- **Сервер — единственный арбитр**: расширение использует policy только для регистрации content scripts (только под домены политики) и UI.
- **Харденинг на стороне расширения (защита в глубину)**:
  - `assertTabDomain` (background.js:680) — перед каждой page-командой свежий `tabs.get(url)` сверяется с match_patterns → `DOMAIN_MISMATCH`. Закрывает окно «пользователь вручную увёл вкладку на чужой домен».
  - Владение вкладками (`owners.js`, D11): `TAB_NOT_OWNED` чужому подключению; при ≥2 подключениях неназначенные вкладки default-deny для всех.
  - Host-права `<all_urls>` только в `optional_permissions`, запрашиваются исключительно из обработчика клика в popup (N2, popup.js:343–349).

### 2.3 Gated-действия и consent

- Категории `pay | login | submit | delete`, решения `auto | confirm | deny` с рангом силы (`STRENGTH`, policy.ts:15).
- Классификатор (`classifier.ts`): URL-паттерны (`checkout|payment` → pay, `login|signin` → login) + метаданные ref из серверного кэша снапшота (т.е. классификация по тому, что видел агент): `type=password` → login, текстовые regex-маркеры оплаты/удаления, `type=submit` → submit. Свёрнутые диапазоны `[e12..e61] ×50` раскрываются (до 1000) — клик по середине диапазона не обходит gating (П1-5).
- **hard_floor (N16)**: решение нельзя ослабить ниже floor без `allow_unsafe: true` в пресете; ослабление фиксируется в аудите как override. Текущий floor: `pay: confirm`.
- **Consent-флоу**: `confirm` → баннер `consent.ask` в браузер-владелец вкладки; таймаут 120 с = deny (fail-closed); `allow_10min` кэшируется на (domain, category) 10 минут.
- **Баннер неподделываем страницей**: Shadow DOM `mode:"closed"`, тексты только через `textContent` (description приходит по сети — защита от XSS/инъекции), таймаут → автозапрет.
- **Агент не может расширить себе права**: `policy.request_preset` требует баннер-подтверждения человеком; отказ → `ACTION_DENIED` + аудит `preset_switch_denied`. Session-гранты — replace-семантика с валидацией capabilities по белому списку.

### 2.4 Паузы и reconcile

- Глобальная пауза (красная кнопка popup) → `PAUSED`, глобальна независимо от браузера-источника.
- **Авто-пауза**: content script вычисляет флаги только по **видимым** DOM-маркерам (Cloudflare challenge, captcha, OTP, login_form; невидимые интеграции отфильтрованы через `getClientRects` — invisible reCAPTCHA не даёт ложных пауз); дедупликация по ключу флагов. На сервере → `AUTO_PAUSED_HUMAN_NEEDED` с чекпоинтом `{url, dom_hash}`. Resume — только жестом пользователя.
- **STATE_DIVERGED (N5)**: при resume сервер сверяет `getStateHash` с чекпоинтом; расхождение → одноразовый `STATE_DIVERGED` со свежим хэшем и подсказкой сделать новый snapshot.

### 2.5 Pacing / rate limits (N6)

- Глобально: `min_delay_ms: 400`, `max_delay_ms: 2500`, `max_actions_per_minute: 30`; per-preset переопределения.
- Скользящее окно 60 с → `PACING_LIMIT`; случайная задержка 0.4–2.5 с перед каждым act.* (human-like поведение).
- `checkCapacity(n)`: act.batch проверяет ёмкость окна на весь пакет **до старта** — отклонение целиком, а не падение посередине. Внутри batch — уменьшенный, но ненулевой jitter 0.3–0.8 с.

### 2.6 Журналирование, аудит, маскировка

- `journal.jsonl`: по умолчанию только digests (sha256-12 + bytes args/result). Полные args — при `journal_full_args: true`, и тогда **значения `act.type` в password-поле или login-контексте маскируются `***`** (`sanitizedArgs`, mcp.ts:377–394), включая шаги act.batch. Проверено тестом.
- `policy-audit.jsonl`: append-only аудит каждого решения policy (grant/deny/override/preset_switch/session_grant/consent_*/…).
- Ошибки записи логируются, не фатальны.

### 2.7 Разделение доверия (N15)

- Ответы page-инструментов маркируются `untrusted_page_content: true`; `policy_reminder` явно помечен trusted.
- Страница не может изменить политику: пути изменения — только правка policy.yaml человеком (hot-reload `fs.watch` с debounce 100 мс) и жесты в popup. Инструкции из текста страниц не выполняются (правило AGENTS.md).

### 2.8 Целостность и безопасность скачиваний

- sha256 на потоке: несовпадение → удаление `.partial`, `FETCH_FAILED`.
- `sanitizeName` (basename + whitelist символов) против path traversal; `uniquify` против перезаписи.
- Строгий порядок seq (mismatch → abort); ack-backpressure per-client; ack только клиенту-владельцу трансфера; дисконнект клиента отменяет только его трансферы.

### 2.9 Безопасная деградация

- STALE_REF-retry: перенайденный элемент классифицируется заново; смена gated-категории → `ACTION_DENIED`; >1 кандидата → `AMBIGUOUS` (молча не выбирает).
- Fail-fast: при дисконнекте все pending req → `BROWSER_OFFLINE` сразу (очередей нет).
- Consent на background: домен вне политики или отсутствие content script (challenge-страница) → `deny`.
- Полный реестр кодов отказов (~27): `BROWSER_OFFLINE`, `SESSION_NOT_APPROVED/DENIED`, `DOMAIN_NOT_ALLOWED`, `CAPABILITY_DENIED`, `ACTION_DENIED`, `PAUSED`, `AUTO_PAUSED_HUMAN_NEEDED`, `STATE_DIVERGED`, `PACING_LIMIT`, `STALE_REF`, `AMBIGUOUS`, `AMBIGUOUS_BROWSER`, `BATCH_STEP_FAILED`, `WAIT_BUSY`, `SCREENSHOT_TOO_LARGE`, `RESPONSE_TOO_LARGE`, `TIMEOUT`, `NO_TAB`, `FETCH_FAILED`, `CONTENT_SCRIPT_ABSENT`, `NAV_TIMEOUT`, `DOMAIN_MISMATCH`, `TAB_NOT_OWNED`, `AUTH_FAILED`, `INTERNAL`.

---

## 3. Оптимизации

Проект имеет формальный план оптимизации (`optimization_plan.md`), и маркеры пунктов (П0-x, П1-x, П2-x, N-риски) прямо в комментариях кода — реализация отслеживается против плана.

### 3.1 Экономия токенов (главная тема)

**На стороне расширения (источник данных):**

- **Семантический снапшот вместо HTML** (snapshot.js): только заголовки h1–h3 + интерактивные элементы, однострочный формат `[e12] button "Купить"`. Фильтры: видимость, viewport (снимается при `scope:"full"`/`selector`), `aria-hidden`, hidden-inputs. Лимиты: `MAX_ELEMENTS = 300`, сжатый текст страницы `TEXT_LIMIT = 1500` символов (вырезаны script/style/nav/header/footer/aside/form).
- Дефолтный скоуп `main, article`; строки хрома (header/nav/footer) переносятся в конец снапшота (П1-4б) — контент первым, но элементы адресуемы.
- **Свёртка повторов** (П1-5): ≥5 подряд одинаковых строк → `[e12..e61] button "Купить" ×50`; диапазон раскрывается сервером для классификатора — экономия не ломает gating.
- **Дедуп cursor-pointer цепочек** (П1-4а): вложенные div'ы с `cursor:pointer` и тем же текстом сворачиваются к нижнему; `getComputedStyle` — лениво.
- **Дедуп ref→element O(1)** через WeakMap: повторный снапшот не плодит новые ref на те же элементы.
- **after-блок в ответах act.\*** (≤2 КБ, `AFTER_LIMIT = 2048`): свежие интерактивные элементы с сортировкой по **визуальной** близости к pivot (выпадающие списки монтируются в конец body — DOM-близость не работает). Если ничего не изменилось — поле `after` вообще не добавляется. Отдельный snapshot после клика обычно не нужен.
- **extractMarkdown**: собственные эвристики без библиотек; density-режим для «div-супа» (score = длина текста × (1 − link-density), отсечение блоков с link-density > 0.5); лимит 15000 символов с резкой **по границе абзаца** до серверного capResponse; картинки — компактный манифест, data: URI свёрнуты в `data:(inline)`; режим `images:"off"`.
- **scan**: агрегация уникальных элементов по сигнатуре через seen-Set; лимит 12000 символов.
- Скриншоты: даунскейл ≤1280px, JPEG q70.
- `net.list`: кольцевой буфер 50 записей на вкладку.
- Диагностика (`debugSettle`) в ответ не включается (П0-4).

**На стороне сервера:**

- **`{unchanged:true}` по dom_hash** (П0-3, mcp.ts:585–589): sha256[:16] текста снапшота; ключ кэша включает scope+selector (защита от ложного unchanged). Кэш refs не затирается — старые refs остаются валидными.
- **Версионированный policy_reminder** (П0-1): полный reminder (пресет + плейбуки домена) — при первом вызове, смене хэша содержимого, раз в 10 вызовов и на любой ошибке; иначе короткая форма `{preset, domain, reminder_version}`.
- **Компактный JSON** (П0-2): `JSON.stringify` без indent.
- **capResponse (N7, compress.ts)**: лимит 20 KB; режется самое длинное строковое поле с маркером `RESPONSE_TOO_LARGE` и hint «сузь селектор». Скриншот исключён из резки (обрубок base64 бесполезен): сверх 1.5 М символов — честная `SCREENSHOT_TOO_LARGE` (П0-5).
- **`page.find`** — ≤20 совпадений без полного снапшота.
- **Измеримость** (П2-4): journal пишет bytes args/result каждого вызова; `token-stats.py` агрегирует расход по инструментам — задуман как единственный способ верифицировать экономию.

### 3.2 Скорость работы

- **`page.wait_for`** (П1-1): событийное ожидание на MutationObserver вместо polling-снапшотов; таймаут — не ошибка, а `{condition_met:false}`; один активный wait на вкладку (`WAIT_BUSY`); транспортный таймаут = контентный + 15 с.
- **«Тихое окно»** `waitQuiet` — 500 мс без мутаций (N9); `settleForSuggestions` — событийное детектирование автокомплита (≥3 новых интерактивных за одну мутацию — сигнатура выпадающего списка).
- **`act.batch`** (П1-2): до 10 действий одним вызовом, единый атомарный policy-check, один after-блок в конце — экономия round-trip'ов и токенов; падение шага → `BATCH_STEP_FAILED` с `data.batch_completed` (partial execution не скрывается).
- **Вотчеры гонок при клике**: детект смерти контекста при JS-навигации → recover со сторожевым таймаутом 12 с вместо 30-секундного TIMEOUT; anchor-fallback доводит навигацию, если JS подавил клик; waiter создаётся ДО действия (быстрый complete не пропускается). `NAV_TIMEOUT` не фатален — `truncated:true`.
- Backoff reconnect 1→30 с; fail-fast на дисконнекте.
- Параллельные трансферы разных браузеров независимы (FIFO per clientId).
- Hot-reload policy.yaml с debounce 100 мс; push `policy.update` переинжектирует открытые вкладки (П2-6) — F5 не обязателен.

### 3.3 Идемпотентность и докачка

- **Dedup скачиваний** (П0-6): повтор идентичного файла (url+size+sha256 против `manifest.jsonl`, файл жив) → возврат существующего (`dedup:true`).
- **hls-download.py**: готовые `.ts`/`.mp4` пропускаются; сегменты докачиваются с места обрыва; дедуп URL при `--net`; variant'ы, уже скачанные как часть мастера, не качаются повторно; проверка sync-байта 0x47 MPEG-TS после склейки; ремукс `ffmpeg -c copy`.
- **localize-page.py**: существующие картинки не перекачиваются; embed'ы видео подменяются локальными файлами.
- **poe-bulk-exporter.user.js**: резюм через IndexedDB/localStorage, backoff на 429/5xx, стоп-кран после 5 чатов подряд с ошибкой.

### 3.4 Эффективность принятия решений (для агента)

- **Ref-модель с точечной ревалидацией (N8)**: мутации DOM не стирают ref-карту, только ставят dirty; при resolve ревалидируется конкретная запись (сигнатура tag+role+текст; value полей форм не входит — ввод не убивает ref); перепоиск по css-пути + сигнатуре с tie-breaking. Монотонные ref'ы никогда не переиспользуются — мёртвый ref даёт `STALE_REF`, а не клик «мимо». Полная инвалидация только при смене URL.
- **Авто-retry после STALE_REF** (П1-3): ровно один пересъём снапшота + поиск по тексту + повтор; ответ `{retried:true, new_ref}`; пересъём обновляет кэш (иначе следующий snapshot дал бы ложный unchanged — ловушка §5.5 плана учтена).
- **Атомарный click-by-text**: exact → prefix → substring; множественные кандидаты → `AMBIGUOUS` со списком; не найден → `NOT_FOUND` с ближайшими вариантами — материал для самокоррекции в одном ответе.
- **Hint'ы как инструкции модели**: ошибки несут actionable-текст (списки подключённых браузеров, владельцев вкладки, «не повторяй без изменения замысла» при consent deny).
- **Честные маркеры деградации** вместо молчаливых пустых ответов: `netlog_unavailable`, `truncated`, `after_truncated`, `scan_truncated`, `condition_met:false`, `hidden_tabs`.
- **Memory-плейбуки**: `memory/domains/<domain>.md` + `global-notes.md` инжектируются в policy_reminder — повтор задачи на домене дешевле (рабочие цепочки, селекторы, глюки). `playbook-draft.py` строит черновик плейбука из успешной цепочки журнала (на ревизию человеку/агенту, не автоматически).
- Smoke-тест фиксирует «ровно 19 инструментов» — сознательный gate поверхности MCP.

### 3.5 Оптимизации MCP-сервера как такового

- Три транспорта в одном процессе (MCP stdio + WS + файл-REPL) — скрипты работают под MCP без отдельного live-repl.
- Файл-REPL с `uncap:true` — большие ответы скриптам идут мимо модели и без резки: тяжёлая работа (скачивание HLS, локализация страниц) выносится из контекста модели в скрипты, которые сами ходят через bridge API. Это ключевая архитектурная оптимизация расхода токенов.
- Один unix-сокет и TCP-слушатель в одном Transport; approvedClients переживает реконнект — рестарт браузера не требует повторного approve.
- Запуск TS напрямую через `tsx` — нет шага сборки сервера.

---

## 4. Неэффективности и анти-паттерны

### Сервер

1. **`tab.list` — последовательный опрос клиентов** (mcp.ts:542–554): `await` в цикле; при N браузерах задержка суммируется, мёртвый-but-active клиент держит до 30-секундного таймаута. Легко параллелится `Promise.all`.
2. **`file.download` — один таймаут 120 с на весь трансфер**, а MCP-клиентский таймаут ~30 с: известный класс ошибок `-32001` на больших файлах (фикс через MCP progress-нотификации в backlog; обход задокументирован: не ретраить, ждать manifest.jsonl).
3. **`findCompleted` — O(manifest) на каждое завершение трансфера**: полное синхронное чтение manifest.jsonl в горячем пути.
4. **Синхронный файловый I/O**: journal/audit/manifest — `appendFileSync` на каждый вызов; блокирует event loop (при лимите 30 act/мин не критично). Аудит пишется на каждый policy-check — при `tab.list` по 10+ вкладкам пачки записей с одним ts.
5. **Кэш снапшотов и реестр вкладок без TTL**: записи удаляются только при `tab.close` агентом; вкладки, закрытые в браузере вручную, остаются до перезапуска.
6. **`policy.status` всегда возвращает полный reminder** (без версионирования) — самый тяжёлый ответ при частых вызовах.
7. **Полная форма policy_reminder включает плейбуки целиком** — при разросшихся заметках заметный токен-расход, смягчённый лишь версионированием П0-1.
8. **`resolveDomain` вызывается дважды на deny-пути** (ради честного hint) — мелочь.
9. **Классификатор — эвристический** (regex по тексту кнопки, рус/eng): нестандартные формулировки или другие языки gated-категорию не поймают (fail-open для `auto`-категорий). Частично компенсируется hard_floor и consent-дефолтами.
10. **Секрет печатается в лог при генерации** (осознанно — нужен для ввода в popup, лог в stderr); TCP-слушатель на `0.0.0.0` с секретом как единственной защитой — при пробросе портов расширяет поверхность.
11. **`allow_10min` и session-гранты только в памяти** — рестарт сервера обнуляет их вместе с approve (фича, но стоит помнить в runbook).
12. **Пагинации нет нигде** — жёсткие потолки (net.list 50, page.find 20, журнал popup 20) вместо курсоров.
13. **`page.scan` помечен untrusted, но живёт в ACT_TOOLS** — требует `interact` + pacing; модель может быть удивлена `CAPABILITY_DENIED` на «читающей» операции.

### Расширение и скрипты

14. **Файл-REPL — polling по ФС** (0.5 с, mtime с точностью 1 с): команда → ответ за 3–8 с; один cmd.json на всех — гонки параллельных команд не защищены; при таймауте скрипт может молча прочитать СТАРЫЙ result.json (проверки «это ответ на мою команду» нет, кроме mtime).
15. ~~**fetchFileRelay держит весь файл в памяти дважды**~~ **ИСПРАВЛЕНО (0.1.5)**: релей перенесён в background (file-relay.js), стриминг getReader() → чанк 256 КБ → ack, sha256 инкрементальный (sha256.js) — файл в память не собирается; заодно закрыт CORS-дефект xet/CDN (cross-origin редиректы из content script резались).
16. ~~**sha256 на http-страницах молча пустой**~~ **ИСПРАВЛЕНО для релея (0.1.5)**: sha256.js — чистый JS, secure context не нужен. Остаток: dom_hash в content script всё ещё через `crypto.subtle` → пустой на http-страницах (влияет только на reconcile при resume).
17. **netLog in-memory**, теряется при рестарте MV3 SW; переживает SPA-навигацию и смешивает media-id разных страниц — фильтрация на агенте.
18. **hls-download.py качает служебные m3u8 через общий downloads/**; variant-мастер при повторном запуске скачивается заново (кэшируются только сегменты и финал).
19. **extractMarkdown клонирует весь скоуп в память** (`cloneNode(true)`); видимость img помечается мутацией оригинального DOM (временный атрибут) — хрупко к исключениям между set/remove.
20. **Один активный waitFor на вкладку и отсутствие очередей**: параллельные file.download сыплются (зафиксировано в плейбуке: «строго последовательно») — осознанно, но узкое место для параллелизма.
21. **Секреты серверов лежат в `storage.local` в открытом виде** (поверхность на машине пользователя).
22. **userscripts/poe-bulk-exporter.user.js**: `@require` с CDN без SRI (supply-chain), соль в коде; вне политики моста.

### Статус плана

- optimization_plan: П0-1…П0-6, П1-1…П1-5, П2-3, П2-4 — реализованы; П2-5 (in-page баннер download-гранта) в backlog.
- План v3: фазы 0–5, 7, 9 — сделано (47/47 серверных тестов); фаза 6 частично; фаза 8 (харденинг: prompt-injection тест, нагрузка 50 страниц) — не начата.

---

## 5. Тестирование

13 тестовых файлов (`node --test` + tsx): `mcp-smoke` (ровно 19 инструментов), `policy` (приёмочные сценарии: DOMAIN_NOT_ALLOWED, consent deny/timeout, login-auto, hot-reload), `relay`, `multi-client` (7 сценариев D1–D7), `stale-retry`, `wait-for`, `batch`, `compress`, `journal` (маскировка паролей), `scan`, `snapshot-format`, `file-repl`. Mock-расширение — полноценный WS-клиент с имитацией чанк-релея и ack.

---

## 6. Общая характеристика

Архитектурный принцип: **«тонкий исполнитель (расширение) при серверном арбитре»** — расширение не хранит и не вычисляет доступы, вся политика на сервере; человек — обязательное звено для сессии, gated-действий и смены пресетов. Безопасность построена слоями: auth → approve → default-deny политика → per-browser изоляция → gating с hard_floor → consent (неподделываемый баннер) → pacing → аудит; семантика ошибок fail-closed/fail-fast. Токен-экономика системная: лимиты на источнике (расширение), дедуп и версионирование на сервере, страховочная резка, вынос тяжёлой работы в скрипты через файл-REPL, измеримость через journal + token-stats.py. Главные узкие места: файловый релей (память, последовательность, таймаут против MCP-клиента) и файл-REPL (polling, отсутствие мультиплексирования).
