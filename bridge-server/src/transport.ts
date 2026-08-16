// transport.ts — WS-сервер для расширений (PROTOCOL.md §1-3, §11):
// hello/auth, session.approve/deny, heartbeat (ping 15s / offline 45s),
// BROWSER_OFFLINE без очередей, маршрутизация req/res/evt.
// Фаза 9 (D1–D3, D6): мультиклиентность — Map<clientId, Connection>,
// clientId = browser из hello; per-client состояния, approve переживает
// реконнект в рамках серверной сессии; события тегируются clientId.
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export class BridgeError extends Error {
  code: string;
  /** Доп. данные для конверта ошибки (напр. прогресс act.batch при BATCH_STEP_FAILED). */
  data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export type SessionState = 'offline' | 'pending_approval' | 'active' | 'denied';

export interface ClientInfo {
  id: string;
  browser: string;
  state: SessionState;
  ext_version: string;
  ua: string;
}

interface PendingReq {
  resolve: (result: unknown) => void;
  reject: (err: BridgeError) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  ws: WebSocket | null; // null — клиент известен, но сокет мёртв (offline)
  clientId: string | null; // до hello соединение безымянное
  browser: string;
  ext_version: string;
  ua: string;
  lastPong: number;
  heartbeatTimer: NodeJS.Timeout | null;
  state: SessionState;
  /** true, когда сокет заменён переподключением — close старого игнорируем. */
  replaced: boolean;
  pending: Map<string, PendingReq>;
}

type ExtReqHandler = (params: Record<string, unknown>, clientId: string) => unknown | Promise<unknown>;
type EvtHandler = (event: string, data: Record<string, unknown>, clientId: string) => void;

const DEFAULT_REQ_TIMEOUT_MS = 30_000;

export class Transport {
  private log: (msg: string) => void;
  private secret: string;
  readonly sessionId: string;
  private heartbeatMs: number;
  private offlineTimeoutMs: number;
  private reqTimeoutMs: number;

  private wss: WebSocketServer | null = null;
  private extraWss: WebSocketServer[] = [];
  private extraHttp: http.Server[] = [];
  /** Именованные клиенты (прошли hello). Переживают дисконнект как offline-записи. */
  private clients = new Map<string, Connection>();
  /** Соединения до hello (clientId назначается в момент hello). */
  private unnamed = new Set<Connection>();
  /** clientId'ы, подтверждённые в рамках этой серверной сессии (D2: реконнект — без повторного approve). */
  private approvedClients = new Set<string>();
  private seq = 0;

  private extReqHandlers = new Map<string, ExtReqHandler>();
  /** presets, отдаваемые в ответе на hello. */
  presetsProvider: () => string[] = () => [];
  /** вызывается после session.approve (сервер должен отправить policy.update клиенту). */
  onApproved: ((clientId: string) => void) | null = null;
  onEvent: EvtHandler = () => {};
  onStateChange: ((clientId: string, state: SessionState) => void) | null = null;

  constructor(opts: {
    secret: string;
    log?: (msg: string) => void;
    heartbeatMs?: number;
    offlineTimeoutMs?: number;
    reqTimeoutMs?: number;
  }) {
    this.secret = opts.secret;
    this.log = opts.log ?? (() => {});
    this.sessionId = crypto.randomBytes(8).toString('hex');
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.offlineTimeoutMs = opts.offlineTimeoutMs ?? 45_000;
    this.reqTimeoutMs = opts.reqTimeoutMs ?? DEFAULT_REQ_TIMEOUT_MS;
  }

  /** Состояние клиента; неизвестный clientId — 'offline'. */
  getState(clientId: string): SessionState {
    return this.clients.get(clientId)?.state ?? 'offline';
  }

  isConnected(clientId: string): boolean {
    const c = this.clients.get(clientId);
    return Boolean(c?.ws && c.ws.readyState === WebSocket.OPEN);
  }

  /** Снимок известных клиентов (для policy.status / диагностики). */
  listClients(): ClientInfo[] {
    return [...this.clients.entries()].map(([id, c]) => ({
      id, browser: c.browser, state: c.state, ext_version: c.ext_version, ua: c.ua,
    }));
  }

  registerExtHandler(method: string, handler: ExtReqHandler): void {
    this.extReqHandlers.set(method, handler);
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port, host });
      this.wss.on('error', reject);
      this.wss.on('listening', () => {
        const addr = this.wss!.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        this.log(`transport: WS слушает ${host}:${actualPort}`);
        resolve(actualPort);
      });
      this.wss.on('connection', (ws) => this.onConnection(ws));
    });
  }

  /** Дополнительный вход через unix-сокет (обход сети: сокет в общей
   *  bind-mount папке виден хосту как обычный файл — приём docker.sock). */
  listenUnix(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try { fs.unlinkSync(socketPath); } catch { /* не было — ок */ }
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      const httpServer = http.createServer((req, res) => {
        // не-WS запросы (curl-проверка) — как у ws по умолчанию
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('Upgrade Required');
      });
      const wss = new WebSocketServer({ server: httpServer });
      this.extraWss.push(wss);
      this.extraHttp.push(httpServer);
      wss.on('error', reject);
      wss.on('connection', (ws) => this.onConnection(ws));
      httpServer.on('error', reject);
      httpServer.listen(socketPath, () => {
        this.log(`transport: WS слушает unix:${socketPath}`);
        resolve();
      });
    });
  }

  private setState(conn: Connection, s: SessionState): void {
    if (conn.state === s) return;
    conn.state = s;
    this.log(`transport: ${conn.clientId ?? '(безымянный)'} состояние → ${s}`);
    if (this.onStateChange && conn.clientId) this.onStateChange(conn.clientId, s);
  }

  private onConnection(ws: WebSocket): void {
    // До hello соединение безымянное; clientId назначит hello (params.browser).
    const conn: Connection = {
      ws, clientId: null, browser: '', ext_version: '', ua: '',
      lastPong: Date.now(), heartbeatTimer: null,
      state: 'pending_approval', replaced: false, pending: new Map(),
    };
    this.unnamed.add(conn);
    ws.on('message', (raw) => this.onMessage(conn, raw.toString()));
    ws.on('pong', () => { conn.lastPong = Date.now(); });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => {});
    this.startHeartbeat(conn);
  }

  private startHeartbeat(conn: Connection): void {
    this.stopHeartbeat(conn);
    conn.heartbeatTimer = setInterval(() => {
      if (conn.replaced || !conn.ws) { this.stopHeartbeat(conn); return; }
      if (Date.now() - conn.lastPong > this.offlineTimeoutMs) {
        this.log(`transport: ${conn.clientId ?? '(безымянный)'} heartbeat timeout → offline`);
        this.dropSocket(conn);
        return;
      }
      try { conn.ws.ping(); } catch { /* сокет уже мёртв */ }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(conn: Connection): void {
    if (conn.heartbeatTimer) { clearInterval(conn.heartbeatTimer); conn.heartbeatTimer = null; }
  }

  private dropSocket(conn: Connection): void {
    try { conn.ws?.terminate(); } catch { /* ignore */ }
    this.onClose(conn);
  }

  private onClose(conn: Connection): void {
    if (conn.replaced) return; // старый сокет, уже заменён переподключением
    this.stopHeartbeat(conn);
    conn.ws = null;
    this.unnamed.delete(conn);
    // Очередей нет: все незавершённые req ЭТОГО клиента → BROWSER_OFFLINE.
    for (const [id, p] of conn.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError('BROWSER_OFFLINE', 'соединение с браузером потеряно'));
      conn.pending.delete(id);
    }
    if (conn.clientId) this.setState(conn, 'offline');
  }

  private send(conn: Connection, obj: unknown): void {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(obj));
  }

  /** Сервер → расширение req конкретному клиенту. Без активной сессии — немедленная ошибка (очередей нет). */
  request(clientId: string, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const conn = this.clients.get(clientId);
    if (!conn || !this.isConnected(clientId) || conn.state === 'offline') {
      return Promise.reject(new BridgeError('BROWSER_OFFLINE', `расширение не подключено (browser: ${clientId})`));
    }
    if (conn.state === 'pending_approval') {
      return Promise.reject(new BridgeError('SESSION_NOT_APPROVED', 'сессия не подтверждена пользователем'));
    }
    if (conn.state === 'denied') {
      return Promise.reject(new BridgeError('SESSION_DENIED', 'сессия отклонена пользователем'));
    }
    const id = `m_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new BridgeError('TIMEOUT', `нет ответа на ${method} за ${timeoutMs ?? this.reqTimeoutMs} мс`));
      }, timeoutMs ?? this.reqTimeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      this.send(conn, { type: 'req', id, method, params });
    });
  }

  sendEvent(clientId: string, event: string, data: Record<string, unknown>): void {
    const conn = this.clients.get(clientId);
    if (conn) this.send(conn, { type: 'evt', event, data });
  }

  /** Событие всем подключённым именованным клиентам. */
  broadcast(event: string, data: Record<string, unknown>): void {
    for (const conn of this.clients.values()) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) this.send(conn, { type: 'evt', event, data });
    }
  }

  private async onMessage(conn: Connection, text: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.log('transport: невалидный JSON, игнор');
      return;
    }
    const type = msg['type'];
    if (type === 'res') {
      const id = String(msg['id'] ?? '');
      const p = conn.pending.get(id);
      if (!p) return;
      conn.pending.delete(id);
      clearTimeout(p.timer);
      const err = msg['error'] as { code?: string; message?: string } | undefined;
      if (err) p.reject(new BridgeError(err.code ?? 'INTERNAL', err.message ?? err.code ?? 'error'));
      else p.resolve(msg['result']);
      return;
    }
    if (type === 'evt') {
      // Безымянное соединение событий не шлёт (до hello их некому тегировать).
      this.onEvent(String(msg['event'] ?? ''), (msg['data'] ?? {}) as Record<string, unknown>, conn.clientId ?? '');
      return;
    }
    if (type === 'req') {
      const id = String(msg['id'] ?? '');
      const method = String(msg['method'] ?? '');
      const params = (msg['params'] ?? {}) as Record<string, unknown>;
      try {
        const result = await this.handleExtRequest(conn, method, params);
        this.send(conn, { type: 'res', id, result: result ?? {} });
      } catch (err) {
        const be = err as Partial<BridgeError>;
        this.send(conn, { type: 'res', id, error: { code: be.code ?? 'INTERNAL', message: be.message ?? String(err) } });
      }
    }
  }

  private async handleExtRequest(conn: Connection, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'hello': {
        const secret = String(params['secret'] ?? '');
        const a = Buffer.from(secret);
        const b = Buffer.from(this.secret);
        const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!ok) {
          this.log('transport: AUTH_FAILED, закрываю сокет');
          // res с ошибкой отправится из onMessage, сокет закрываем после.
          setImmediate(() => { try { conn.ws?.close(); } catch { /* ignore */ } });
          throw new BridgeError('AUTH_FAILED', 'неверный секрет');
        }
        // clientId = browser из hello (D1); без поля — 'default'.
        const clientId = String(params['browser'] ?? '') || 'default';
        this.log(`transport: hello ok от "${clientId}" (ext ${params['ext_version'] ?? '?'}, ${params['browser'] ?? '?'})`);
        // Переподключение того же браузера — замена старого сокета (per-client).
        const existing = this.clients.get(clientId);
        if (existing && existing !== conn) {
          this.log(`transport: "${clientId}" переподключился — заменяю прежний сокет`);
          existing.replaced = true;
          for (const [pid, p] of existing.pending) {
            clearTimeout(p.timer);
            p.reject(new BridgeError('BROWSER_OFFLINE', 'соединение заменено переподключением'));
            existing.pending.delete(pid);
          }
          this.stopHeartbeat(existing);
          try { existing.ws?.terminate(); } catch { /* ignore */ }
        }
        this.unnamed.delete(conn);
        conn.clientId = clientId;
        conn.browser = clientId;
        conn.ext_version = String(params['ext_version'] ?? '');
        conn.ua = String(params['ua'] ?? '');
        this.clients.set(clientId, conn);
        // Переподключение в рамках той же серверной сессии — без повторного
        // подтверждения (протокол §3: approve заново только при смене
        // server_session_id, т.е. новый запуск сервера/контейнера).
        if (this.approvedClients.has(clientId)) {
          this.setState(conn, 'active');
          setImmediate(() => { if (this.onApproved) this.onApproved!(clientId); });
          return { status: 'active', server_session_id: this.sessionId, presets: this.presetsProvider() };
        }
        this.setState(conn, 'pending_approval');
        return { status: 'pending_approval', server_session_id: this.sessionId, presets: this.presetsProvider() };
      }
      case 'session.approve': {
        if (!conn.clientId) throw new BridgeError('INTERNAL', 'session.approve до hello');
        this.approvedClients.add(conn.clientId);
        this.setState(conn, 'active');
        if (this.onApproved) setImmediate(() => this.onApproved!(conn.clientId!));
        return { status: 'active' };
      }
      case 'session.deny': {
        // deny не переживает реконнект (как и раньше): повторный hello → pending.
        this.setState(conn, 'denied');
        return { status: 'denied' };
      }
      default: {
        const handler = this.extReqHandlers.get(method);
        if (!handler) throw new BridgeError('INTERNAL', `неизвестный метод: ${method}`);
        return handler(params, conn.clientId ?? '');
      }
    }
  }

  async close(): Promise<void> {
    for (const conn of this.clients.values()) this.dropSocket(conn);
    for (const conn of this.unnamed) {
      conn.replaced = true;
      this.stopHeartbeat(conn);
      try { conn.ws?.terminate(); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await Promise.all(this.extraWss.map(
      (w) => new Promise<void>((resolve) => w.close(() => resolve())),
    ));
    await Promise.all(this.extraHttp.map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ));
  }
}
