// index.ts — entry: WS-сервер для расширения (0.0.0.0:18777) + MCP-сервер (stdio)
// одновременно. Все логи — в stderr (stdout занят MCP stdio).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Transport } from './transport.ts';
import { PolicyEngine, type Capability } from './policy.ts';
import { Pacing } from './pacing.ts';
import { MemoryStore } from './memory.ts';
import { DownloadRelay } from './downloads.ts';
import { BridgeCore, buildMcpServer } from './mcp.ts';

export interface BridgeOptions {
  port?: number;
  host?: string;
  secretPath?: string;
  policyPath?: string;
  memoryDir?: string;
  downloadsDir?: string;
  consentTimeoutMs?: number;
  reqTimeoutMs?: number;
  heartbeatMs?: number;
  offlineTimeoutMs?: number;
  /** false — не поднимать MCP stdio (для in-process тестов). */
  mcp?: boolean;
  /** Путь unix-сокета; false — не слушать (в тестах обязательно false). */
  unixSocket?: string | false;
  /**
   * Файл-REPL: путь к cmd.json (результат — result.json рядом); false —
   * выключен. Позволяет скриптам (hls-download.py, localize-page.py) ходить
   * через тот же процесс, что держит MCP/сокет. По умолчанию выключен;
   * боевой entry (isMain) включает явно.
   */
  fileRepl?: string | false;
  log?: (msg: string) => void;
}

export interface BridgeHandle {
  port: number;
  secret: string;
  core: BridgeCore;
  transport: Transport;
  policy: PolicyEngine;
  close: () => Promise<void>;
}

/** Секрет: читаем или генерируем при первом запуске (0600, печатаем в лог). */
export function loadOrCreateSecret(secretPath: string, log: (msg: string) => void): string {
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing) return existing;
  } catch { /* нет файла — создадим */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, secret + '\n', { mode: 0o600 });
  fs.chmodSync(secretPath, 0o600);
  log(`secret: сгенерирован новый секрет в ${secretPath} (0600): ${secret}`);
  return secret;
}

