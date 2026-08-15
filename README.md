# MCP Browser Bridge

Мост между AI-агентом (Kimi Code CLI в контейнере ExitBox) и реальным
браузером пользователя (Firefox / LibreWolf). Агент читает страницы и
действует в них через MCP-инструменты — строго в рамках политики, которую
контролирует человек.

## Коротко для профессионала

- **Три компонента**: `bridge-server/` (Node ≥22, TypeScript через `tsx`,
  MCP-сервер по stdio + WS-эндпоинт + policy engine), `extension/`
  (Firefox MV2, persistent background), `policy.yaml` (единственный
  источник правил безопасности, hot-reload).
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
| bridge-server | контейнер (`/workspace`) | `cd bridge-server && npm install && npm start` |
| socat-релей | хост (Linux, папка проекта) | `socat TCP-LISTEN:18777,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:$PWD/.bridge/bridge.sock` |
| расширение | хост, Firefox / LibreWolf | `about:debugging` → Load Temporary Add-on → `extension/manifest.json` |
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
cd /workspace/bridge-server && npm install   # один раз
npm start   # только для запуска вручную, без Kimi Code CLI
```

Сервер создаст `.bridge/bridge.sock` и `.bridge/secret` (0600). Секрет
постоянный между пересозданиями контейнера — понадобится на шаге 3.

**2. Хост** — релей сокета в TCP (оставить работать):

```bash
socat TCP-LISTEN:18777,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:$PWD/.bridge/bridge.sock
```

Проверка: `curl 127.0.0.1:18777` → `426 Upgrade Required` — значит живо.

**3. Хост, браузер** — расширение:

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
   `extension/manifest.json`. (Временное: слетает при перезапуске
   браузера — загружай заново.)
2. Popup расширения → **Настройки**: URL `ws://127.0.0.1:18777`, секрет из
   `.bridge/secret` → Сохранить.
3. Там же — **«Выдать доступ к сайтам»** (`<all_urls>`, один раз; реальный
   доступ всё равно режет `policy.yaml`).

**4. Подтверждение сессии.** При первом подключении нового контейнера popup
покажет «Новая сессия агента — разрешить?». Подтверждается **один раз на
контейнер**; перезапуск браузера подтверждения не требует, перезапуск
сервера — требует.

**5. Готово.** Давай агенту задачу — правила из `policy.yaml` применяются
автоматически.

## Использование

- **Агенту** доступны 16 MCP-инструментов: `policy.status`,
  `policy.request_preset`, `tab.list` / `tab.open` / `tab.close`,
  `page.snapshot` / `page.extract` / `page.find` / `page.screenshot`,
  `act.click` / `act.type` / `act.select` / `act.scroll` / `act.key`,
  `file.download`, `net.list`. Ответ каждого — `{ok, data|error_code,
  hint, policy_reminder}`.
- **Человеку** — popup расширения: переключение пресета, разовые гранты
  доменам (read / interact / download), красная кнопка **ПАУЗА**, журнал
  последних 20 действий, возобновление авто-пауз.
- **Правила** — только `policy.yaml`: пресеты доменов, capabilities,
  gated-категории, pacing. Hot-reload: сохранил файл — расширение и агент
  получили обновление.
- Ошибки gating (`ACTION_DENIED`, `PAUSED`, `DOMAIN_NOT_ALLOWED`…) — это
  стоп и доклад пользователю, а не повторные попытки.

## Структура репозитория

```
bridge-server/   MCP-сервер + WS + policy engine (src/*.ts), тесты, скрипты
extension/       расширение Firefox MV2 (background, content scripts, popup)
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
npm test    # 18 тестов: policy engine, транспорт, MCP-слой, файл-REPL
```

Живая отладка из контейнера без MCP-клиента:
`bridge-server/scripts/live-repl.mjs` (in-process сервер без MCP).
Файл-REPL (`.bridge/cmd.json` → `.bridge/result.json`) встроен в сам
MCP-сервер — скрипты `hls-download.py` / `localize-page.py` работают и под
MCP-сессией; live-repl нужен, только когда MCP не поднят (сокет один,
вместе они не запустятся).

> **Reload расширения ≠ обновление content scripts**: после Reload в
> `about:debugging` уже открытые вкладки выполняют старый код —
> перезагрузи вкладку (F5).

## Ограничения MVP

Firefox-семейство (порт на Chromium позже — браузерозависимая инжекция
вынесена в `extension/src/injector.js`); временное расширение без
постоянной установки; скриншот без даунскейла; один файловый трансфер за
раз; только верхний фрейм (без iframe). Дальше по плану —
`kimi-code-browser-bridge-plan.md`.
