// multi-client.test.mjs — фаза 9 (gate G2): мультиклиентский bridge-server.
// Два браузера (firefox + chromium) у одного сервера: per-client approve и
// состояния, per-browser политика (browsers у домена + session-гранты),
// объединённый tab.list с тегом browser, AMBIGUOUS_BROWSER при коллизии tabId,
// изоляция при дисконнекте, параллельные file.download (D7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeTempEnv, startTestBridge, waitFor } from './helpers.mjs';
import { MockExtension } from './mock-extension.mjs';

const t0 = { after: (fn) => cleanups.push(fn) };
const cleanups = [];

// shared.example — обоим; ffonly.example — только firefox (поле browsers, D4).
const MULTI_POLICY = `version: 2
active_preset: test
default: deny
gated_defaults: { pay: confirm, login: confirm, submit: confirm, delete: confirm }
pacing: { min_delay_ms: 0, max_delay_ms: 0, max_actions_per_minute: 1000 }
presets:
  test:
    description: "Мульти-тест"
    domains:
      "shared.example":
        capabilities: [read, interact, download]
      "ffonly.example":
        capabilities: [read, interact, download]
        browsers: [firefox]
`;

const FF_TABS = [
  { tabId: 101, url: 'http://shared.example/ff', title: 'FF shared' }, // коллизия tabId с chromium
  { tabId: 102, url: 'http://ffonly.example/page', title: 'FF only' },
];
const CHR_TABS = [
  { tabId: 101, url: 'http://shared.example/cr', title: 'CR shared' },
  { tabId: 103, url: 'http://ffonly.example/page', title: 'CR ffonly' }, // домен не для chromium → hidden
];

const FF_FILE = { name: 'ff.bin', content: crypto.randomBytes(900), chunkSize: 400 };
const CHR_FILE = { name: 'cr.bin', content: crypto.randomBytes(700), chunkSize: 400 };

let env, handle, ff, chr;

before(async () => {
  env = makeTempEnv(t0, MULTI_POLICY);
  handle = await startTestBridge(t0, env);
  ff = new MockExtension({ secret: env.secret, browser: 'firefox', tabs: FF_TABS, fileToServe: FF_FILE });
  chr = new MockExtension({ secret: env.secret, browser: 'chromium', tabs: CHR_TABS, fileToServe: CHR_FILE });
  await ff.connect(handle.port);
  await chr.connect(handle.port);
  await ff.approve();
  await chr.approve();
  // Реестр вкладок наполняется первым tab.list (агент всегда начинает с него).
  const list = await handle.core.callTool('tab.list', {});
  assert.equal(list.ok, true, JSON.stringify(list));
});

after(async () => {
  ff?.close();
  chr?.close();
  for (const fn of cleanups.reverse()) await fn();
});

