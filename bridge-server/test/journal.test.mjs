// journal.test.mjs — П2-4: journal_full_args: полные args в журнале,
// значение act.type в password-поле замаскировано.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempEnv, startTestBridge, TEST_POLICY, FORM_TAB } from './helpers.mjs';
import { MockExtension } from './mock-extension.mjs';

const t0 = { after: (fn) => cleanups.push(fn) };
const cleanups = [];

let env, handle, mock;

before(async () => {
  env = makeTempEnv(t0, TEST_POLICY + '\njournal_full_args: true\n');
  handle = await startTestBridge(t0, env);
  mock = new MockExtension({ secret: env.secret, tabs: [FORM_TAB] });
  await mock.connect(handle.port);
  await mock.approve();
  await handle.core.callTool('tab.list', {});
  const snap = await handle.core.callTool('page.snapshot', { tabId: 1 });
  assert.equal(snap.ok, true, JSON.stringify(snap));
});

after(async () => {
  mock?.close();
  for (const fn of cleanups.reverse()) await fn();
});

function journalEntries() {
  return fs.readFileSync(path.join(env.memoryDir, 'journal.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
}

test('journal_full_args: args пишутся, пароль замаскирован, обычный текст — нет', async () => {
  const r1 = await handle.core.callTool('act.type', { tabId: 1, ref: 'e2', text: 'secret-pw' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = await handle.core.callTool('act.type', { tabId: 1, ref: 'e1', text: 'user1' });
  assert.equal(r2.ok, true, JSON.stringify(r2));

  const entries = journalEntries();
  const pw = entries.find((e) => e.tool === 'act.type' && e.args?.ref === 'e2');
  const login = entries.find((e) => e.tool === 'act.type' && e.args?.ref === 'e1');
  assert.ok(pw, 'запись act.type e2 в журнале');
  assert.equal(pw.args.text, '***');
  assert.ok(login, 'запись act.type e1 в журнале');
  assert.equal(login.args.text, 'user1');
  assert.equal(pw.ok, true);
});

test('journal без journal_full_args: поля args нет', async () => {
  // Отдельный бридж с дефолтной политикой (флаг выключен).
  const env2 = makeTempEnv(t0);
  const handle2 = await startTestBridge(t0, env2);
  const res = await handle2.core.callTool('policy.status', {});
  assert.equal(res.ok, true);
  const entries = fs.readFileSync(path.join(env2.memoryDir, 'journal.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => !('args' in e)), 'args не должны журналироваться при default off');
});