export async function startBridge(opts: BridgeOptions = {}): Promise<BridgeHandle> {
  const log = opts.log ?? ((msg: string) => console.error(`[bridge] ${msg}`));
  const policyPath = opts.policyPath ?? process.env.BRIDGE_POLICY_PATH ?? '/workspace/policy.yaml';
  const memoryDir = opts.memoryDir ?? process.env.BRIDGE_MEMORY_DIR ?? '/workspace/memory';
  const downloadsDir = opts.downloadsDir ?? process.env.BRIDGE_DOWNLOADS_DIR ?? '/workspace/downloads';
  const secretPath = opts.secretPath ?? process.env.BRIDGE_SECRET_PATH ?? '/workspace/.bridge/secret';

  const secret = loadOrCreateSecret(secretPath, log);

  const policy = new PolicyEngine({ policyPath, memoryDir, log });
  policy.load();
  policy.startWatch();

  const transport = new Transport({
    secret, log,
    heartbeatMs: opts.heartbeatMs ?? numEnv('BRIDGE_HEARTBEAT_MS', 15_000),
    offlineTimeoutMs: opts.offlineTimeoutMs ?? numEnv('BRIDGE_OFFLINE_TIMEOUT_MS', 45_000),
    reqTimeoutMs: opts.reqTimeoutMs ?? numEnv('BRIDGE_REQ_TIMEOUT_MS', 30_000),
  });
  transport.presetsProvider = () => policy.presetNames();

  const memory = new MemoryStore({ memoryDir, log });
  const downloads = new DownloadRelay({
    downloadsDir, log,
    // ack — только клиенту-владельцу трансфера (D6/D7).
    sendAck: (transferId, seq, clientId) => transport.sendEvent(clientId, 'file.ack', { transferId, seq }),
  });
  const pacing = new Pacing(() => policy.pacing());
  const core = new BridgeCore({
    transport, policy, pacing, memory, downloads, log,
    consentTimeoutMs: opts.consentTimeoutMs ?? numEnv('BRIDGE_CONSENT_TIMEOUT_MS', 120_000),
  });

  // --- связывание ---
  // D4/D6: policy.update — per-client (у каждого браузера свой вид доменов).
  const pushPolicyUpdate = (clientId: string) =>
    transport.sendEvent(clientId, 'policy.update', policy.buildPolicyUpdate(clientId) as unknown as Record<string, unknown>);
  policy.onChange = () => {
    for (const c of transport.listClients()) {
      if (c.state === 'active' || c.state === 'pending_approval') pushPolicyUpdate(c.id);
    }
  };
  transport.onApproved = (clientId) => pushPolicyUpdate(clientId);
  // Дисконнект клиента рвёт только ЕГО трансферы и ожидания (D7).
  transport.onStateChange = (clientId, state) => { if (state === 'offline') downloads.resetClient(clientId, 'BROWSER_OFFLINE'); };
  transport.onEvent = (event, data, clientId) => {
    if (downloads.handleEvent(event, data, clientId)) return;
    core.handlePauseEvent(event, data, clientId);
  };
  transport.registerExtHandler('grant.add', (params, clientId) => {
    // Replace-семантика: popup шлёт полный набор capabilities (чекбоксы);
    // повторная выдача = редактирование. Невалидные capability отбрасываем.
    // D4: грант привязан к браузеру-источнику (в другом браузере не действует).
    const domain = String(params['domain'] ?? '');
    const VALID: Capability[] = ['read', 'interact', 'download'];
    const capabilities = (Array.isArray(params['capabilities']) ? params['capabilities'] : [])
      .filter((c): c is Capability => VALID.includes(c as Capability));
    if (!domain) return { granted: false };
    policy.setSessionGrant(domain, capabilities, clientId || undefined);
    return { granted: true };
  });
  transport.registerExtHandler('grant.remove', (params, clientId) => {
    // Отзыв разового гранта — жест пользователя в popup (политику меняет только человек).
    const domain = String(params['domain'] ?? '');
    if (!domain) return { removed: false };
    return { removed: policy.removeSessionGrant(domain, clientId || undefined) };
  });
  transport.registerExtHandler('preset.switch', (params) => {
    const name = String(params['name'] ?? '');
    policy.setActivePreset(name); // popup — user gesture, разрешено всегда
    return { preset: policy.activePreset() };
  });

  const port = await transport.listen(
    opts.port ?? numEnv('BRIDGE_PORT', 18_777),
    opts.host ?? process.env.BRIDGE_HOST ?? '0.0.0.0',
  );
  // Unix-сокет в общей bind-mount папке: хост подключается к нему напрямую,
  // минуя сетевую изоляцию rootless podman (BRIDGE_UNIX_SOCKET=0 отключает).
  const envSock = process.env.BRIDGE_UNIX_SOCKET;
  const unixSocket = opts.unixSocket ?? (envSock === '0' ? false : envSock ?? '/workspace/.bridge/bridge.sock');
  if (unixSocket) await transport.listenUnix(unixSocket);
  log(`готов: WS порт ${port}, пресет "${policy.activePreset()}", session ${transport.sessionId}`);

  if (opts.mcp !== false && process.env.BRIDGE_MCP !== '0') {
    const mcpServer = buildMcpServer(core);
    await mcpServer.connect(new StdioServerTransport());
    log('MCP stdio: подключено');
  }

  // Файл-REPL (по умолчанию выключен; в тестах не включать): скрипты пишут
  // {"tool","args"} в cmd.json и забирают результат из result.json рядом.
  const fileRepl = opts.fileRepl ??
    (process.env.BRIDGE_FILE_REPL && process.env.BRIDGE_FILE_REPL !== '0'
      ? process.env.BRIDGE_FILE_REPL : false);
  const stopRepl = fileRepl ? startFileRepl(fileRepl, core, log) : null;

  return {
    port, secret, core, transport, policy,
    close: async () => {
      stopRepl?.();
      policy.stopWatch();
      await transport.close();
    },
  };
}

/** Файл-REPL поверх живого сервера. Возвращает функцию остановки. */
function startFileRepl(cmdPath: string, core: BridgeCore, log: (msg: string) => void): () => void {
  const resPath = path.join(path.dirname(cmdPath), 'result.json');
  try { fs.unlinkSync(cmdPath); } catch { /* не было — ок */ }
  const timer = setInterval(async () => {
    if (!fs.existsSync(cmdPath)) return;
    let cmd: { tool?: string; args?: Record<string, unknown> };
    try { cmd = JSON.parse(fs.readFileSync(cmdPath, 'utf8')); } catch { return; }
    fs.unlinkSync(cmdPath);
    try {
      const payload = await core.callTool(String(cmd.tool), cmd.args ?? {}, { uncap: true });
      fs.writeFileSync(resPath, JSON.stringify(payload, null, 2));
    } catch (e) {
      fs.writeFileSync(resPath, JSON.stringify({ ok: false, error_code: 'DRIVER_ERROR', message: String(e) }));
    }
    log(`file-repl: выполнено ${String(cmd.tool)}`);
  }, 700);
  log(`file-repl: слушаю ${cmdPath}`);
  return () => clearInterval(timer);
}

function numEnv(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  // Боевой запуск (MCP-сервер Kimi Code): файл-REPL включён по умолчанию,
  // чтобы scripts/*.py работали через тот же процесс (BRIDGE_FILE_REPL=0 —
  // отключить, или путь к cmd.json).
  startBridge({ fileRepl: process.env.BRIDGE_FILE_REPL ?? '/workspace/.bridge/cmd.json' }).catch((err) => {
    console.error(`[bridge] fatal: ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
