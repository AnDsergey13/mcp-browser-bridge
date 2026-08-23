// stale-retry.test.mjs — П1-3: авто-retry после STALE_REF (пересъём снапшота,
// поиск по тексту, ровно один retry, AMBIGUOUS при >1 кандидате).
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

async function primeSnapshot() {
  // Каждый тест начинает с исходной страницы (тесты делят mock-вкладку).
  mock.tabs.get(1).snapshot = FORM_TAB.snapshot;
  const snap = await handle.core.callTool('page.snapshot', { tabId: 1 });
  assert.equal(snap.ok, true, JSON.stringify(snap));
}

/** SPA-перерисовка: те же элементы, но refs перенумерованы (e1→e11 и т.д.). */
function renumberTabSnapshot() {
  const tab = mock.tabs.get(1);
  tab.snapshot = tab.snapshot
    .replace('[e1]', '[e11]').replace('[e2]', '[e12]').replace('[e3]', '[e13]')
    .replace('[e4]', '[e14]').replace('[e5]', '[e15]').replace('[e6]', '[e16]');
}

test('STALE_REF → авто-retry: элемент перенайден по тексту, действие выполнено', async () => {
  await primeSnapshot();
  renumberTabSnapshot(); // e1 больше нет, есть e11 с тем же текстом
  const res = await handle.core.callTool('act.type', { tabId: 1, ref: 'e1', text: 'x' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.retried, true);
  assert.equal(res.data.new_ref, 'e11');
  // Кэш снапшота обновлён пересъёмом: следующий snapshot → unchanged.
  const again = await handle.core.callTool('page.snapshot', { tabId: 1 });
  assert.equal(again.data.unchanged, true, JSON.stringify(again.data));
});

test('STALE_REF → авто-retry: элемент исчез — честный STALE_REF', async () => {
  await primeSnapshot();
  const tab = mock.tabs.get(1);
  tab.snapshot = 'url: http://localhost:18547/form\ntitle: Form\nПустая страница';
  const res = await handle.core.callTool('act.type', { tabId: 1, ref: 'e1', text: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'STALE_REF');
});

test('STALE_REF → авто-retry: >1 кандидата по тексту — AMBIGUOUS, молча не выбираем', async () => {
  await primeSnapshot();
  const tab = mock.tabs.get(1);
  tab.snapshot = [
    'url: http://localhost:18547/form',
    'title: Form',
    '[e21] textbox name=user placeholder="Логин" value=""',
    '[e22] textbox name=user2 placeholder="Логин" value=""',
  ].join('\n');
  const res = await handle.core.callTool('act.type', { tabId: 1, ref: 'e1', text: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'AMBIGUOUS');
  assert.match(res.hint, /e21/);
});
