# MCP Browser Bridge

Мост между AI-агентом (Kimi Code CLI в контейнере ExitBox) и реальными
браузерами пользователя (Firefox / LibreWolf и Chromium — одновременно,
фаза 9). Агент читает страницы и действует в них через MCP-инструменты —
строго в рамках политики, которую контролирует человек.

## Коротко для профессионала

- **Три компонента**: `bridge-server/` (Node ≥22, TypeScript через `tsx`,
  MCP-сервер по stdio + WS-эндпоинт + policy engine), `extension/`
  (общая кодовая база, две сборки: Firefox MV2 persistent background и
  Chromium MV3 service worker — `extension/build-chromium.sh` → `dist/chromium/`),
  `policy.yaml` (единственный источник правил безопасности, hot-reload).
- **Мульти-браузер**: один сервер обслуживает несколько браузеров сразу;
  доступы per-browser (грант Firefox не действует в Chromium — см. PROTOCOL.md
  §11); неподключённый браузер «молчит», остальные работают.
- **Мульти-агент**: расширение держит несколько серверных подключений;
  вкладка — единица изоляции (владелец-агент, `TAB_NOT_OWNED` чужим).
- **Транспорт**: rootless podman не маршрутизирует сеть контейнера до
  хоста, поэтому сервер слушает unix-сокет `.bridge/bridge.sock` в общей
  bind-mount папке; на хосте `socat` релеит его в `127.0.0.1:18777`.
- **Безопасность**: default-deny по доменам, подтверждение новой сессии
  один раз на контейнер, gated-действия (pay/login/submit/delete) через
  баннер согласия, авто-пауза на капче/2FA, глобальная пауза в popup.
- **Протокол**: одна WS-строка = одно JSON-сообщение (`req`/`res`/`evt`),
  файловый релей чанками 256 КБ с ack-backpressure — см. `PROTOCOL.md`.
- **Чтение страниц**: семантический snapshot с ref-метками
  (`page.snapshot`), extract в markdown (`page.extract`); действия —
  `act.*` по ref; ref инвалидируется при SPA-перерисовке (`STALE_REF`).
- **Скачивание**: файлы прилетают по WS в `downloads/` контейнера, а не в
  папку загрузок браузера; манифест — `downloads/manifest.jsonl`.

## Где что запускается

| Компонент | Система | Команда / действие |
|---|---|---|
| контейнер ExitBox | хост (папка проекта) | `exitbox run kimi --no-resume -- --yolo` |
| bridge-server | контейнер | `cd <репо>/bridge-server && npm install && npm start` (пути данных — от корня репо, без env) |
| socat-релей | хост (Linux, любой каталог) | `bash <репо>/start-relay.sh` (сам находит сокет, ждёт его до 120 с) |
| расширение (Firefox / LibreWolf) | хост | `about:debugging` → Load Temporary Add-on → `extension/manifest.json` |
| расширение (Chromium) | хост | `bash extension/build-chromium.sh` → `chrome://extensions` → Developer mode → Load unpacked → `dist/chromium/` |
| Kimi Code CLI | контейнер | подхватывает сервер как MCP из `.kimi-code/mcp.json` автоматически |

## Быстрый старт (пошагово)

Полная инструкция с отладкой — в **[SETUP.md](SETUP.md)**. Здесь минимум.

**1. Хост → контейнер** — из папки проекта на хосте запусти контейнер:

```bash
exitbox run kimi --no-resume -- --yolo
```

Папка проекта монтируется в контейнер как `/workspace`. Внутри один раз
поставь зависимости — дальше сервер поднимает сам Kimi Code CLI как
MCP-сервер (конфиг `.kimi-code/mcp.json`):

```bash
cd /workspace/mcp-browser-bridge/bridge-server && npm install   # один раз
npm start   # только для запуска вручную, без Kimi Code CLI
```

Сервер создаст `.bridge/bridge.sock` и `.bridge/secret` (0600) в корне
репозитория — все пути он считает от своего расположения (`REPO_ROOT` в
`src/index.ts`), перенос репо ничего не ломает. Секрет постоянный между
пересозданиями контейнера — понадобится на шаге 3.

**2. Хост** — релей сокета в TCP (из любого каталога, оставить работать;
сокет появится только когда поднимется сервер — скрипт его подождёт):

```bash
bash /путь/к/mcp-browser-bridge/start-relay.sh
```

Проверка: `curl 127.0.0.1:18777` → `426 Upgrade Required` — значит живо.

**3. Хост, браузер** — расширение (для каждого браузера своё):

- **Firefox / LibreWolf**: `about:debugging#/runtime/this-firefox` →
  **Load Temporary Add-on** → `extension/manifest.json`. (Временное:
  слетает при перезапуске браузера — загружай заново.)
- **Chromium**: `bash extension/build-chromium.sh` (соберёт `dist/chromium/`)
  → `chrome://extensions` → Developer mode → **Load unpacked** →
  `dist/chromium/`. Постоянная установка, флаги не нужны (MV3).

Дальше в popup каждого браузера: **Настройки** → добавить сервер (URL уже
предзаполнен `ws://127.0.0.1:18777`, вставь секрет из `.bridge/secret`) →
**«Выдать доступ к сайтам»** (`<all_urls>`, один раз; реальный доступ всё
равно режет `policy.yaml`). Подтверждение сессии — per-browser: каждый
браузер подтверждает своё подключение из своего popup.

