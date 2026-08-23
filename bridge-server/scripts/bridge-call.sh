#!/bin/bash
# Вызов инструмента моста через файл-REPL. Аргументы: JSON команды, таймаут ожидания (с).
set -e
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CMD="$ROOT/.bridge/cmd.json"
RES="$ROOT/.bridge/result.json"
WAIT="${2:-6}"
before=$(stat -c '%Y' "$RES" 2>/dev/null || echo 0)
echo "$1" > "$CMD"
for i in $(seq 1 $((WAIT * 2))); do
  sleep 0.5
  [ ! -f "$CMD" ] && [ "$(stat -c '%Y' "$RES")" != "$before" ] && break
done
cat "$RES"
