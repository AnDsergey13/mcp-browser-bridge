// live-repl.mjs — сервер in-process + файл-REPL для живой отладки моста.
// Читает команды из /workspace/.bridge/cmd.json {"tool":"...","args":{...}},
// результат пишет в /workspace/.bridge/result.json, cmd.json удаляет.
// Запуск: node --import tsx scripts/live-repl.mjs
import fs from 'node:fs';
import { startBridge } from '../src/index.ts';

const CMD = '/workspace/.bridge/cmd.json';
const RES = '/workspace/.bridge/result.json';
const log = (msg) => console.error(`[live-repl] ${msg}`);

const handle = await startBridge({ mcp: false });
log('сервер поднят, жду active (подтверди сессию в popup)…');

try { fs.unlinkSync(CMD); } catch { /* ок */ }

setInterval(async () => {
  if (!fs.existsSync(CMD)) return;
  let cmd;
  try { cmd = JSON.parse(fs.readFileSync(CMD, 'utf8')); } catch { return; }
  fs.unlinkSync(CMD);
  if (handle.transport.state !== 'active') {
    fs.writeFileSync(RES, JSON.stringify({ ok: false, error_code: 'SESSION_NOT_ACTIVE', state: handle.transport.state }));
    return;
  }
  try {
    const payload = await handle.core.callTool(cmd.tool, cmd.args ?? {});
    fs.writeFileSync(RES, JSON.stringify(payload, null, 2));
  } catch (e) {
    fs.writeFileSync(RES, JSON.stringify({ ok: false, error_code: 'DRIVER_ERROR', message: String(e) }));
  }
  log(`выполнено: ${cmd.tool}`);
}, 700);

log(`REPL готов: пиши {"tool","args"} в ${CMD}`);
