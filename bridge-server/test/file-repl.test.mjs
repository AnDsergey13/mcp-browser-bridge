// file-repl.test.mjs — файл-REPL (opts.fileRepl): cmd.json → result.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempEnv, startTestBridge, waitFor } from './helpers.mjs';

test('file-repl: policy.status через cmd.json → result.json', async (t) => {
  const env = makeTempEnv(t);
  const cmdPath = path.join(env.dir, 'cmd.json');
  const resPath = path.join(env.dir, 'result.json');
  await startTestBridge(t, env, { fileRepl: cmdPath });

  fs.writeFileSync(cmdPath, JSON.stringify({ tool: 'policy.status', args: {} }));
  const res = await waitFor(() =>
    (!fs.existsSync(cmdPath) && fs.existsSync(resPath))
      ? JSON.parse(fs.readFileSync(resPath, 'utf8')) : undefined);
  assert.equal(res.ok, true);
  assert.equal(res.data.preset, 'test');
});

test('file-repl: неизвестный инструмент → ok:false, REPL жив', async (t) => {
  const env = makeTempEnv(t);
  const cmdPath = path.join(env.dir, 'cmd.json');
  const resPath = path.join(env.dir, 'result.json');
  await startTestBridge(t, env, { fileRepl: cmdPath });

  fs.writeFileSync(cmdPath, JSON.stringify({ tool: 'no.such.tool', args: {} }));
  const res = await waitFor(() =>
    (!fs.existsSync(cmdPath) && fs.existsSync(resPath))
      ? JSON.parse(fs.readFileSync(resPath, 'utf8')) : undefined);
  assert.equal(res.ok, false);

  // REPL не умер после ошибки — следующая команда обрабатывается.
  fs.writeFileSync(cmdPath, JSON.stringify({ tool: 'policy.status', args: {} }));
  const res2 = await waitFor(() => {
    if (fs.existsSync(cmdPath) || !fs.existsSync(resPath)) return undefined;
    const r = JSON.parse(fs.readFileSync(resPath, 'utf8'));
    return r.ok === true ? r : undefined;
  });
  assert.equal(res2.data.preset, 'test');
});
