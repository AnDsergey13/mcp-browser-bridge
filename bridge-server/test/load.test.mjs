// load.test.mjs — фаза 8: «50 страниц подряд» через mock-extension.
// Проверяет, что серверные реестры (вкладки, кэш снапшотов) не растут
// безгранично: (а) записи удаляются при tab.close агентом, (б) записи
// вкладок, закрытых В БРАУЗЕРЕ вручную (события tab.closed в протоколе нет),
// вытесняются reconcile'ом в tab.list и TTL-зачисткой (REPO-ANALYSIS §4.5);
// (в) нет утечки pending-запросов; (г) разумный потолок времени.
// Доступ к приватным реестрам — намеренный (runtime-интроспекция .mjs):
// тест — регрессионный сторож именно внутреннего состояния.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempEnv, startTestBridge } from './helpers.mjs';
import { MockExtension } from './mock-extension.mjs';

const t0 = { after: (fn) => cleanups.push(fn) };
const cleanups = [];

const N_TABS = 50;
const TIME_BUDGET_MS = 30_000; // потолок на рабочий цикл 50 вкладок (реально — секунды)

function makeTab(i) {
  return {
    tabId: i,
    url: `http://localhost:8080/page-${i}`,
    title: `Page ${i}`,
    snapshot: [
      `url: http://localhost:8080/page-${i}`,
      `title: Page ${i}`,
      '[e1] button "Показать детали"', // не-gated: ни pay/delete-маркеров, ни type=submit
      '[e2] link "Документация" → /docs',
      `Текст страницы ${i}…`,
    ].join('\n'),
    markdown: `# Page ${i}\n\nТекст страницы ${i}…`,
  };
}

let env, handle, mock;

function registrySizes() {
  return {
    tabs: handle.core.tabs.size,
    snapshots: handle.core.snapshots.size,
    pending: [...handle.transport.clients.values()].reduce((n, c) => n + c.pending.size, 0),
    mockPending: mock.pendingRes.size,
  };
}

before(async () => {
  env = makeTempEnv(t0);
  handle = await startTestBridge(t0, env);
  mock = new MockExtension({
    secret: env.secret,
    tabs: Array.from({ length: N_TABS }, (_, i) => makeTab(i + 1)),
    consent: 'allow',
  });
  await mock.connect(handle.port);
  await mock.approve();
});

after(async () => {
  mock?.close();
  for (const fn of cleanups.reverse()) await fn();
});

test('50 вкладок: snapshot + act.* + extract каждой; реестры не растут после закрытия; pending не течёт; потолок времени', async () => {
  const started = Date.now();

  const list = await handle.core.callTool('tab.list', {});
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.data.tabs.length, N_TABS);

  // Рабочий цикл по каждой вкладке: snapshot → click → scroll → key → extract.
  for (let tabId = 1; tabId <= N_TABS; tabId++) {
    const snap = await handle.core.callTool('page.snapshot', { tabId });
    assert.equal(snap.ok, true, `snapshot tab ${tabId}: ` + JSON.stringify(snap));
    const click = await handle.core.callTool('act.click', { tabId, ref: 'e1' });
    assert.equal(click.ok, true, `click tab ${tabId}: ` + JSON.stringify(click));
    const scroll = await handle.core.callTool('act.scroll', { tabId, dy: 600 });
    assert.equal(scroll.ok, true, `scroll tab ${tabId}: ` + JSON.stringify(scroll));
    const key = await handle.core.callTool('act.key', { tabId, key: 'Escape' });
    assert.equal(key.ok, true, `key tab ${tabId}: ` + JSON.stringify(key));
    const ext = await handle.core.callTool('page.extract', { tabId });
    assert.equal(ext.ok, true, `extract tab ${tabId}: ` + JSON.stringify(ext));
  }

  // В разгар работы реестры наполнены ровно под живые вкладки.
  assert.equal(registrySizes().tabs, N_TABS);
  assert.equal(registrySizes().snapshots, N_TABS);

  // Половину вкладок пользователь закрыл В БРАУЗЕРЕ вручную: сервер об этом
  // не узнаёт (события tab.closed в протоколе нет) — имитация: мок удаляет
  // вкладки мимо tab.close.
  for (let tabId = 1; tabId <= N_TABS / 2; tabId++) mock.tabs.delete(tabId);

  // Первый же tab.list обязан вытеснить мёртвые записи (reconcile, §4.5).
  const list2 = await handle.core.callTool('tab.list', {});
  assert.equal(list2.ok, true);
  assert.equal(list2.data.tabs.length, N_TABS / 2);
  assert.equal(registrySizes().tabs, N_TABS / 2,
    'reconcile: записи вручную закрытых вкладок не должны оставаться в реестре');
  assert.equal(registrySizes().snapshots, N_TABS / 2,
    'reconcile: кэш снапшотов мёртвых вкладок тоже вытесняется');

  // Остальные вкладки агент закрывает штатно (tab.close) → реестры пустеют.
  for (let tabId = N_TABS / 2 + 1; tabId <= N_TABS; tabId++) {
    const res = await handle.core.callTool('tab.close', { tabId });
    assert.equal(res.ok, true, `tab.close ${tabId}: ` + JSON.stringify(res));
  }
  assert.equal(registrySizes().tabs, 0, 'после tab.close реестр вкладок пуст');
  assert.equal(registrySizes().snapshots, 0, 'после tab.close кэш снапшотов пуст');

  // Утечки pending-запросов нет ни на сервере, ни на моке.
  assert.equal(registrySizes().pending, 0, 'pending-запросы сервера не текут');
  assert.equal(registrySizes().mockPending, 0, 'pending-запросы мока не текут');

  const elapsed = Date.now() - started;
  assert.ok(elapsed < TIME_BUDGET_MS, `цикл 50 вкладок занял ${elapsed} мс (бюджет ${TIME_BUDGET_MS} мс)`);
});

test('TTL-вытеснение: записи вкладок/снапшотов старше 30 минут удаляются и без tab.list', async () => {
  // Вкладка «открыта и забыта»: ни tab.close, ни tab.list больше не звали
  // (например, браузер офлайн — reconcile его не касается). TTL — страховка.
  const open = await handle.core.callTool('tab.open', { url: 'http://localhost:8080/stale' });
  assert.equal(open.ok, true, JSON.stringify(open));
  const tabId = open.data.tabId;
  const snap = await handle.core.callTool('page.snapshot', { tabId });
  assert.equal(snap.ok, true, JSON.stringify(snap));
  assert.ok(registrySizes().tabs >= 1 && registrySizes().snapshots >= 1);

  // «Прошло» 31 минута — зачистка обязана вытеснить запись.
  handle.core.sweepExpired(Date.now() + 31 * 60_000);
  assert.equal(registrySizes().tabs, 0, 'TTL вытеснил реестр вкладок');
  assert.equal(registrySizes().snapshots, 0, 'TTL вытеснил кэш снапшотов');

  // Контроль: свежие записи TTL НЕ трогает (защита живых вкладок).
  const open2 = await handle.core.callTool('tab.open', { url: 'http://localhost:8080/fresh' });
  assert.equal(open2.ok, true, JSON.stringify(open2));
  const snap2 = await handle.core.callTool('page.snapshot', { tabId: open2.data.tabId });
  assert.equal(snap2.ok, true, JSON.stringify(snap2));
  handle.core.sweepExpired(Date.now()); // «сейчас» — ничего не вытесняется
  assert.equal(registrySizes().tabs, 1, 'свежая вкладка пережила sweep');
  assert.equal(registrySizes().snapshots, 1, 'свежий снапшот пережил sweep');
});
