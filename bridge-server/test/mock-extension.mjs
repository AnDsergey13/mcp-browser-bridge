// mock-extension.mjs — WS-клиент, играющий сторону расширения по PROTOCOL.md:
// hello → (approve по команде теста) → policy.update; ответы на page-команды из
// «виртуальных страниц»; consent.ask → scripted decision; файловый релей с ожиданием ack.
import WebSocket from 'ws';
import crypto from 'node:crypto';

export function shortHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

let tabSeq = 100;
let transferSeq = 0;

export class MockExtension {
  /**
   * @param opts.secret — секрет для hello
   * @param opts.browser — clientId для hello (default 'MockFox'); два мока с
   *   разными browser = мультиклиентские тесты (фаза 9)
   * @param opts.tabs — [{tabId, url, title, flags?, snapshot?, markdown?}]
   * @param opts.pages — {url: {title, snapshot, markdown, flags}} для tab.open
   * @param opts.consent — 'allow'|'deny'|'allow_10min'|'timeout'|function(params) => decision|'timeout'
   * @param opts.grantAsk — scripted decision для grant.ask (П2-5): 'allow'|'deny'|
   *   'timeout'|'throw'|function(params). На 'allow' мок, как background, сам шлёт
   *   grant.add (download, session) ДО ответа на req. Default 'deny' — существующие
   *   deny-тесты file.download не меняют поведения.
   * @param opts.fileToServe — {name, content:Buffer} для fetchFile
   */
  constructor(opts) {
    this.secret = opts.secret;
    this.browser = opts.browser ?? 'MockFox';
    this.tabs = new Map();
    for (const t of opts.tabs ?? []) {
      this.tabs.set(t.tabId, {
        tabId: t.tabId,
        url: t.url,
        title: t.title ?? t.url,
        flags: t.flags ?? [],
        snapshot: t.snapshot ?? `url: ${t.url}\ntitle: ${t.title ?? t.url}`,
        markdown: t.markdown ?? `# ${t.title ?? t.url}`,
      });
      tabSeq = Math.max(tabSeq, t.tabId);
    }
    this.pages = opts.pages ?? {};
    this.consent = opts.consent ?? 'allow';
    this.grantAsk = opts.grantAsk ?? 'deny';
    this.fileToServe = opts.fileToServe ?? null;
    this.fetchFails = false; // true → fetchFile отвечает ошибкой до file.start
    this.policyUpdates = [];
    this.consentRequests = [];
    this.grantAskRequests = [];
    this.ws = null;
    this.reqSeq = 0;
    this.pendingRes = new Map();   // e_<n> → {resolve, reject}
    this.ackWaiters = new Map();   // `${transferId}:${seq}` → resolve
    this.policyWaiters = [];       // {predicate, resolve, timer}
  }

