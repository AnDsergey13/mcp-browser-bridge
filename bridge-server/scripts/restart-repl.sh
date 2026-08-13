#!/bin/sh
# Перезапуск live-repl сервера моста (избегаем pkill-самосовпадений).
pkill -f 'live-repl\.mjs' 2>/dev/null
sleep 1
cd /workspace/bridge-server
nohup node --import tsx scripts/live-repl.mjs > /tmp/live-repl.log 2>&1 &
sleep 3
tail -5 /tmp/live-repl.log
