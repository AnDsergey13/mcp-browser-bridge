// helpers.mjs — временные окружения для тестов (не портят рабочие файлы).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_POLICY = `version: 2
active_preset: test
default: deny
gated_defaults: { pay: confirm, login: confirm, submit: confirm, delete: confirm }
hard_floor: { pay: confirm }
pacing: { min_delay_ms: 0, max_delay_ms: 0, max_actions_per_minute: 1000 }
presets:
  test:
    description: "Тестовый пресет"
    domains:
      "localhost:8080":
        capabilities: [read, interact, download]
        gated: { login: auto, submit: confirm, delete: confirm, pay: auto }
      "allowed.example":
        capabilities: [read, interact, download]
      "readonly.example":
        capabilities: [read, interact]
  other:
    description: "Другой пресет"
    domains:
      "other.example":
        capabilities: [read]
`;

export function makeTempEnv(t, policyYaml = TEST_POLICY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const memoryDir = path.join(dir, 'memory');
  const downloadsDir = path.join(dir, 'downloads');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.join(memoryDir, 'domains'), { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  const policyPath = path.join(dir, 'policy.yaml');
  fs.writeFileSync(policyPath, policyYaml);
  const secret = 'test-secret-' + Math.random().toString(36).slice(2);
  const secretPath = path.join(dir, 'secret');
  fs.writeFileSync(secretPath, secret + '\n', { mode: 0o600 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, policyPath, secretPath, memoryDir, downloadsDir, secret };
}

export async function startTestBridge(t, env, extra = {}) {
  const { startBridge } = await import('../src/index.ts');
  const handle = await startBridge({
    port: 0,
    host: '127.0.0.1',
    mcp: false,
    log: () => {},
    policyPath: env.policyPath,
    memoryDir: env.memoryDir,
    downloadsDir: env.downloadsDir,
    secretPath: env.secretPath,
    consentTimeoutMs: 300,
    unixSocket: false,
    ...extra,
  });
  t.after(() => handle.close());
  return handle;
}

export function waitFor(fn, timeoutMs = 5000, intervalMs = 25) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try { v = fn(); } catch { v = undefined; }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export const FORM_TAB = {
  tabId: 1,
  url: 'http://localhost:8080/form',
  title: 'Form',
  flags: ['login_form'],
  snapshot: [
    'url: http://localhost:8080/form',
    'title: Form',
    '[e1] textbox name=user placeholder="Логин" value=""',
    '[e2] textbox name=pass type=password',
    '[e3] button "Отправить" type=submit',
    '[e4] button "Оплатить заказ"',
    '[e5] button "Удалить аккаунт"',
    '[e6] link "Войти" → /login',
    'Текст формы…',
  ].join('\n'),
  markdown: '# Form\n\nТекст формы…',
};