test('1. два клиента онлайн; approve per-browser; реконнект — без повторного approve и не выбивает второго', async () => {
  const states = handle.transport.listClients().map((c) => `${c.id}:${c.state}`).sort();
  assert.deepEqual(states, ['chromium:active', 'firefox:active']);

  // Реконнект firefox (тот же clientId) — hello сразу active (D2), повторный approve не нужен.
  const ff2 = new MockExtension({ secret: env.secret, browser: 'firefox', tabs: FF_TABS, fileToServe: FF_FILE });
  cleanups.push(() => ff2.close());
  await ff2.connect(handle.port);
  assert.equal(ff2.helloRes.status, 'active', 'реконнект подтверждённого клиента — без approve');
  ff = ff2; // дальше работаем с новым сокетом
  await waitFor(() => handle.transport.getState('firefox') === 'active');

  // chromium при этом не выбило.
  assert.equal(handle.transport.getState('chromium'), 'active');
  const r = await handle.core.callTool('act.scroll', { tabId: 101, dy: 100, browser: 'chromium' });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('2. policy.update per-client: browsers у домена и session-грант firefox невидимы для chromium', async () => {
  // Статичная политика: ffonly.example с browsers:[firefox] — только у firefox.
  const ffInit = ff.policyUpdates.at(-1);
  const chrInit = chr.policyUpdates.at(-1);
  assert.ok(ffInit.domains['ffonly.example'], 'ffonly.example у firefox');
  assert.ok(!chrInit.domains['ffonly.example'], 'ffonly.example НЕ у chromium');
  assert.ok(!chrInit.match_patterns.includes('*://*.ffonly.example/*'));

  // Session-грант от имени firefox (его popup → grant.add с его clientId).
  const chrVersion = chrInit.version;
  const g = await ff.sendReq('grant.add', { domain: 'grant.example', capabilities: ['read'], scope: 'session' });
  assert.equal(g.granted, true);
  const ffUpd = await ff.waitForPolicyUpdate((v) => v.domains['grant.example'], 5000);
  assert.equal(ffUpd.domains['grant.example'].source, 'session');
  const chrUpd = await chr.waitForPolicyUpdate((v) => v.version > chrVersion, 5000);
  assert.ok(!chrUpd.domains['grant.example'], 'session-грант firefox не должен попасть в policy.update chromium');
});

test('3. tab.list объединённый с browser-тегами; коллизия tabId → AMBIGUOUS_BROWSER; с browser — в правильный мок', async () => {
  const list = await handle.core.callTool('tab.list', {});
  assert.equal(list.ok, true, JSON.stringify(list));
  const tabs101 = list.data.tabs.filter((t) => t.tabId === 101);
  assert.equal(tabs101.length, 2, 'вкладка 101 есть в обоих браузерах');
  assert.deepEqual(tabs101.map((t) => t.browser).sort(), ['chromium', 'firefox']);
  const ffOnly = list.data.tabs.find((t) => t.url.includes('ffonly.example'));
  assert.equal(ffOnly.browser, 'firefox');
  assert.equal(list.data.hidden_tabs, 1, 'ffonly-вкладка chromium скрыта по его политике');
  assert.ok(list.data.tabs.every((t) => typeof t.browser === 'string'), 'browser-тег у каждой вкладки');

  // Коллизия tabId без browser → AMBIGUOUS_BROWSER с подсказкой.
  ff.actions = []; chr.actions = [];
  const amb = await handle.core.callTool('act.scroll', { tabId: 101, dy: 100 });
  assert.equal(amb.ok, false);
  assert.equal(amb.error_code, 'AMBIGUOUS_BROWSER');
  assert.match(amb.hint, /firefox/);
  assert.match(amb.hint, /chromium/);
  assert.equal(ff.actions.length + chr.actions.length, 0, 'действие не должно было исполниться');

  // С browser — маршрутизация в правильный мок.
  const r1 = await handle.core.callTool('act.scroll', { tabId: 101, dy: 100, browser: 'firefox' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.deepEqual(ff.actions, ['scroll']);
  assert.deepEqual(chr.actions, []);
  const r2 = await handle.core.callTool('act.scroll', { tabId: 101, dy: 100, browser: 'chromium' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(chr.actions, ['scroll']);
});

test('4. изоляция политики: act на ffonly.example во вкладке chromium → DOMAIN_NOT_ALLOWED, у firefox — ok', async () => {
  // tab.open на ffonly.example от имени chromium — домен ему не грантован (browsers:[firefox]).
  const openCr = await handle.core.callTool('tab.open', { url: 'http://ffonly.example/x', browser: 'chromium' });
  assert.equal(openCr.ok, false);
  assert.equal(openCr.error_code, 'DOMAIN_NOT_ALLOWED', JSON.stringify(openCr));
  assert.match(openCr.hint, /chromium/);

  // От имени firefox — разрешено (вкладка 102 уже в реестре с tab.list).
  ff.actions = [];
  const snapFf = await handle.core.callTool('page.snapshot', { tabId: 102, browser: 'firefox' });
  assert.equal(snapFf.ok, true, JSON.stringify(snapFf));
  const actFf = await handle.core.callTool('act.scroll', { tabId: 102, dy: 100, browser: 'firefox' });
  assert.equal(actFf.ok, true, JSON.stringify(actFf));
  assert.deepEqual(ff.actions, ['scroll']);
});

test('5. дисконнект chromium: firefox работает, вкладка chromium → BROWSER_OFFLINE, реконнект — active без approve', async () => {
  chr.close();
  await waitFor(() => handle.transport.getState('chromium') === 'offline');

  // firefox продолжает работу (состояние сессии — по целевому клиенту).
  const ok = await handle.core.callTool('act.scroll', { tabId: 101, dy: 100, browser: 'firefox' });
  assert.equal(ok.ok, true, JSON.stringify(ok));

  // Команда к вкладке offline-браузера → BROWSER_OFFLINE.
  const off = await handle.core.callTool('act.scroll', { tabId: 101, dy: 100, browser: 'chromium' });
  assert.equal(off.ok, false);
  assert.equal(off.error_code, 'BROWSER_OFFLINE');

  // Реконнект chromium — сразу active (approve переживает реконнект, D2).
  const chr2 = new MockExtension({ secret: env.secret, browser: 'chromium', tabs: CHR_TABS, fileToServe: CHR_FILE });
  cleanups.push(() => chr2.close());
  await chr2.connect(handle.port);
  assert.equal(chr2.helloRes.status, 'active');
  chr = chr2;
  const back = await handle.core.callTool('act.scroll', { tabId: 101, dy: 100, browser: 'chromium' });
  assert.equal(back.ok, true, JSON.stringify(back));
});

test('6. два параллельных file.download (по одному на клиент) завершаются независимо, ack — своим', async () => {
  // Моки ждут ack каждого чанка: если ack уйдёт не тому клиенту — дедлок/таймаут.
  const [r1, r2] = await Promise.all([
    handle.core.callTool('file.download', { tabId: 101, browser: 'firefox', url: 'http://shared.example/files/ff.bin', name: 'ff.bin' }),
    handle.core.callTool('file.download', { tabId: 101, browser: 'chromium', url: 'http://shared.example/files/cr.bin', name: 'cr.bin' }),
  ]);
  assert.equal(r1.ok, true, 'firefox: ' + JSON.stringify(r1));
  assert.equal(r2.ok, true, 'chromium: ' + JSON.stringify(r2));
  const f1 = fs.readFileSync(path.join(env.downloadsDir, r1.data.file));
  const f2 = fs.readFileSync(path.join(env.downloadsDir, r2.data.file));
  assert.deepEqual(f1, FF_FILE.content);
  assert.deepEqual(f2, CHR_FILE.content);
  assert.notEqual(r1.data.file, r2.data.file, 'разные файлы — разные имена');
});

test('7. одиночный клиент — поведение как раньше: browser не нужен, tabId резолвится по реестру', async () => {
  chr.close();
  await waitFor(() => handle.transport.getState('chromium') === 'offline');
  // Вкладка 102 — только у firefox: единственный владелец, browser не нужен.
  const r = await handle.core.callTool('act.scroll', { tabId: 102, dy: 100 });
  assert.equal(r.ok, true, JSON.stringify(r));
  // tab.list опрашивает только оставшийся active-клиент.
  const list = await handle.core.callTool('tab.list', {});
  assert.equal(list.ok, true);
  assert.ok(list.data.tabs.every((t) => t.browser === 'firefox'));
});
