// transport.ts — WS-сервер для расширения (PROTOCOL.md §1-3):
// hello/auth, session.approve/deny, heartbeat (ping 15s / offline 45s),
// BROWSER_OFFLINE без очередей, маршрутизация req/res/evt.
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type SessionState = 'offline' | 'pending_approval' | 'active' | 'denied';

type ExtReqHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;
type EvtHandler = (event: string, data: Record<string, unknown>) => void;

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
  private approvedOnce = false; // сессия была подтверждена (живёт до рестарта сервера)
  private ws: WebSocket | null = null;
  private state: SessionState = 'offline';
  private lastPong = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private pending = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (err: BridgeError) => void;
    timer: NodeJS.Timeout;
  }>();

  private extReqHandlers = new Map<string, ExtReqHandler>();
  /** presets, отдаваемые в ответе на hello. */
  presetsProvider: () => string[] = () => [];
  /** вызывается после session.approve (сервер должен отправить policy.update). */
  onApproved: (() => void) | null = null;
  onEvent: EvtHandler = () => {};
  onStateChange: ((state: SessionState) => void) | null = null;

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

  getState(): SessionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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

  private setState(s: SessionState): void {
    if (this.state === s) return;
    this.state = s;
    this.log(`transport: состояние → ${s}`);
    if (this.onStateChange) this.onStateChange(s);
  }

  private onConnection(ws: WebSocket): void {
    // Одно соединение расширения; новое заменяет старое.
    if (this.ws && this.ws !== ws) {
      this.log('transport: новое соединение заменяет прежнее');
      this.dropSocket(this.ws);
    }
    this.ws = ws;
    this.lastPong = Date.now();
    this.setState('pending_approval'); // до hello считаем, что ждём подтверждения
    ws.on('message', (raw) => this.onMessage(ws, raw.toString()));
    ws.on('pong', () => { this.lastPong = Date.now(); });
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => {});
    this.startHeartbeat(ws);
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws) { this.stopHeartbeat(); return; }
      if (Date.now() - this.lastPong > this.offlineTimeoutMs) {
        this.log('transport: heartbeat timeout → offline');
        this.dropSocket(ws);
        return;
      }
      try { ws.ping(); } catch { /* сокет уже мёртв */ }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private dropSocket(ws: WebSocket): void {
    try { ws.terminate(); } catch { /* ignore */ }
    this.onClose(ws);
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return; // старое соединение, уже заменено
    this.ws = null;
    this.stopHeartbeat();
    // Очередей нет: все незавершённые req → BROWSER_OFFLINE.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError('BROWSER_OFFLINE', 'соединение с браузером потеряно'));
      this.pending.delete(id);
    }
    this.setState('offline');
  }

  private send(obj: unknown): void {
    if (this.isConnected()) this.ws!.send(JSON.stringify(obj));
  }

  /** Сервер → расширение req. Без активной сессии — немедленная ошибка (очередей нет). */
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (!this.isConnected() || this.state === 'offline') {
      return Promise.reject(new BridgeError('BROWSER_OFFLINE', 'расширение не подключено'));
    }
    if (this.state === 'pending_approval') {
      return Promise.reject(new BridgeError('SESSION_NOT_APPROVED', 'сессия не подтверждена пользователем'));
    }
    if (this.state === 'denied') {
      return Promise.reject(new BridgeError('SESSION_DENIED', 'сессия отклонена пользователем'));
    }
    const id = `m_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('TIMEOUT', `нет ответа на ${method} за ${timeoutMs ?? this.reqTimeoutMs} мс`));
      }, timeoutMs ?? this.reqTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'req', id, method, params });
    });
  }

  sendEvent(event: string, data: Record<string, unknown>): void {
    this.send({ type: 'evt', event, data });
  }

  private async onMessage(ws: WebSocket, text: string): Promise<void> {
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
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      const err = msg['error'] as { code?: string; message?: string } | undefined;
      if (err) p.reject(new BridgeError(err.code ?? 'INTERNAL', err.message ?? err.code ?? 'error'));
      else p.resolve(msg['result']);
      return;
    }
    if (type === 'evt') {
      this.onEvent(String(msg['event'] ?? ''), (msg['data'] ?? {}) as Record<string, unknown>);
      return;
    }
    if (type === 'req') {
      const id = String(msg['id'] ?? '');
      const method = String(msg['method'] ?? '');
      const params = (msg['params'] ?? {}) as Record<string, unknown>;
      try {
        const result = await this.handleExtRequest(ws, method, params);
        this.send({ type: 'res', id, result: result ?? {} });
      } catch (err) {
        const be = err as Partial<BridgeError>;
        this.send({ type: 'res', id, error: { code: be.code ?? 'INTERNAL', message: be.message ?? String(err) } });
      }
    }
  }

  private async handleExtRequest(ws: WebSocket, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'hello': {
        const secret = String(params['secret'] ?? '');
        const a = Buffer.from(secret);
        const b = Buffer.from(this.secret);
        const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!ok) {
          this.log('transport: AUTH_FAILED, закрываю сокет');
          // res с ошибкой отправится из onMessage, сокет закрываем после.
          setImmediate(() => { try { ws.close(); } catch { /* ignore */ } });
          throw new BridgeError('AUTH_FAILED', 'неверный секрет');
        }
        this.log(`transport: hello ok (ext ${params['ext_version'] ?? '?'}, ${params['browser'] ?? '?'})`);
        // Переподключение в рамках той же серверной сессии — без повторного
        // подтверждения (протокол §3: approve заново только при смене
        // server_session_id, т.е. новый запуск сервера/контейнера).
        if (this.approvedOnce) {
          this.setState('active');
          setImmediate(() => { if (this.onApproved) this.onApproved!(); });
          return { status: 'active', server_session_id: this.sessionId, presets: this.presetsProvider() };
        }
        this.setState('pending_approval');
        return { status: 'pending_approval', server_session_id: this.sessionId, presets: this.presetsProvider() };
      }
      case 'session.approve': {
        this.approvedOnce = true;
        this.setState('active');
        if (this.onApproved) setImmediate(() => this.onApproved!());
        return { status: 'active' };
      }
      case 'session.deny': {
        this.setState('denied');
        return { status: 'denied' };
      }
      default: {
        const handler = this.extReqHandlers.get(method);
        if (!handler) throw new BridgeError('INTERNAL', `неизвестный метод: ${method}`);
        return handler(params);
      }
    }
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    if (this.ws) this.dropSocket(this.ws);
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
