// wait-for.test.mjs — page.wait_for (П1-1): condition_met по тексту/ref/url,
// таймаут — не ошибка ({ok:true, condition_met:false}).
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

test('wait_for: текст есть → condition_met:true', async () => {
  const res = await handle.core.callTool('page.wait_for', {
    tabId: 1, condition: { text: 'Отправить' }, timeout_ms: 2000,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.condition_met, true);
});

test('wait_for: текста нет → таймаут без ошибки (condition_met:false)', async () => {
  const res = await handle.core.callTool('page.wait_for', {
    tabId: 1, condition: { text: 'Несуществующий текст' }, timeout_ms: 2000,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.condition_met, false);
});

test('wait_for: ref disappear (невалидный ref) → condition_met:true', async () => {
  const res = await handle.core.callTool('page.wait_for', {
    tabId: 1, condition: { ref: 'e999' }, state: 'disappear', timeout_ms: 2000,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.condition_met, true);
});

test('wait_for: url_contains', async () => {
  const res = await handle.core.callTool('page.wait_for', {
    tabId: 1, condition: { url_contains: 'localhost:18547' }, timeout_ms: 2000,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.condition_met, true);
});
