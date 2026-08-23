/* MV3 service worker-обёртка (D10): классический SW, скрипты подключаются
 * importScripts'ом (без "type":"module" — так проще и поддерживается MV3).
 * Порядок важен: compat-browser.js первым (шим глобала `browser` поверх
 * chrome.*), далее чистые модули (config/owners/keepalive), injector,
 * sha256 + file-relay (файловый релей в background), background — последним
 * (регистрирует слушатели синхронно, top-level). */
"use strict";

importScripts(
  "src/compat-browser.js",
  "src/config.js",
  "src/owners.js",
  "src/keepalive.js",
  "src/injector.js",
  "src/sha256.js",
  "src/file-relay.js",
  "src/background.js"
);
