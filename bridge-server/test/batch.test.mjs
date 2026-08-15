// batch.test.mjs — П1-2: act.batch. Единый policy-check в начале (gated-шаг
// отклоняет весь пакет ДО исполнения), один after-блок, BATCH_STEP_FAILED с
// числом завершённых шагов, авто-retry шага после STALE_REF.
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

test('act.batch: 3 шага одним вызовом, реестр шагов в ответе', async () => {
  await prime();
  const res = await handle.core.callTool('act.batch', {
    tabId: 1,
    steps: [
      { do: 'type', ref: 'e1', text: 'user1', clear: true },
      { do: 'type', ref: 'e2', text: 'pw' }, // type=password → gated login: auto в TEST_POLICY
      { do: 'key', key: 'Enter' },
    ],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.steps.length, 3);
  assert.deepEqual(mock.actions, ['type', 'type', 'pressKey']);
});

test('act.batch: gated-шаг с consent deny → весь пакет отклонён ДО исполнения', async () => {
  await prime();
  mock.consent = 'deny';
  const res = await handle.core.callTool('act.batch', {
    tabId: 1,
    steps: [
      { do: 'type', ref: 'e1', text: 'user1' },
      { do: 'click', ref: 'e3' }, // submit → confirm
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'ACTION_DENIED');
  assert.equal(mock.actions.length, 0, 'ни один шаг не должен был исполниться: ' + JSON.stringify(mock.actions));
});

test('act.batch: падение шага → BATCH_STEP_FAILED с числом завершённых', async () => {
  await prime();
  const res = await handle.core.callTool('act.batch', {
    tabId: 1,
    steps: [
      { do: 'type', ref: 'e1', text: 'user1' },
      { do: 'click', ref: 'e999' }, // нет такого ref — STALE_REF, retry не находит текст
    ],
  });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.error_code, 'BATCH_STEP_FAILED');
  assert.equal(res.data.batch_completed, 1);
  assert.deepEqual(mock.actions, ['type']);
});

test('act.batch: шаг с авто-retry после STALE_REF выполняется по новому ref', async () => {
  await prime();
  const tab = mock.tabs.get(1);
  tab.snapshot = tab.snapshot.replace('[e1]', '[e11]'); // SPA-перерисовка
  const res = await handle.core.callTool('act.batch', {
    tabId: 1,
    steps: [{ do: 'type', ref: 'e1', text: 'user1' }],
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.retried, true);
  assert.equal(res.data.new_ref, 'e11');
});

test('act.batch: недопустимый шаг отклонён до исполнения', async () => {
  await prime();
  const res = await handle.core.callTool('act.batch', {
    tabId: 1,
    steps: [{ do: 'scroll', dy: 100 }],
  });
  assert.equal(res.ok, false);
  assert.equal(mock.actions.length, 0);
});
