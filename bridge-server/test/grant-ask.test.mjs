// grant-ask.test.mjs — П2-5: in-page баннер download-гранта. Deny на file.download
// (домен ФАЙЛА) → сервер шлёт grant.ask в браузер-владелец вкладки; allow → мок
// сам шлёт grant.add → повторный policy.check проходит, загрузка без ретрая
// агента; deny/таймаут/исключение → исходная ошибка (fail-closed); deny-кэш
// 10 мин не даёт спамить баннером при пакетных загрузках.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeTempEnv, startTestBridge } from './helpers.mjs';
import { MockExtension } from './mock-extension.mjs';

// node:test не даёт t в before — фиктивный контекст для хуков очистки.
const cleanups = [];
const t0 = { after: (fn) => cleanups.push(fn) };

let env, handle, mock;
const FILE_CONTENT = crypto.randomBytes(900);

before(async () => {
  env = makeTempEnv(t0);
  handle = await startTestBridge(t0, env);
  mock = new MockExtension({
    secret: env.secret,
    tabs: [{
      tabId: 1,
      url: 'http://allowed.example/page',
      title: 'Allowed',
      snapshot: [
        'url: http://allowed.example/page',
        'title: Allowed',
        '[e1] button "Отправить" type=submit',
      ].join('\n'),
    }],
    fileToServe: { name: 'pic.png', content: FILE_CONTENT, chunkSize: 400 },
    grantAsk: 'deny',
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

test('(a) deny на домене файла → grant.ask с domain ФАЙЛА и tabId вкладки-источника', async () => {
  mock.grantAsk = 'deny';
  const before = mock.grantAskRequests.length;
  const res = await handle.core.callTool('file.download', { tabId: 1, url: 'http://forbidden.example/files/x.bin' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'DOMAIN_NOT_ALLOWED');
  // П2-5: домен файла машиночитаем в data, не только текстом в hint.
  assert.deepEqual(res.data, { domain: 'forbidden.example' });
  assert.equal(mock.grantAskRequests.length, before + 1, 'grant.ask должен уйти в расширение');
  const req = mock.grantAskRequests.at(-1);
  assert.equal(req.domain, 'forbidden.example', 'домен ФАЙЛА, а не вкладки');
  assert.equal(req.tabId, 1);
  assert.equal(req.url, 'http://forbidden.example/files/x.bin');
  assert.equal(req.category, 'download_grant');
  assert.equal(req.grant, true);
  assert.match(req.description, /download-доступ/);
  assert.match(req.requestId, /^g_\d+$/);
});

test('(b) allow → grant.add от расширения → повторный check проходит, файл скачан без ретрая агента', async () => {
  mock.grantAsk = 'allow';
  const before = mock.grantAskRequests.length;
  const res = await handle.core.callTool('file.download', { tabId: 1, url: 'http://img-cdn.example/pic.png', name: 'pic.png' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(mock.grantAskRequests.length, before + 1);
  assert.equal(mock.grantAskRequests.at(-1).domain, 'img-cdn.example');
  // Мок (как background) успел слать grant.add ДО ответа на grant.ask — грант
  // уже в policy engine и привязан к браузеру-источнику (D4).
  assert.equal(handle.policy.check('http://img-cdn.example/pic.png', 'download', null, mock.browser).decision, 'allow');
  // executeDownload дошёл до конца: файл на диске, sha256 сходится.
  const filePath = path.join(env.downloadsDir, res.data.file);
  assert.ok(fs.existsSync(filePath), `файл ${res.data.file} на диске`);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  assert.equal(res.data.sha256, sha);
  assert.equal(res.data.size, FILE_CONTENT.length);
  mock.grantAsk = 'deny';
});

test('(c) scripted deny → исходный CAPABILITY_DENIED; повтор <10 мин — без grant.ask (deny-кэш)', async () => {
  mock.grantAsk = 'deny';
  const before = mock.grantAskRequests.length;
  const res1 = await handle.core.callTool('file.download', { tabId: 1, url: 'http://readonly.example/files/a.pdf' });
  assert.equal(res1.ok, false);
  assert.equal(res1.error_code, 'CAPABILITY_DENIED', 'агенту — исходная ошибка policy, не баннерная');
  assert.match(res1.hint, /capability "download"/);
  assert.deepEqual(res1.data, { domain: 'readonly.example' });
  assert.equal(mock.grantAskRequests.length, before + 1);
  // Повтор по тому же (clientId, domain) в окне 10 мин: баннер НЕ шлём,
  // ошибка та же — пакетная загрузка с одного CDN не спамит баннерами.
  const res2 = await handle.core.callTool('file.download', { tabId: 1, url: 'http://readonly.example/files/b.pdf' });
  assert.equal(res2.ok, false);
  assert.equal(res2.error_code, 'CAPABILITY_DENIED');
  assert.equal(mock.grantAskRequests.length, before + 1, 'grant.ask не должен отправляться повторно (deny-кэш)');
});

test('(d) исключение/таймаут grant.ask → исходная ошибка (fail-closed)', async () => {
  // Исключение на стороне расширения (error res) → deny → исходный deny policy.
  mock.grantAsk = 'throw';
  const res1 = await handle.core.callTool('file.download', { tabId: 1, url: 'http://boom.example/x.bin' });
  assert.equal(res1.ok, false);
  assert.equal(res1.error_code, 'DOMAIN_NOT_ALLOWED');
  assert.deepEqual(res1.data, { domain: 'boom.example' });
  // Молчаливый таймаут ответа (consentTimeoutMs теста 300 мс) → тоже исходная ошибка.
  mock.grantAsk = 'timeout';
  const before = mock.grantAskRequests.length;
  const res2 = await handle.core.callTool('file.download', { tabId: 1, url: 'http://slow.example/x.bin' });
  assert.equal(res2.ok, false);
  assert.equal(res2.error_code, 'DOMAIN_NOT_ALLOWED');
  assert.deepEqual(res2.data, { domain: 'slow.example' });
  assert.equal(mock.grantAskRequests.length, before + 1, 'grant.ask был отправлен, но ответ не пришёл');
  mock.grantAsk = 'deny';
});

test('(e) grant.ask — только для file.download: tab.open deny и consent-флоу его не трогают', async () => {
  const before = mock.grantAskRequests.length;
  // Не-download инструмент с deny на домене — grant.ask НЕ шлётся.
  const res1 = await handle.core.callTool('tab.open', { url: 'https://forbidden.example/checkout' });
  assert.equal(res1.ok, false);
  assert.equal(res1.error_code, 'DOMAIN_NOT_ALLOWED');
  // decision==='consent' (gated submit) — обычный consent.ask, не grant.ask.
  const snap = await handle.core.callTool('page.snapshot', { tabId: 1 });
  assert.equal(snap.ok, true, JSON.stringify(snap));
  mock.consent = 'allow';
  const res2 = await handle.core.callTool('act.click', { tabId: 1, ref: 'e1' });
  assert.equal(res2.ok, true, JSON.stringify(res2));
  assert.ok(mock.consentRequests.length >= 1, 'consent.ask на gated submit должен быть');
  assert.equal(mock.grantAskRequests.length, before, 'grant.ask не должен отправляться');
});

test('(f) аудит: решения баннера пишутся в policy-audit.jsonl (grant_ask_allow/grant_ask_deny)', async () => {
  const audit = fs.readFileSync(path.join(env.memoryDir, 'policy-audit.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const allow = audit.find((e) => e.decision === 'grant_ask_allow' && e.domain === 'img-cdn.example');
  assert.ok(allow, 'grant_ask_allow в аудите');
  assert.equal(allow.kind, 'grant');
  assert.equal(allow.browser, mock.browser);
  const deny = audit.find((e) => e.decision === 'grant_ask_deny' && e.domain === 'readonly.example');
  assert.ok(deny, 'grant_ask_deny в аудите');
  assert.equal(deny.kind, 'deny');
});
