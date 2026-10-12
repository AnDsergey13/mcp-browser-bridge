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

test('file.download: повтор идентичного файла → dedup (существующее имя)', async () => {
  const res = await handle.core.callTool('file.download', {
    tabId: 1, url: 'http://allowed.example/files/lesson.pdf', name: 'lesson.pdf',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  // П0-6: тот же url + тот же контент → существующий файл, без «lesson (1).pdf».
  assert.equal(res.data.file, 'lesson.pdf');
});

test('file.download: то же имя, но другой контент → uniquify имени', async () => {
  mock.fileToServe = { name: 'lesson.pdf', content: crypto.randomBytes(800), chunkSize: 400 };
  const res = await handle.core.callTool('file.download', {
    tabId: 1, url: 'http://allowed.example/files/lesson.pdf', name: 'lesson.pdf',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.data.file, /lesson \(1\)\.pdf/);
  mock.fileToServe = { name: 'lesson.pdf', content: FILE_CONTENT, chunkSize: 400 };
});

test('file.download без capability download → CAPABILITY_DENIED', async () => {
  const res = await handle.core.callTool('file.download', {
    tabId: 2, url: 'http://readonly.example/files/x.pdf', name: 'x.pdf',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'CAPABILITY_DENIED');
});

test('file.download: ошибка fetchFile не отравляет очередь ожиданий (чужой url не протекает в manifest)', async () => {
  // Живой кейс 2026-08-19 (HF): fetch xet-файла падает (CORS при редиректе на
  // CDN) ДО file.start; протухшее ожидание по FIFO съедал следующий трансфер
  // и manifest записывал чужой url.
  mock.fetchFails = true;
  const bad = await handle.core.callTool('file.download', {
    tabId: 1, url: 'http://allowed.example/files/broken.bin', name: 'broken.bin',
  });
  assert.equal(bad.ok, false, JSON.stringify(bad));
  assert.equal(bad.error_code, 'FETCH_FAILED');
  mock.fetchFails = false;

  const content = crypto.randomBytes(700);
  mock.fileToServe = { name: 'after-fail.bin', content, chunkSize: 400 };
  const res = await handle.core.callTool('file.download', {
    tabId: 1, url: 'http://allowed.example/files/after-fail.bin', name: 'after-fail.bin',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const manifest = fs.readFileSync(path.join(env.downloadsDir, 'manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const entry = manifest.find((l) => l.name === res.data.file);
  assert.ok(entry, 'строка в manifest.jsonl');
  assert.match(entry.url, /after-fail\.bin/, 'url обязан быть своим, а не протухшим broken.bin');
  mock.fileToServe = { name: 'lesson.pdf', content: FILE_CONTENT, chunkSize: 400 };
});

test('file.download blob: (Ж.1): policy по домену вкладки, origin совпадает → файл скачан', async () => {
  const content = crypto.randomBytes(600);
  mock.fileToServe = { name: 'blob.bin', content, chunkSize: 400 };
  const res = await handle.core.callTool('file.download', {
    tabId: 1, url: 'blob:http://allowed.example/9f2c4e00-uuid', name: 'blob.bin',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(fs.readFileSync(path.join(env.downloadsDir, res.data.file)), content);
  mock.fileToServe = { name: 'lesson.pdf', content: FILE_CONTENT, chunkSize: 400 };
});

test('file.download blob: чужого origin (Ж.1) → VALIDATION_ERROR до policy-гейта', async () => {
  const res = await handle.core.callTool('file.download', {
    tabId: 1, url: 'blob:http://evil.example/9f2c4e00-uuid',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'VALIDATION_ERROR');
  assert.match(res.hint, /origin/);
});

test('file.download blob: на вкладке без capability download (Ж.1) → CAPABILITY_DENIED по домену вкладки', async () => {
  const res = await handle.core.callTool('file.download', {
    tabId: 2, url: 'blob:http://readonly.example/9f2c4e00-uuid',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'CAPABILITY_DENIED');
});

test('file.download data: (Ж.1): policy по домену вкладки → скачивается', async () => {
  const res = await handle.core.callTool('file.download', {
    tabId: 1, url: 'data:application/octet-stream;base64,aGVsbG8gd29ybGQ=', name: 'hello.bin',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.file, 'hello.bin');
});
