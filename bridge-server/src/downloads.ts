// downloads.ts — файловый релей (PROTOCOL.md §8): file.start/chunk/end,
// ack каждого чанка (backpressure на стороне расширения), sha256, uniquify,
// запись в downloadsDir + строка в manifest.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class RelayError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Transfer {
  transferId: string;
  name: string;
  size: number | null;
  mime: string | null;
  tmpPath: string;
  fd: number;
  nextSeq: number;
  bytes: number;
  hash: crypto.Hash;
  url: string | null;
  done: (r: { name: string; size: number; sha256: string }) => void;
  fail: (err: RelayError) => void;
}

export interface CompletedTransfer {
  transferId: string;
  name: string;   // финальное (uniquified) имя в downloadsDir
  size: number;
  sha256: string;
}

export class DownloadRelay {
  private downloadsDir: string;
  private log: (msg: string) => void;
  private sendAck: (transferId: string, seq: number) => void;
  private transfers = new Map<string, Transfer>();
  private pendingUrl: string | null = null; // url из текущего file.download

  constructor(opts: {
    downloadsDir: string;
    log?: (msg: string) => void;
    sendAck: (transferId: string, seq: number) => void;
  }) {
    this.downloadsDir = opts.downloadsDir;
    this.log = opts.log ?? (() => {});
    this.sendAck = opts.sendAck;
  }

  /** Ожидание следующего трансфера (вызывается перед req fetchFile). */
  expectTransfer(url: string): Promise<CompletedTransfer> {
    this.pendingUrl = url;
    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
    });
  }

  private pendingResolve: ((r: CompletedTransfer) => void) | null = null;
  private pendingReject: ((err: RelayError) => void) | null = null;

  /** События file.* от расширения. Возвращает true, если событие обработано. */
  handleEvent(event: string, data: Record<string, unknown>): boolean {
    switch (event) {
      case 'file.start': this.onStart(data); return true;
      case 'file.chunk': this.onChunk(data); return true;
      case 'file.end': this.onEnd(data); return true;
      case 'file.abort': this.onAbort(data); return true;
      default: return false;
    }
  }

  private onStart(data: Record<string, unknown>): void {
    const transferId = String(data['transferId'] ?? '');
    if (!transferId) return;
    fs.mkdirSync(this.downloadsDir, { recursive: true });
    const tmpPath = path.join(this.downloadsDir, `.partial-${transferId}`);
    const fd = fs.openSync(tmpPath, 'w');
    const t: Transfer = {
      transferId,
      name: sanitizeName(String(data['name'] ?? 'download.bin')),
      size: typeof data['size'] === 'number' ? data['size'] : null,
      mime: typeof data['mime'] === 'string' ? data['mime'] : null,
      tmpPath,
      fd,
      nextSeq: 0,
      bytes: 0,
      hash: crypto.createHash('sha256'),
      url: this.pendingUrl,
      done: () => {},
      fail: () => {},
    };
    this.transfers.set(transferId, t);
    this.log(`relay: start ${transferId} "${t.name}" (${t.size ?? '?'} bytes)`);
  }

  private onChunk(data: Record<string, unknown>): void {
    const transferId = String(data['transferId'] ?? '');
    const t = this.transfers.get(transferId);
    if (!t) return;
    const seq = Number(data['seq']);
    if (seq !== t.nextSeq) {
      this.abortTransfer(t, `seq mismatch: ждали ${t.nextSeq}, пришло ${seq}`);
      return;
    }
    const buf = Buffer.from(String(data['data_base64'] ?? ''), 'base64');
    fs.writeSync(t.fd, buf);
    t.hash.update(buf);
    t.bytes += buf.length;
    t.nextSeq++;
    // ack — расширение ждёт его перед следующим чанком (backpressure).
    this.sendAck(transferId, seq);
  }

  private onEnd(data: Record<string, unknown>): void {
    const transferId = String(data['transferId'] ?? '');
    const t = this.transfers.get(transferId);
    if (!t) return;
    this.transfers.delete(transferId);
    fs.closeSync(t.fd);
    const sha256 = t.hash.digest('hex');
    const expected = typeof data['sha256'] === 'string' ? data['sha256'] : null;
    if (expected && expected !== sha256) {
      fs.rmSync(t.tmpPath, { force: true });
      this.finishFail(transferId, new RelayError('FETCH_FAILED', `sha256 не сошёлся: ext=${expected} server=${sha256}`));
      return;
    }
    const finalName = this.uniquify(t.name);
    fs.renameSync(t.tmpPath, path.join(this.downloadsDir, finalName));
    this.manifest({ ts: new Date().toISOString(), url: t.url, name: finalName, size: t.bytes, sha256, status: 'ok' });
    this.log(`relay: done ${transferId} → ${finalName} (${t.bytes} bytes)`);
    this.finishOk({ transferId, name: finalName, size: t.bytes, sha256 });
  }

  private onAbort(data: Record<string, unknown>): void {
    const transferId = String(data['transferId'] ?? '');
    const t = this.transfers.get(transferId);
    const reason = String(data['reason'] ?? 'aborted by extension');
    if (t) {
      this.abortTransfer(t, reason);
    } else {
      this.finishFail(transferId, new RelayError('FETCH_FAILED', reason));
    }
  }

  private abortTransfer(t: Transfer, reason: string): void {
    this.transfers.delete(t.transferId);
    try { fs.closeSync(t.fd); } catch { /* уже закрыт */ }
    fs.rmSync(t.tmpPath, { force: true });
    this.manifest({ ts: new Date().toISOString(), url: t.url, name: t.name, size: t.bytes, sha256: null, status: `failed: ${reason}` });
    this.finishFail(t.transferId, new RelayError('FETCH_FAILED', reason));
  }

  private finishOk(r: CompletedTransfer): void {
    const resolve = this.pendingResolve;
    this.pendingResolve = this.pendingReject = null;
    if (resolve) resolve(r);
  }

  private finishFail(_transferId: string, err: RelayError): void {
    const reject = this.pendingReject;
    this.pendingResolve = this.pendingReject = null;
    if (reject) reject(err);
  }

  private uniquify(name: string): string {
    if (!fs.existsSync(path.join(this.downloadsDir, name))) return name;
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 1; ; i++) {
      const cand = `${base} (${i})${ext}`;
      if (!fs.existsSync(path.join(this.downloadsDir, cand))) return cand;
    }
  }

  private manifest(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(this.downloadsDir, { recursive: true });
      fs.appendFileSync(path.join(this.downloadsDir, 'manifest.jsonl'), JSON.stringify(entry) + '\n');
    } catch (err) {
      this.log(`relay: ошибка записи manifest: ${(err as Error).message}`);
    }
  }

  /** Отмена всех активных трансферов (при дисконнекте). */
  resetAll(reason: string): void {
    for (const t of [...this.transfers.values()]) this.abortTransfer(t, reason);
  }
}

function sanitizeName(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^\wа-яА-ЯёЁ .()\[\]-]/gu, '_') || 'download.bin';
}