**4. Подтверждение сессии.** При первом подключении нового контейнера popup
покажет «Новая сессия агента — разрешить?». Подтверждается **один раз на
контейнер**; перезапуск браузера подтверждения не требует, перезапуск
сервера — требует.

**5. Готово.** Давай агенту задачу — правила из `policy.yaml` применяются
автоматически.

## Использование

- **Агенту** доступен 22 MCP-инструмента: `policy.status`,
  `policy.request_preset`, `tab.list` / `tab.open` / `tab.close`,
  `page.snapshot` / `page.extract` / `page.find` / `page.screenshot` /
  `page.wait_for` / `page.scan` / `page.console` / `page.eval`, `act.click` / `act.hover` /
  `act.type` / `act.select` / `act.scroll` / `act.key` / `act.batch`,
  `file.download`, `net.list`
  (в Chromium недоступен — нет webRequest в MV3 service worker).
  У tab-инструментов опциональный параметр `browser` (`firefox`/`chromium`).
  Ответ каждого — `{ok, data|error_code, hint, policy_reminder}`.
- **Человеку** — popup расширения: список серверов-подключений (мульти-
  агент), переключение пресета, разовые гранты доменам (read / interact /
  download, per-browser), назначение вкладки агенту, красная кнопка
  **ПАУЗА**, журнал последних 20 действий, возобновление авто-пауз.
- **Правила** — только `policy.yaml`: пресеты доменов, capabilities,
  gated-категории, pacing. Hot-reload: сохранил файл — расширение и агент
  получили обновление.
- **Новый сайт — типовой рецепт.** Разовый доступ — popup «Выдать доступ к
  сайтам» (read / interact / download, per-browser, на сессию). Постоянный —
  домен в `policy.yaml` по шаблону:

  ```yaml
  presets:
    dev:   # или свой пресет
      domains:
        "example.com":
          capabilities: [read, interact, download, eval]
          gated: { eval: confirm }   # каждое внедрение JS — с подтверждением
  ```

  `eval` — для `page.eval` (внутренние API сайта, разработка юзерскриптов);
  popup его не выдаёт принципиально, только YAML и только человек. Если eval
  не нужен — убрать его из `capabilities` и убрать строку `gated` целиком.
  При вызове `page.eval` обязателен осмысленный `description` (1–2 предложения
  простым языком, что делает скрипт) — он показывается в баннере подтверждения
  первым; сам expression снабжай комментарием-шапкой.
- **Баннер download-гранта (П2-5)**: `file.download` на домене без гранта
  (или без capability download) показывает на вкладке баннер «Разрешить
  скачивание (на сессию)» — session-грант выдаётся на месте, без похода в
  popup, и загрузка продолжается без ретрая агента. «Запретить» или таймаут —
  исходная ошибка агенту, повторные обращения к этому домену 10 минут идут
  уже без баннера (deny-кэш).
- Ошибки gating (`ACTION_DENIED`, `PAUSED`, `DOMAIN_NOT_ALLOWED`…) — это
  стоп и доклад пользователю, а не повторные попытки (на `file.download`
  перед ошибкой сначала отрабатывает баннер гранта — выше).

## Структура репозитория

```
bridge-server/   MCP-сервер + WS + policy engine (src/*.ts), тесты, скрипты
extension/       расширение (общая кодовая база): Firefox MV2 грузится отсюда
                 напрямую, Chromium MV3 — сборка build-chromium.sh → dist/
extension/test/  unit-тесты расширения (node --test, без браузера)
dist/chromium/   сборка для Chromium (генерируется, в git не идёт)
policy.yaml      политика безопасности (правит только человек)
memory/          заметки агента: global-notes.md (в git), domains/*.md (локально)
downloads/       файлы, скачанные агентом через браузер
.bridge/         рантайм: bridge.sock, secret, cmd/result для live-REPL
SETUP.md         подробная установка и отладка
PROTOCOL.md      контракт WS-сообщений, коды ошибок, форматы
ENVIRONMENT.md   верификация среды (чеклист хоста)
```

## Разработка

```bash
cd bridge-server
npm test                                   # 47 тестов: policy, транспорт, MCP, релей, мультиклиент
node --test 'extension/test/**/*.test.mjs' # 31 тест расширения (шим, инжектор, owners, keepalive)
```

Живая отладка из контейнера без MCP-клиента:
`bridge-server/scripts/live-repl.mjs` (in-process сервер без MCP).
Файл-REPL (`.bridge/cmd.json` → `.bridge/result.json`) встроен в сам
MCP-сервер — скрипты `hls-download.py` / `localize-page.py` работают и под
MCP-сессией; live-repl нужен, только когда MCP не поднят (сокет один,
вместе они не запустятся).

> **Reload расширения**: открытые вкладки грантованных доменов
> переинжектируются автоматически при первом policy.update (П2-6); если
> вкладка «не отвечает» (CONTENT_SCRIPT_ABSENT) — перезагрузи её (F5).

## Ограничения

Только верхний фрейм (без iframe). В Chromium не работает `net.list`
(нет webRequest bindings в MV3 service worker — HLS-сниффинг делай из
Firefox). Firefox-расширение — временное (слетаёт при перезапуске
браузера; постоянная установка — `web-ext sign --channel unlisted`).
Дальше по плану — `kimi-code-browser-bridge-plan.md`.
