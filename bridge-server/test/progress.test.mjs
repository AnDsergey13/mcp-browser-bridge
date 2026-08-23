// progress.test.mjs — П.5: MCP notifications/progress для file.download.
// Сквозной тест на InMemoryTransport: SDK-клиент с коротким timeout +
// resetTimeoutOnProgress доживает до конца медленного трансфера (прогресс
// сбрасывает таймаут); контроль без resetTimeoutOnProgress ловит -32001;
// без progressToken сервер нотификаций не шлёт. Плюс юниты: троттлинг
// makeProgressReporter и per-chunk прогресс в DownloadRelay.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeTempEnv, startTestBridge, waitFor } from './helpers.mjs';
import { MockExtension } from './mock-extension.mjs';
import { buildMcpServer, makeProgressReporter } from '../src/mcp.ts';
import { DownloadRelay } from '../src/downloads.ts';

const cleanups = [];
const t0 = { after: (fn) => cleanups.push(fn) };

let env, handle, mock, mcpServer, client;
const FILE_CONTENT = crypto.randomBytes(3000); // 15 чанков по 200 байт × 100 мс ≈ 1.5 с

before(async () => {
  env = makeTempEnv(t0);
  handle = await startTestBridge(t0, env);
  mock = new MockExtension({
    secret: env.secret,
    tabs: [{ tabId: 1, url: 'http://allowed.example/page', title: 'Allowed' }],
    fileToServe: { name: 'big.bin', content: FILE_CONTENT, chunkSize: 200, chunkDelayMs: 100 },
  });
  await mock.connect(handle.port);
  await mock.approve();
  const list = await handle.core.callTool('tab.list', {});
  assert.equal(list.ok, true);

  // MCP-сервер поверх InMemoryTransport; троттлинг 50 мс вместо боевой 1 с.
  mcpServer = buildMcpServer(handle.core, { progressMinIntervalMs: 50 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  client = new Client({ name: 'progress-test', version: '0.0.1' });
  await client.connect(clientTransport);
});

after(async () => {
  try { await client?.close(); } catch { /* ignore */ }
  try { await mcpServer?.close(); } catch { /* ignore */ }
  mock?.close();
  for (const fn of cleanups.reverse()) await fn();
});

test('file.download: resetTimeoutOnProgress — медленный трансфер завершается без -32001', async () => {
  const progressEvents = [];
  const result = await client.callTool(
    { name: 'file.download', arguments: { tabId: 1, url: 'http://allowed.example/files/big.bin', name: 'big.bin' } },
    undefined,
    {
      timeout: 400, // без прогресса запрос умер бы через 400 мс, трансфер ~1.5 с
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 20000, // страховка от вечного теста
      onprogress: (p) => progressEvents.push(p),
    },
  );
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.data.size, FILE_CONTENT.length);
  assert.ok(fs.existsSync(path.join(env.downloadsDir, payload.data.file)));

  // Прогресс шёл: несколько событий, монотонно растущий progress, total = размер.
  assert.ok(progressEvents.length >= 2, `прогресс-события: ${progressEvents.length}`);
  for (let i = 0; i < progressEvents.length; i++) {
    assert.equal(progressEvents[i].total, FILE_CONTENT.length);
    if (i > 0) assert.ok(progressEvents[i].progress > progressEvents[i - 1].progress, 'progress растёт');
  }
  assert.ok(progressEvents.at(-1).progress > 0);
}, { timeout: 30000 });

test('file.download: контроль — без resetTimeoutOnProgress таймаут -32001 остаётся', async () => {
  const progressEvents = [];
  await assert.rejects(
    client.callTool(
      { name: 'file.download', arguments: { tabId: 1, url: 'http://allowed.example/files/big2.bin', name: 'big2.bin' } },
      undefined,
      { timeout: 400, onprogress: (p) => progressEvents.push(p) },
    ),
    (err) => err.code === -32001,
    'ожидался RequestTimeout (-32001)',
  );
  // Прогресс сервер слал (токен был) — но клиентский таймаут не сбрасывался.
  assert.ok(progressEvents.length >= 1, 'прогресс-нотификации доходили и здесь');
  // Трансфер доживает в фоне — задокументированное поведение: ждём запись в manifest.
  await waitFor(() => {
    const mf = path.join(env.downloadsDir, 'manifest.jsonl');
    if (!fs.existsSync(mf)) return false;
    return fs.readFileSync(mf, 'utf8').includes('"big2.bin"');
  });
}, { timeout: 30000 });

test('file.download: без progressToken (нет onprogress) сервер нотификаций не шлёт', async () => {
  const stray = [];
  client.setNotificationHandler(ProgressNotificationSchema, (n) => { stray.push(n); });
  try {
    mock.fileToServe = { name: 'quick.bin', content: crypto.randomBytes(600), chunkSize: 200 };
    const result = await client.callTool(
      { name: 'file.download', arguments: { tabId: 1, url: 'http://allowed.example/files/quick.bin', name: 'quick.bin' } },
      undefined,
      { timeout: 15000 }, // без onprogress → без progressToken в _meta
    );
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(stray.length, 0, 'без progressToken notifications/progress не отправляются');
  } finally {
    client.removeNotificationHandler(ProgressNotificationSchema);
    mock.fileToServe = { name: 'big.bin', content: FILE_CONTENT, chunkSize: 200, chunkDelayMs: 100 };
  }
}, { timeout: 30000 });

test('makeProgressReporter: первое событие сразу, дальше троттлинг по интервалу', async () => {
  const sent = [];
  let now = 0;
  const report = makeProgressReporter(async (n) => { sent.push(n); }, 'tok-1', 1000, () => now);
  report(100, 1000);            // t=0 — первое, шлём сразу
  report(200, 1000);            // t=0 — внутри окна, пропуск
  now = 999;
  report(300, 1000);            // ещё внутри окна
  now = 1000;
  report(400, 1000);            // окно прошло — шлём
  now = 5000;
  report(500, null);            // total неизвестен — поля total нет
  assert.equal(sent.length, 3);
  assert.equal(sent[0].method, 'notifications/progress');
  assert.deepEqual(sent[0].params, { progressToken: 'tok-1', progress: 100, total: 1000 });
  assert.deepEqual(sent[1].params, { progressToken: 'tok-1', progress: 400, total: 1000 });
  assert.deepEqual(sent[2].params, { progressToken: 'tok-1', progress: 500 });
});

test('makeProgressReporter: ошибка отправки не пробрасывается в трансфер', () => {
  const report = makeProgressReporter(async () => { throw new Error('client gone'); }, 'tok-2', 1000);
  assert.doesNotThrow(() => report(1, 10));
});

test('DownloadRelay: onProgress вызывается на каждый чанк с накопленными байтами', async () => {
  const relay = new DownloadRelay({ downloadsDir: env.downloadsDir, log: () => {}, sendAck: () => {} });
  const seen = [];
  const done = relay.expectTransfer('http://x/f.bin', 'c1', (bytes, total) => seen.push([bytes, total]));
  relay.handleEvent('file.start', { transferId: 'tx_prog', name: 'f.bin', size: 6 }, 'c1');
  relay.handleEvent('file.chunk', { transferId: 'tx_prog', seq: 0, data_base64: Buffer.from('abc').toString('base64') }, 'c1');
  relay.handleEvent('file.chunk', { transferId: 'tx_prog', seq: 1, data_base64: Buffer.from('def').toString('base64') }, 'c1');
  relay.handleEvent('file.end', { transferId: 'tx_prog' }, 'c1');
  const completed = await done;
  assert.equal(completed.size, 6);
  assert.deepEqual(seen, [[3, 6], [6, 6]]);
});

test('DownloadRelay: трансфер без ожидания file.download — прогресса нет, ничего не падает', () => {
  const relay = new DownloadRelay({ downloadsDir: env.downloadsDir, log: () => {}, sendAck: () => {} });
  relay.handleEvent('file.start', { transferId: 'tx_orphan', name: 'orphan.bin', size: 3 }, 'c1');
  relay.handleEvent('file.chunk', { transferId: 'tx_orphan', seq: 0, data_base64: Buffer.from('abc').toString('base64') }, 'c1');
  relay.handleEvent('file.end', { transferId: 'tx_orphan' }, 'c1');
});
