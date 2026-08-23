# Тесты расширения (без браузера)

Запуск из корня репозитория:

```bash
node --test 'extension/test/**/*.test.mjs'
# или
node --test extension/test/*.test.mjs
# или из каталога тестов — дефолтный паттерн runner'а:
cd extension/test && node --test
```

NB: буквальная форма `node --test extension/test/` (каталог позиционным
аргументом) на Node v22.23.2 НЕ работает — runner принимает позиционные
аргументы за glob-паттерны и пытается исполнить сам каталог как модуль
(MODULE_NOT_FOUND). Это особенность версии Node, а не тестов; рабочие формы —
выше, все 48 тестов зелёные.

Моки (`helpers.mjs`): глобалы `chrome`/`browser`, storage.local, события
(`makeEvent().fire(...)`). Скрипты расширения — не ESM, поэтому грузятся в
vm-песочницу (`loadScript`) с подменёнными глобалами.

Покрытие:
- `compat-browser.test.mjs` — шим browser→chrome (no-op в Firefox, промисы,
  lastError→reject, onMessage promise→sendResponse, executeScript→scripting);
- `injector.test.mjs` — ветки firefox/mv3, applyPolicy/unregister, needHostPermission;
- `owners.test.mjs` — владение вкладками (TAB_NOT_OWNED, авто-назначение,
  default-deny, popup-назначение, очистка);
- `config.test.mjs` — миграция конфига single→list;
- `keepalive.test.mjs` — alarms-keepalive MV3 service worker.
- `file-relay.test.mjs` — фоновый файловый релей: вектора SHA-256 (sha256.js),
  потоковая сборка чанков из fake ReadableStream, backpressure по ack,
  ранний res после заголовков, маппинг ошибок (HTTP/сеть/сбой стрима),
  подмена Referer/Origin через webRequest.