  connect(port) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
      this.ws.on('error', reject);
      this.ws.on('open', () => {
        this.sendReq('hello', { secret: this.secret, ext_version: '0.0-test', browser: this.browser, ua: 'mock' })
          .then((res) => {
            // 'active' — реконнект уже подтверждённого клиента (фаза 9, D2).
            if (res.status !== 'pending_approval' && res.status !== 'active') return reject(new Error('unexpected hello res: ' + JSON.stringify(res)));
            this.helloRes = res;
            resolve(res);
          }, reject);
      });
      this.ws.on('message', (raw) => this.onMessage(raw.toString()));
    });
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  sendReq(method, params) {
    const id = `e_${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      this.pendingRes.set(id, { resolve, reject });
      this.send({ type: 'req', id, method, params });
    });
  }

  /** Подтверждение сессии (кнопка в popup). */
  async approve() {
    const res = await this.sendReq('session.approve', {});
    if (res.status !== 'active') throw new Error('approve failed: ' + JSON.stringify(res));
    return res;
  }

  /** Ожидание policy.update, удовлетворяющего предикату. */
  waitForPolicyUpdate(predicate, timeoutMs = 5000) {
    const existing = this.policyUpdates.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting policy.update')), timeoutMs);
      this.policyWaiters.push({ predicate, resolve, timer });
    });
  }

  async onMessage(text) {
    const msg = JSON.parse(text);
    if (msg.type === 'res') {
      const p = this.pendingRes.get(msg.id);
      if (p) {
        this.pendingRes.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.code + ': ' + msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.type === 'evt') {
      if (msg.event === 'policy.update') {
        this.policyUpdates.push(msg.data);
        const waiters = this.policyWaiters.splice(0);
        for (const w of waiters) {
          if (w.predicate(msg.data)) { clearTimeout(w.timer); w.resolve(msg.data); }
          else this.policyWaiters.push(w);
        }
      } else if (msg.event === 'file.ack') {
        const key = `${msg.data.transferId}:${msg.data.seq}`;
        const w = this.ackWaiters.get(key);
        if (w) { this.ackWaiters.delete(key); w(); }
      }
      return;
    }
    if (msg.type === 'req') {
      if (msg.method === 'fetchFile') this.pendingFetchReq = { id: msg.id };
      try {
        const result = await this.handleServerReq(msg.method, msg.params ?? {});
        if (result !== undefined) this.send({ type: 'res', id: msg.id, result });
        // undefined → отвечаем позже (fetchFile) или никогда (consent timeout)
      } catch (err) {
        this.send({ type: 'res', id: msg.id, error: { code: err.code ?? 'INTERNAL', message: err.message } });
      }
    }
  }

  tabOrThrow(tabId) {
    const t = this.tabs.get(tabId);
    if (!t) { const e = new Error(`нет вкладки ${tabId}`); e.code = 'NO_TAB'; throw e; }
    return t;
  }

  checkRef(tab, ref) {
    const refs = new Set([...tab.snapshot.matchAll(/^\s*\[(e\d+)\]/gm)].map((m) => m[1]));
    if (!refs.has(ref)) { const e = new Error(`ref ${ref} инвалидирован`); e.code = 'STALE_REF'; throw e; }
  }

  async handleServerReq(method, p) {
    switch (method) {
      case 'tab.list':
        return { tabs: [...this.tabs.values()].map((t, i) => ({ tabId: t.tabId, url: t.url, title: t.title, active: i === 0 })) };
      case 'tab.open': {
        const page = this.pages[p.url] ?? {};
        const tabId = ++tabSeq;
        const tab = {
          tabId, url: p.url, title: page.title ?? p.url, flags: page.flags ?? [],
          snapshot: page.snapshot ?? `url: ${p.url}\ntitle: ${page.title ?? p.url}`,
          markdown: page.markdown ?? `# ${p.url}`,
        };
        this.tabs.set(tabId, tab);
        return { tabId, url: tab.url, title: tab.title };
      }
      case 'tab.close':
        this.tabs.delete(p.tabId);
        return {};
      case 'snapshot': {
        const t = this.tabOrThrow(p.tabId);
        return { url: t.url, title: t.title, snapshot: t.snapshot, dom_hash: shortHash(t.snapshot), flags: t.flags, truncated: false };
      }
      case 'extractMarkdown': {
        const t = this.tabOrThrow(p.tabId);
        return { url: t.url, title: t.title, markdown: t.markdown, images: [], flags: t.flags };
      }
      case 'findText': {
        const t = this.tabOrThrow(p.tabId);
        const q = String(p.query ?? '').toLowerCase();
        const matches = [];
        for (const line of t.snapshot.split('\n')) {
          const m = /^\s*\[(e\d+)\]\s+\S+\s*(.*)$/.exec(line);
          if (m && line.toLowerCase().includes(q)) matches.push({ ref: m[1], text: m[2] || line });
          if (matches.length >= 20) break;
        }
        return { matches, flags: t.flags };
      }
      case 'screenshot':
        this.tabOrThrow(p.tabId);
        return { data_jpeg_base64: Buffer.from('fake-jpeg').toString('base64') };
      case 'click': {
        const t = this.tabOrThrow(p.tabId);
        if (p.ref) this.checkRef(t, p.ref); // click-by-text (без ref) — без проверки
        (this.actions ??= []).push('click');
        return { url: t.url, title: t.title, flags: t.flags, navigated: false };
      }
      case 'type': case 'select': {
        const t = this.tabOrThrow(p.tabId);
        this.checkRef(t, p.ref);
        (this.actions ??= []).push(method);
        return { url: t.url, title: t.title, flags: t.flags };
      }
      case 'hover': {
        const t = this.tabOrThrow(p.tabId);
        if (p.ref) this.checkRef(t, p.ref); // hover-by-text (без ref) — без проверки
        (this.actions ??= []).push('hover');
        return { url: t.url, title: t.title, flags: t.flags };
      }
      case 'scroll': case 'scrollIntoView': case 'pressKey': {
        const t = this.tabOrThrow(p.tabId);
        (this.actions ??= []).push(method);
        return { url: t.url, title: t.title, flags: t.flags };
      }
      case 'getStateHash': {
        const t = this.tabOrThrow(p.tabId);
        return { url: t.url, dom_hash: shortHash(t.snapshot) };
      }
      case 'consoleLog': {
        const t = this.tabOrThrow(p.tabId);
        const all = t.consoleEntries ?? [];
        const limit = Math.min(Math.max(Number(p.limit) || 100, 1), 100);
        return {
          url: t.url, title: t.title, flags: t.flags,
          entries: all.slice(-limit),
          // тест может выставить t.consoleUnavailable — маркер деградации (CSP)
          ...(t.consoleUnavailable ? { console_unavailable: t.consoleUnavailable } : {}),
        };
      }
      case 'eval': {
        // page.eval (L1.1): вкладка отдаёт scripted результат. t.evalResult —
        // готовая JSON-строка (≤16 KB → инлайн; больше — имитация релея, как
        // content-bridge: file.* события + {relayed:true}); t.evalError —
        // ошибка исполнения со стороны страницы.
        const t = this.tabOrThrow(p.tabId);
        (this.actions ??= []).push('eval');
        this.lastEvalParams = p;
        if (t.evalError) throw Object.assign(new Error(t.evalError), { code: 'EVAL_ERROR' });
        if (t.evalUnavailable) throw Object.assign(new Error('MAIN-world eval-runner не загрузился (CSP страницы?)'), { code: 'EVAL_UNAVAILABLE' });
        const json = String(t.evalResult ?? 'null');
        if (json.length > 16000) {
          this.serveFile({}, { name: 'eval-result.json', content: Buffer.from(json) }).catch(() => {});
          return { url: t.url, title: t.title, flags: t.flags, relayed: true, transferId: 'mock-relay', value_type: 'string', bytes: json.length };
        }
        return { url: t.url, title: t.title, flags: t.flags, value_json: json, value_type: 'object', bytes: json.length };
      }
      case 'waitFor': {
        const t = this.tabOrThrow(p.tabId);
        const cond = p.condition ?? {};
        const state = p.state ?? 'appear';
        let has = false;
        if (cond.url_contains != null) has = t.url.includes(String(cond.url_contains));
        else if (cond.text != null) has = (t.snapshot + '\n' + t.markdown).includes(String(cond.text));
        else if (cond.ref != null) {
          try { this.checkRef(t, cond.ref); has = true; } catch { has = false; }
        }
        const met = state === 'appear' ? has : !has;
        return { url: t.url, title: t.title, flags: t.flags, condition_met: met };
      }
      case 'scan': {
        const t = this.tabOrThrow(p.tabId);
        (this.actions ??= []).push('scan');
        return { url: t.url, title: t.title, flags: t.flags, scan: t.snapshot, screens: 1, unique: 1 };
      }
      case 'consent.ask': {
        this.consentRequests.push(p);
        const decision = typeof this.consent === 'function' ? this.consent(p) : this.consent;
        if (decision === 'timeout') return undefined; // не отвечаем — сервер оттаймаутится
        return { decision };
      }
      case 'grant.ask': {
        // П2-5: как background — на allow сначала шлём grant.add (download,
        // session), и лишь затем отвечаем на req.
        this.grantAskRequests.push(p);
        const decision = typeof this.grantAsk === 'function' ? this.grantAsk(p) : this.grantAsk;
        if (decision === 'timeout') return undefined; // не отвечаем — сервер оттаймаутится
        if (decision === 'throw') throw Object.assign(new Error('grant.ask boom (mock)'), { code: 'INTERNAL' });
        if (decision === 'allow') {
          await this.sendReq('grant.add', { domain: p.domain, capabilities: ['download'], scope: 'session' });
        }
        // П.3: как новый баннер — скриптованные решения помечаем reason:'click'
        // (явное решение пользователя); 'timeout' выше не отвечает вовсе.
        return { decision, reason: 'click' };
      }
      case 'fetchFile': {
        // fetchFails — имитация падения fetch на стороне расширения (CORS и пр.):
        // ошибка уходит ДО file.start (живой кейс: xet-редирект HF).
        if (this.fetchFails) throw Object.assign(new Error('fetch failed (mock)'), { code: 'FETCH_FAILED' });
        this.serveFile(p).catch(() => {});
        return undefined; // res уйдёт из serveFile сразу после file.start (как background-релей)
      }
      default:
        throw Object.assign(new Error(`unknown method ${method}`), { code: 'INTERNAL' });
    }
  }

  /**
   * Файловый релей: file.start → res на fetchFile (СРАЗУ после заголовков,
   * как background-релей: transport-timeout сервера покрывает только старт)
   * → chunk (ждём ack) → file.end.
   */
  async serveFile(p, fileOverride) {
    const file = fileOverride ?? this.fileToServe;
    if (!file) return;
    const transferId = `t_${++transferSeq}`;
    const content = file.content;
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    this.send({ type: 'evt', event: 'file.start', data: { transferId, name: p.name ?? file.name, size: content.length, mime: 'application/octet-stream' } });
    // ранний res на req fetchFile — сервер всё равно ждёт завершения трансфера
    // по file.end (expectTransfer), в res несём только метаданные старта
    if (this.pendingFetchReq) {
      const { id } = this.pendingFetchReq;
      this.pendingFetchReq = null;
      this.send({ type: 'res', id, result: { transferId, size: content.length, mime: 'application/octet-stream' } });
    }
    const chunkSize = file.chunkSize ?? 400;
    const chunkDelayMs = file.chunkDelayMs ?? 0; // медленный трансфер (тесты progress)
    let seq = 0;
    for (let off = 0; off < content.length; off += chunkSize, seq++) {
      if (chunkDelayMs) await new Promise((r) => setTimeout(r, chunkDelayMs));
      this.send({ type: 'evt', event: 'file.chunk', data: { transferId, seq, data_base64: content.subarray(off, off + chunkSize).toString('base64') } });
      // backpressure: ждём ack перед следующим чанком
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ack timeout')), 15000);
        this.ackWaiters.set(`${transferId}:${seq}`, () => { clearTimeout(timer); resolve(); });
      });
    }
    this.send({ type: 'evt', event: 'file.end', data: { transferId, sha256 } });
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
