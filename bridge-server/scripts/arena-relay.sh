#!/bin/bash
# arena-relay.sh — релей шины audit-bus между репозиторием (куратор) и
# staging-папкой атакующего (ExitBox). Нужен ТОЛЬКО если в ExitBox
# недоступен флаг -i/--include-dir (предпочтительный путь — прямой mount).
#
# usage: arena-relay.sh /path/to/repo /path/to/staging-арены
set -u
REPO="${1:?укажи путь к репозиторию}"
STAGE="${2:?укажи путь к staging-папке атакующего}"
mkdir -p "$REPO/.bridge/audit-bus" "$STAGE/audit-bus"
echo "relay: $REPO/.bridge/audit-bus <-> $STAGE/audit-bus  (Ctrl+C — стоп)"
while true; do
  # attacker -> curator (только обычные файлы, не symlink'и)
  for f in manifest.json attack-ready; do
    if [ -f "$STAGE/audit-bus/$f" ] && [ ! -L "$STAGE/audit-bus/$f" ]; then
      cp -u "$STAGE/audit-bus/$f" "$REPO/.bridge/audit-bus/" 2>/dev/null
    fi
  done
  # curator -> attacker
  for f in "$REPO"/.bridge/audit-bus/verdicts-*.json; do
    [ -f "$f" ] && cp -u "$f" "$STAGE/audit-bus/" 2>/dev/null
  done
  sleep 5
done
