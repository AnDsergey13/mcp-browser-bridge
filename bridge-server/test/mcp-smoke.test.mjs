// mcp-smoke.test.mjs — сервер как subprocess: JSON-RPC initialize + tools/list
// + tools/call policy.status по stdio.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_POLICY } from './helpers.mjs';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

function rpc(client, method, params, id) {
  return client.request({ jsonrpc: '2.0', id, method, params });
}

test('MCP stdio: initialize, tools/list (22 инструмента), tools/call policy.status', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-smoke-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.yaml'), TEST_POLICY);
  fs.writeFileSync(path.join(dir, 'secret'), 'smoke-secret\n', { mode: 0o600 });

  const port = 18600 + (process.pid % 900);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_POLICY_PATH: path.join(dir, 'policy.yaml'),
      BRIDGE_MEMORY_DIR: path.join(dir, 'memory'),
      BRIDGE_DOWNLOADS_DIR: path.join(dir, 'downloads'),
      BRIDGE_SECRET_PATH: path.join(dir, 'secret'),
      BRIDGE_UNIX_SOCKET: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cleanups.push(() => { child.kill('SIGTERM'); });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  // Мини JSON-RPC клиент поверх stdio (newline-delimited JSON).
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const client = {
    request(msg) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('rpc timeout: ' + msg.method + '\nstderr: ' + stderr)), 20000);
        pending.set(msg.id, (res) => { clearTimeout(timer); resolve(res); });
        child.stdin.write(JSON.stringify(msg) + '\n');
      });
    },
  };

  const init = await rpc(client, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0.0.1' },
  }, 1);
  assert.equal(init.result.serverInfo.name, 'bridge-server');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc(client, 'tools/list', {}, 2);
  const names = list.result.tools.map((tool) => tool.name).sort();
  assert.equal(names.length, 22, 'ровно 22 инструмента: ' + names.join(','));
  for (const expected of [
    'tab.list', 'tab.open', 'tab.close', 'page.snapshot', 'page.extract', 'page.find',
    'page.screenshot', 'page.wait_for', 'page.scan', 'page.console', 'page.eval', 'act.click', 'act.hover',
    'act.type', 'act.select', 'act.scroll', 'act.key',
    'act.batch', 'file.download', 'net.list', 'policy.status', 'policy.request_preset',
  ]) {
    assert.ok(names.includes(expected), `инструмент ${expected}`);
  }

  const call = await rpc(client, 'tools/call', { name: 'policy.status', arguments: {} }, 3);
  const payload = JSON.parse(call.result.content[0].text);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.data.preset, 'test');
  assert.equal(payload.data.session_state, 'offline'); // расширение не подключено
  assert.deepEqual(payload.data.paused, { global: false, auto_tabs: [] });
  assert.equal(payload.policy_reminder.preset, 'test');
}, { timeout: 60000 });
