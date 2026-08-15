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
   * @param opts.tabs — [{tabId, url, title, flags?, snapshot?, markdown?}]
   * @param opts.pages — {url: {title, snapshot, markdown, flags}} для tab.open
   * @param opts.consent — 'allow'|'deny'|'allow_10min'|'timeout'|function(params) => decision|'timeout'
   * @param opts.fileToServe — {name, content:Buffer} для fetchFile
   */
  constructor(opts) {
    this.secret = opts.secret;
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
    this.fileToServe = opts.fileToServe ?? null;
    this.policyUpdates = [];
    this.consentRequests = [];
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
        this.sendReq('hello', { secret: this.secret, ext_version: '0.0-test', browser: 'MockFox', ua: 'mock' })
          .then((res) => {
            if (res.status !== 'pending_approval') return reject(new Error('unexpected hello res: ' + JSON.stringify(res)));
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
      case 'scroll': case 'scrollIntoView': case 'pressKey': case 'hover': {
        const t = this.tabOrThrow(p.tabId);
        (this.actions ??= []).push(method);
        return { url: t.url, title: t.title, flags: t.flags };
      }
      case 'getStateHash': {
        const t = this.tabOrThrow(p.tabId);
        return { url: t.url, dom_hash: shortHash(t.snapshot) };
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
      case 'fetchFile': {
        this.serveFile(p).catch(() => {});
        return undefined; // res уйдёт после file.end
      }
      default:
        throw Object.assign(new Error(`unknown method ${method}`), { code: 'INTERNAL' });
    }
  }

  /** Файловый релей: file.start → chunk (ждём ack) → file.end → res на fetchFile. */
  async serveFile(p) {
    const file = this.fileToServe;
    if (!file) return;
    const transferId = `t_${++transferSeq}`;
    const content = file.content;
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    this.send({ type: 'evt', event: 'file.start', data: { transferId, name: p.name ?? file.name, size: content.length, mime: 'application/octet-stream' } });
    const chunkSize = file.chunkSize ?? 400;
    let seq = 0;
    for (let off = 0; off < content.length; off += chunkSize, seq++) {
      this.send({ type: 'evt', event: 'file.chunk', data: { transferId, seq, data_base64: content.subarray(off, off + chunkSize).toString('base64') } });
      // backpressure: ждём ack перед следующим чанком
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ack timeout')), 15000);
        this.ackWaiters.set(`${transferId}:${seq}`, () => { clearTimeout(timer); resolve(); });
      });
    }
    this.send({ type: 'evt', event: 'file.end', data: { transferId, sha256 } });
    // финальный res на req fetchFile — ПОСЛЕ file.end: находим через lastFetchReq
    if (this.pendingFetchReq) {
      const { id } = this.pendingFetchReq;
      this.pendingFetchReq = null;
      this.send({ type: 'res', id, result: { transferId, size: content.length, sha256 } });
    }
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
