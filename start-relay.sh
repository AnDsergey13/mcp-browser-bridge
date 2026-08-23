#!/bin/sh
# start-relay.sh — socat-релей на ХОСТЕ: 127.0.0.1:18777 → unix-сокет моста.
# Запускать откуда угодно (путь до репо не важен — скрипт сам находит свой
# каталог), оставить работать:
#   bash /путь/к/mcp-browser-bridge/start-relay.sh
# Ждёт появления сокета до 120 с (сервер поднимается контейнером асинхронно),
# поэтому релей можно стартовать до контейнера. Проверка:
#   curl 127.0.0.1:18777  →  426 Upgrade Required
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOCK="$DIR/.bridge/bridge.sock"
i=0
while [ ! -S "$SOCK" ]; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    echo "start-relay: сокет не появился за 120 с: $SOCK (bridge-server запущен?)" >&2
    exit 1
  fi
  sleep 1
done
exec socat TCP-LISTEN:18777,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:"$SOCK"
