// live-repl.mjs — сервер in-process БЕЗ MCP + файл-REPL для живой отладки
// моста. Файл-REPL сам встроен в startBridge (opts.fileRepl): читает команды
// из /workspace/.bridge/cmd.json {"tool":"...","args":{...}}, результат пишет
// в /workspace/.bridge/result.json, cmd.json удаляет.
// Запуск: node --import tsx scripts/live-repl.mjs
// ВНИМАНИЕ: слушает тот же .bridge/bridge.sock, что и MCP-сервер — вместе
// не запустятся (EADDRINUSE). Нужен только когда сессия без MCP.
import { startBridge } from '../src/index.ts';

const log = (msg) => console.error(`[live-repl] ${msg}`);

await startBridge({ mcp: false, fileRepl: '/workspace/.bridge/cmd.json' });
log('сервер поднял (file-repl включён), жду active (подтверди сессию в popup)…');
