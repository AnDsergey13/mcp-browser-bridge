// hover-console.test.mjs — act.hover (конвейер act.*: policy-check, классификация
// ref как у act.click, pacing, STALE_REF-retry) и page.console (боковая линия:
// буфер от расширения, limit, маркер console_unavailable, untrusted N15).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempEnv, startTestBridge, FORM_TAB } from './helpers.mjs';
import { MockExtension } from './mock-extension.mjs';

const t0 = { after: (fn) => cleanups.push(fn) };
const cleanups = [];

let env, handle, mock;

before(async () => {
  env = makeTempEnv(t0);
  handle = await startTestBridge(t0, env);
  mock = new MockExtension({ secret: env.secret, tabs: [FORM_TAB] });
  await mock.connect(handle.port);
  await mock.approve();
  const list = await handle.core.callTool('tab.list', {});
  assert.equal(list.ok, true);
});

after(async () => {
  mock?.close();
  for (const fn of cleanups.reverse()) await fn();
});

async function prime() {
  mock.tabs.get(1).snapshot = FORM_TAB.snapshot;
  mock.actions = [];
  mock.consent = 'allow';
  const snap = await handle.core.callTool('page.snapshot', { tabId: 1 });
  assert.equal(snap.ok, true, JSON.stringify(snap));
}

// ---------- act.hover ----------

test('act.hover по ref: проходит конвейер, доходит до расширения', async () => {
  await prime();
  const res = await handle.core.callTool('act.hover', { tabId: 1, ref: 'e1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(mock.actions, ['hover']);
  assert.equal(res.data.url, FORM_TAB.url);
});

test('act.hover по gated-кнопке (submit) с consent deny → ACTION_DENIED, действие не исполнено', async () => {
  await prime();
  mock.consent = 'deny';
  const res = await handle.core.callTool('act.hover', { tabId: 1, ref: 'e3' }); // type=submit → confirm
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'ACTION_DENIED');
  assert.equal(mock.actions.length, 0, 'hover не должен был исполниться: ' + JSON.stringify(mock.actions));
});

test('act.hover by-text: классификация по тексту запроса (delete → consent)', async () => {
  await prime();
  mock.consent = 'deny';
  const denied = await handle.core.callTool('act.hover', { tabId: 1, text: 'Удалить аккаунт' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error_code, 'ACTION_DENIED');
  assert.equal(mock.actions.length, 0);

  mock.consent = 'allow';
  const ok = await handle.core.callTool('act.hover', { tabId: 1, text: 'Удалить аккаунт' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(mock.actions, ['hover']);
});

test('act.hover: авто-retry после STALE_REF выполняется по новому ref', async () => {
  await prime();
  const tab = mock.tabs.get(1);
  tab.snapshot = tab.snapshot.replace('[e1]', '[e11]'); // SPA-перерисовка
  const res = await handle.core.callTool('act.hover', { tabId: 1, ref: 'e1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.retried, true);
  assert.equal(res.data.new_ref, 'e11');
  assert.deepEqual(mock.actions, ['hover']);
});

test('act.hover без ref и text — ошибка', async () => {
  await prime();
  const res = await handle.core.callTool('act.hover', { tabId: 1 });
  assert.equal(res.ok, false);
  assert.equal(mock.actions.length, 0);
});

// ---------- page.console ----------

test('page.console: записи буфера возвращаются с untrusted-маркером (N15)', async () => {
  await prime();
  mock.tabs.get(1).consoleEntries = [
    { ts: 1, level: 'log', text: 'app started' },
    { ts: 2, level: 'error', text: 'onerror: Uncaught TypeError: x is null (app.js:10)', count: 3 },
  ];
  const res = await handle.core.callTool('page.console', { tabId: 1 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.entries.length, 2);
  assert.equal(res.data.entries[1].level, 'error');
  assert.equal(res.data.entries[1].count, 3);
  assert.equal(res.data.untrusted_page_content, true);
});

test('page.console: limit отрезает хвост буфера (берутся последние записи)', async () => {
  await prime();
  mock.tabs.get(1).consoleEntries = [
    { ts: 1, level: 'log', text: 'a' },
    { ts: 2, level: 'warn', text: 'b' },
    { ts: 3, level: 'error', text: 'c' },
  ];
  const res = await handle.core.callTool('page.console', { tabId: 1, limit: 2 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.data.entries.map((e) => e.text), ['b', 'c']);
});

test('page.console: маркер console_unavailable (CSP запретил хук) пробрасывается', async () => {
  await prime();
  const tab = mock.tabs.get(1);
  tab.consoleEntries = [];
  tab.consoleUnavailable = 'MAIN-world хук не загрузился (CSP страницы?) — буфер не пишется';
  const res = await handle.core.callTool('page.console', { tabId: 1 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.entries.length, 0);
  assert.match(res.data.console_unavailable, /CSP/);
  assert.equal(res.data.untrusted_page_content, true);
  delete tab.consoleUnavailable;
});
