#!/usr/bin/env bash
# build-chromium.sh — сборка MV3-варианта расширения для Chromium (D10).
# Копия extension/{src, sw-loader.js} → <корень репо>/dist/chromium/,
# manifest.json подменяется на manifest.chromium.json. Идемпотентно.
# Пути — относительно расположения скрипта: работает и в контейнере
# (/workspace), и на хосте (~/.../mcp-browser-bridge).
# Внешних зависимостей нет; валидация JSON — node или python3 (что есть).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$SRC_DIR/../dist/chromium"

rm -rf "$DIST"
mkdir -p "$DIST"
cp -r "$SRC_DIR/src" "$DIST/src"
cp "$SRC_DIR/sw-loader.js" "$DIST/sw-loader.js"
cp "$SRC_DIR/manifest.chromium.json" "$DIST/manifest.json"

if command -v node >/dev/null 2>&1; then
  node -e "JSON.parse(require('fs').readFileSync('$DIST/manifest.json','utf8')); console.log('manifest.json: валидный JSON')"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "import json; json.load(open('$DIST/manifest.json')); print('manifest.json: валидный JSON')"
else
  echo "предупреждение: ни node, ни python3 не найдены — JSON не проверен" >&2
fi

echo "Собрано: $DIST"
