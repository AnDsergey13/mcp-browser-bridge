// relay.test.mjs — file.download сквозной: mock-extension отдаёт файл чанками,
// сервер пишет в downloads (тестовый temp-dir), sha256 сходится, manifest пополнен.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeTempEnv, startTestBridge } from './helpers.mjs';
import { MockExtension } from './mock-extension.mjs';

const t0 = { after: (fn) => cleanups.push(fn) };
const cleanups = [];

let env, handle, mock;
const FILE_CONTENT = crypto.randomBytes(1500); // 4 чанка по 400 байт

before(async () => {
  env = makeTempEnv(t0);
  handle = await startTestBridge(t0, env);
  mock = new MockExtension({
    secret: env.secret,
    tabs: [
      { tabId: 1, url: 'http://allowed.example/page', title: 'Allowed' },
      { tabId: 2, url: 'http://readonly.example/page', title: 'Readonly' },
    ],
    fileToServe: { name: 'lesson.pdf', content: FILE_CONTENT, chunkSize: 400 },
  });
  await mock.connect(handle.port);
  await mock.approve();
  const list = await handle.core.callTool('tab.list', {});
  assert.equal(list.ok, true);
});

after(async () => {
  mock?.close();
  for (const fn of cleanups.reverse()) await fn();
});

test('file.download: файл на диске, sha256 сходится, manifest пополнен', async () => {
  const res = await handle.core.callTool('file.download', {
    tabId: 1, url: 'http://allowed.example/files/lesson.pdf', name: 'lesson.pdf',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const filePath = path.join(env.downloadsDir, res.data.file);
  assert.ok(fs.existsSync(filePath), `файл ${res.data.file} на диске`);
  const onDisk = fs.readFileSync(filePath);
  assert.deepEqual(onDisk, FILE_CONTENT);
  const sha = crypto.createHash('sha256').update(onDisk).digest('hex');
  assert.equal(res.data.sha256, sha);
  assert.equal(res.data.size, FILE_CONTENT.length);

  const manifest = fs.readFileSync(path.join(env.downloadsDir, 'manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const entry = manifest.find((l) => l.name === res.data.file);
  assert.ok(entry, 'строка в manifest.jsonl');
  assert.equal(entry.status, 'ok');
  assert.equal(entry.sha256, sha);
  assert.equal(entry.size, FILE_CONTENT.length);
  assert.match(entry.url, /allowed\.example/);
});

test('file.download: повторное скачивание → uniquify имени', async () => {
  const res = await handle.core.callTool('file.download', {
    tabId: 1, url: 'http://allowed.example/files/lesson.pdf', name: 'lesson.pdf',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.data.file, /lesson \(1\)\.pdf/);
});

test('file.download без capability download → CAPABILITY_DENIED', async () => {
  const res = await handle.core.callTool('file.download', {
    tabId: 2, url: 'http://readonly.example/files/x.pdf', name: 'x.pdf',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'CAPABILITY_DENIED');
});
