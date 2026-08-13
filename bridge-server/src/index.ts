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
    sendAck: (transferId, seq) => transport.sendEvent('file.ack', { transferId, seq }),
  });
  const pacing = new Pacing(() => policy.pacing());
  const core = new BridgeCore({
    transport, policy, pacing, memory, downloads, log,
    consentTimeoutMs: opts.consentTimeoutMs ?? numEnv('BRIDGE_CONSENT_TIMEOUT_MS', 120_000),
  });

  // --- связывание ---
  policy.onChange = (view) => transport.sendEvent('policy.update', view as unknown as Record<string, unknown>);
  transport.onApproved = () => transport.sendEvent('policy.update', policy.buildPolicyUpdate() as unknown as Record<string, unknown>);
  transport.onStateChange = (state) => { if (state === 'offline') downloads.resetAll('BROWSER_OFFLINE'); };
  transport.onEvent = (event, data) => {
    if (downloads.handleEvent(event, data)) return;
    core.handlePauseEvent(event, data);
  };
  transport.registerExtHandler('grant.add', (params) => {
    const domain = String(params['domain'] ?? '');
    const capabilities = (Array.isArray(params['capabilities']) ? params['capabilities'] : []) as Capability[];
    if (!domain) return { granted: false };
    policy.addSessionGrant(domain, capabilities);
    return { granted: true };
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

  return {
    port, secret, core, transport, policy,
    close: async () => {
      policy.stopWatch();
      await transport.close();
    },
  };
}

function numEnv(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  startBridge().catch((err) => {
    console.error(`[bridge] fatal: ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
