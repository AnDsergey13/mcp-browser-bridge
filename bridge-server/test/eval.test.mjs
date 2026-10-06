// eval.test.mjs — page.eval (L1.1): двойной гейт (capability eval + gated
// eval:confirm), consent с expression в описании, аудит expression в
// policy-audit.jsonl, untrusted-маркер (N15), релей больших результатов,
// ошибки EVAL_ERROR/EVAL_UNAVAILABLE.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempEnv, startTestBridge, FORM_TAB } from './helpers.mjs';
import { MockExtension } from './mock-extension.mjs';

const t0 = { after: (fn) => cleanups.push(fn) };
const cleanups = [];

// allowed.example есть в TEST_POLICY с capabilities [read, interact, download]
// — capability eval НЕ выдана.
const NOEVAL_TAB = { tabId: 2, url: 'https://allowed.example/page', title: 'Allowed' };

let env, handle, mock;

before(async () => {
  env = makeTempEnv(t0);
  handle = await startTestBridge(t0, env);
  mock = new MockExtension({ secret: env.secret, tabs: [FORM_TAB, NOEVAL_TAB] });
  await mock.connect(handle.port);
  await mock.approve();
  const list = await handle.core.callTool('tab.list', {});
  assert.equal(list.ok, true);
});

after(async () => {
  mock?.close();
  for (const fn of cleanups.reverse()) await fn();
});

function prime() {
  const tab = mock.tabs.get(1);
  delete tab.evalResult;
  delete tab.evalError;
  delete tab.evalUnavailable;
  mock.actions = [];
  mock.consent = 'allow';
  mock.consentRequests = [];
}

function auditLines() {
  const p = path.join(env.memoryDir, 'policy-audit.jsonl');
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('page.eval без capability eval на домене → CAPABILITY_DENIED, consent не спрашивают', async () => {
  prime();
  const res = await handle.core.callTool('page.eval', { tabId: 2, expression: '1+1' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'CAPABILITY_DENIED');
  assert.equal(mock.consentRequests.length, 0, 'consent не должен запрашиваться до capability-гейта');
  assert.equal(mock.actions.length, 0);
});

test('page.eval: gated eval:confirm — consent.ask с категорией eval и expression в описании; deny → ACTION_DENIED', async () => {
  prime();
  mock.consent = 'deny';
  const res = await handle.core.callTool('page.eval', { tabId: 1, expression: 'window.store.getState()' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'ACTION_DENIED');
  assert.equal(mock.consentRequests.length, 1);
  assert.equal(mock.consentRequests[0].category, 'eval');
  assert.match(mock.consentRequests[0].description, /window\.store\.getState\(\)/);
  assert.equal(mock.actions.length, 0, 'eval не должен был исполниться');
});

test('page.eval: consent allow → значение возвращается, ответ untrusted (N15), expression в аудите', async () => {
  prime();
  mock.tabs.get(1).evalResult = JSON.stringify({ user: 'bob', roles: ['admin'] });
  const expr = 'fetch("/api/me").then(r=>r.json())';
  const res = await handle.core.callTool('page.eval', { tabId: 1, expression: expr });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(mock.actions, ['eval']);
  assert.equal(mock.lastEvalParams.expression, expr, 'expression доехал до вкладки без искажений');
  assert.deepEqual(JSON.parse(res.data.value_json), { user: 'bob', roles: ['admin'] });
  assert.equal(res.data.untrusted_page_content, true);
  assert.equal(res.data.relayed, undefined);

  const sha = crypto.createHash('sha256').update(expr).digest('hex');
  const entry = auditLines().find((e) => e.kind === 'eval' && e.decision === 'eval_exec');
  assert.ok(entry, 'eval-запись в policy-audit.jsonl');
  assert.equal(entry.expression_sha256, sha);
  assert.equal(entry.domain, 'localhost:18547');
});

test('page.eval: результат >16 KB уходит файловым релеем в downloads/', async () => {
  prime();
  const big = JSON.stringify({ data: 'x'.repeat(20000) });
  mock.tabs.get(1).evalResult = big;
  const res = await handle.core.callTool('page.eval', { tabId: 1, expression: 'window.bigDump' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.relayed, true);
  assert.equal(res.data.value_json, undefined, 'большой результат инлайном не отдаётся');
  assert.equal(res.data.size, Buffer.byteLength(big));
  const filePath = path.join(env.downloadsDir, res.data.file);
  assert.equal(fs.readFileSync(filePath, 'utf8'), big, 'файл в downloads/ содержит результат');
  assert.equal(res.data.untrusted_page_content, true);
  const entry = auditLines().find((e) => e.kind === 'eval' && e.decision === 'eval_exec_relayed');
  assert.ok(entry, 'релейный eval тоже аудируется');
});

test('page.eval: исключение в странице → EVAL_ERROR, eval_error в аудите', async () => {
  prime();
  mock.tabs.get(1).evalError = 'ReferenceError: nope is not defined';
  const res = await handle.core.callTool('page.eval', { tabId: 1, expression: 'nope()' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'EVAL_ERROR');
  const entry = auditLines().find((e) => e.kind === 'eval' && e.decision === 'eval_error');
  assert.ok(entry, 'ошибка eval тоже аудируется');
});

test('page.eval: CSP запретил MAIN-world runner → EVAL_UNAVAILABLE', async () => {
  prime();
  mock.tabs.get(1).evalUnavailable = true;
  const res = await handle.core.callTool('page.eval', { tabId: 1, expression: '1+1' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'EVAL_UNAVAILABLE');
});

test('page.eval: пустое expression → ошибка до обращения к вкладке', async () => {
  prime();
  const res = await handle.core.callTool('page.eval', { tabId: 1, expression: '   ' });
  assert.equal(res.ok, false);
  assert.equal(mock.actions.length, 0);
});
