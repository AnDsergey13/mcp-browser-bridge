// policy.test.mjs — сценарии приёмки фазы 3 (policy engine).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTempEnv, startTestBridge, waitFor, FORM_TAB, TEST_POLICY } from './helpers.mjs';
import { MockExtension } from './mock-extension.mjs';

let env, handle, mock;

// node:test не даёт t в before — фиктивный контекст для хуков очистки.
const cleanups = [];
const t0 = { after: (fn) => cleanups.push(fn) };

before(async () => {
  env = makeTempEnv(t0);
  handle = await startTestBridge(t0, env);
  mock = new MockExtension({ secret: env.secret, tabs: [FORM_TAB], consent: 'allow' });
  await mock.connect(handle.port);
  await mock.approve();
});

after(async () => {
  mock?.close();
  for (const fn of cleanups.reverse()) await fn();
});

async function primeTab() {
  const list = await handle.core.callTool('tab.list', {});
  assert.equal(list.ok, true);
  const snap = await handle.core.callTool('page.snapshot', { tabId: 1 });
  assert.equal(snap.ok, true, JSON.stringify(snap));
  assert.equal(snap.data.untrusted_page_content, true); // N15
}

test('(a) команда на домене вне грантов → DOMAIN_NOT_ALLOWED', async () => {
  const res = await handle.core.callTool('tab.open', { url: 'https://forbidden.example/checkout' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'DOMAIN_NOT_ALLOWED');
  assert.match(res.hint, /forbidden\.example/);
  assert.equal(res.policy_reminder.preset, 'test');
});

test('(б) submit → consent deny → ACTION_DENIED', async () => {
  await primeTab();
  mock.consent = 'deny';
  const res = await handle.core.callTool('act.click', { tabId: 1, ref: 'e3' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'ACTION_DENIED');
  assert.equal(mock.consentRequests.at(-1).category, 'submit');
  assert.equal(mock.consentRequests.at(-1).domain, 'localhost:8080');
});

test('(б2) submit → consent timeout → ACTION_DENIED', async () => {
  mock.consent = 'timeout';
  const res = await handle.core.callTool('act.click', { tabId: 1, ref: 'e3' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'ACTION_DENIED');
});

test('(в) localhost:8080 login с override auto → без consent', async () => {
  const before = mock.consentRequests.length;
  const res = await handle.core.callTool('act.type', { tabId: 1, ref: 'e2', text: 's3cret' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(mock.consentRequests.length, before, 'consent.ask не должен отправляться');
});

test('hard_floor: pay:auto без allow_unsafe зажат до confirm (N16)', async () => {
  // В resolved-виде для расширения pay зажат hard_floor'ом до confirm.
  const initial = mock.policyUpdates[0];
  assert.equal(initial.domains['localhost:8080'].gated.pay, 'confirm');
  // Клик по «Оплатить заказ» → обязан прийти consent.ask категории pay (не auto).
  mock.consent = 'allow';
  const before = mock.consentRequests.length;
  const res = await handle.core.callTool('act.click', { tabId: 1, ref: 'e4' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(mock.consentRequests.length, before + 1);
  assert.equal(mock.consentRequests.at(-1).category, 'pay');
});

test('(г) hot-reload policy.yaml → policy.update прилетает расширению', async () => {
  const versionBefore = mock.policyUpdates.at(-1).version;
  const updated = TEST_POLICY.replace('Тестовый пресет', 'Тестовый пресет v2');
  fs.writeFileSync(env.policyPath, updated);
  const upd = await mock.waitForPolicyUpdate((v) => v.version > versionBefore, 5000);
  assert.equal(upd.preset, 'test');
  // Агент видит новые данные в следующем ответе.
  const status = await handle.core.callTool('policy.status', {});
  assert.equal(status.data.preset_description, 'Тестовый пресет v2');
});

test('(д) policy.request_preset → consent.ask custom → после allow пресет переключён', async () => {
  mock.consent = (p) => {
    assert.equal(p.category, 'custom');
    assert.match(p.description, /other/);
    return 'allow';
  };
  const versionBefore = mock.policyUpdates.at(-1).version;
  const res = await handle.core.callTool('policy.request_preset', { name: 'other' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.preset, 'other');
  assert.equal(res.data.switched, true);
  await mock.waitForPolicyUpdate((v) => v.preset === 'other' && v.version > versionBefore, 5000);
  const status = await handle.core.callTool('policy.status', {});
  assert.equal(status.data.preset, 'other');
  assert.deepEqual(status.data.paused, { global: false, auto_tabs: [] });
});

test('policy.request_preset deny → ACTION_DENIED', async () => {
  mock.consent = 'deny';
  const res = await handle.core.callTool('policy.request_preset', { name: 'test' });
  assert.equal(res.ok, false);
  assert.equal(res.error_code, 'ACTION_DENIED');
  const status = await handle.core.callTool('policy.status', {});
  assert.equal(status.data.preset, 'other', 'пресет не должен переключиться');
  mock.consent = 'allow';
});

test('разовый грант: add → домен в policy.update; remove → домен исчезает', async () => {
  const versionBefore = mock.policyUpdates.at(-1).version;
  handle.policy.addSessionGrant('example.org', ['read', 'interact']);
  const upd1 = await mock.waitForPolicyUpdate((v) => v.version > versionBefore, 5000);
  assert.equal(upd1.domains['example.org'].source, 'session');
  assert.ok(upd1.match_patterns.includes('*://*.example.org/*'));
  // Отзыв (жест пользователя в popup → grant.remove): домен выпадает из update.
  assert.equal(handle.policy.removeSessionGrant('example.org'), true);
  const upd2 = await mock.waitForPolicyUpdate((v) => v.version > upd1.version, 5000);
  assert.ok(!upd2.domains['example.org']);
  assert.ok(!upd2.match_patterns.includes('*://*.example.org/*'));
  assert.equal(handle.policy.removeSessionGrant('example.org'), false, 'повторный отзыв — false');
});

test('аудит (N17): решения grant/deny/override пишутся в policy-audit.jsonl', async () => {
  const auditPath = env.memoryDir + '/policy-audit.jsonl';
  await waitFor(() => fs.existsSync(auditPath) && fs.readFileSync(auditPath, 'utf8').length > 0);
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(lines.some((l) => l.kind === 'override' && l.reason?.includes('hard_floor')), 'hard_floor override в аудите');
  assert.ok(lines.some((l) => l.kind === 'deny' && l.decision === 'consent_deny'), 'consent deny в аудите');
  assert.ok(lines.some((l) => l.kind === 'deny' && l.decision === 'DOMAIN_NOT_ALLOWED'), 'domain deny в аудите');
  assert.ok(lines.some((l) => l.kind === 'grant'), 'grant в аудите');
});

test('журнал (фаза 6 п.1): tool calls пишутся в journal.jsonl', async () => {
  const journalPath = env.memoryDir + '/journal.jsonl';
  assert.ok(fs.existsSync(journalPath));
  const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse);
  const click = lines.find((l) => l.tool === 'act.click');
  assert.ok(click, 'act.click в журнале');
  assert.ok(click.ts && click.args_digest?.sha256 && click.result_digest?.sha256);
  assert.equal(click.tabId, 1);
  assert.match(click.url, /localhost:8080/);
});
