// scan.test.mjs — П2-3: page.scan (агрегат ленты, untrusted-флаг N15).
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

test('page.scan: агрегат возвращается, контент помечен untrusted', async () => {
  const res = await handle.core.callTool('page.scan', { tabId: 1, max_screens: 3 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(typeof res.data.scan === 'string');
  assert.equal(res.data.untrusted_page_content, true); // N15
  assert.deepEqual(mock.actions, ['scan']);
});
