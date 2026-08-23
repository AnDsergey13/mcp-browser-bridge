// downloads.ts — файловый релей (PROTOCOL.md §8): file.start/chunk/end,
// ack каждого чанка (backpressure на стороне расширения), sha256, uniquify,
// запись в downloadsDir + строка в manifest.jsonl.
// Фаза 9 (D7): параллельные трансферы — реестр ожиданий per (clientId, FIFO),
// transferId → {clientId, ожидание}; ack уходит только клиенту-владельцу.
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

/** Колбэк прогресса трансфера: получено байт, ожидаемый размер (null — неизвестен). */
export type TransferProgress = (received: number, total: number | null) => void;

interface Transfer {
  transferId: string;
  clientId: string; // браузер-владелец трансфера (ack — только ему)
  name: string;
  size: number | null;
  mime: string | null;
  tmpPath: string;
  fd: number;
  nextSeq: number;
  bytes: number;
  hash: crypto.Hash;
  url: string | null;
  onProgress: TransferProgress | null; // MCP progress-нотификации (П.5), может отсутствовать
  done: (r: { name: string; size: number; sha256: string }) => void;
  fail: (err: RelayError) => void;
}

/** Ожидание трансфера из file.download (D7): связь по clientId, FIFO внутри клиента. */
interface PendingExpect {
  url: string;
  clientId: string;
  onProgress: TransferProgress | null;
  resolve: (r: CompletedTransfer) => void;
  reject: (err: RelayError) => void;
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
  private sendAck: (transferId: string, seq: number, clientId: string) => void;
  private transfers = new Map<string, Transfer>();
  private expects: PendingExpect[] = [];

  constructor(opts: {
    downloadsDir: string;
    log?: (msg: string) => void;
    sendAck: (transferId: string, seq: number, clientId: string) => void;
  }) {
    this.downloadsDir = opts.downloadsDir;
    this.log = opts.log ?? (() => {});
    this.sendAck = opts.sendAck;
  }

  /** Ожидание трансфера этого клиента (вызывается перед req fetchFile). */
  expectTransfer(url: string, clientId: string, onProgress?: TransferProgress): Promise<CompletedTransfer> {
    return new Promise((resolve, reject) => {
      this.expects.push({ url, clientId, onProgress: onProgress ?? null, resolve, reject });
    });
  }

  /** События file.* от расширения (clientId — браузер-источник). Возвращает true, если событие обработано. */
  handleEvent(event: string, data: Record<string, unknown>, clientId: string): boolean {
    switch (event) {
      case 'file.start': this.onStart(data, clientId); return true;
      case 'file.chunk': this.onChunk(data); return true;
      case 'file.end': this.onEnd(data); return true;
      case 'file.abort': this.onAbort(data); return true;
      default: return false;
    }
  }

  /** Первое (FIFO) ожидание этого клиента — ему и принадлежит начинающийся трансфер. */
  private takeExpect(clientId: string): PendingExpect | null {
    const idx = this.expects.findIndex((e) => e.clientId === clientId);
    if (idx < 0) return null;
    return this.expects.splice(idx, 1)[0];
  }

  /**
   * Снять ещё НЕ начавшееся ожидание (fetchFile упал или оттаймаутился до
   * file.start): иначе протухшее ожидание по FIFO съест ЧУЖОЙ трансфер и
   * manifest запишет неверный url (живой кейс HF, 2026-08-19).
   */
  cancelExpect(clientId: string, url: string): void {
    const idx = this.expects.findIndex((e) => e.clientId === clientId && e.url === url);
    if (idx < 0) return; // ожидание уже потреблено начавшимся трансфером — не трогаем
    this.expects.splice(idx, 1)[0].reject(new RelayError('FETCH_FAILED', 'fetchFile завершился ошибкой до начала трансфера'));
  }

  private onStart(data: Record<string, unknown>, clientId: string): void {
    const transferId = String(data['transferId'] ?? '');
    if (!transferId) return;
    fs.mkdirSync(this.downloadsDir, { recursive: true });
    const tmpPath = path.join(this.downloadsDir, `.partial-${transferId}`);
    const fd = fs.openSync(tmpPath, 'w');
    const expect = this.takeExpect(clientId);
    const t: Transfer = {
      transferId,
      clientId,
      name: sanitizeName(String(data['name'] ?? 'download.bin')),
      size: typeof data['size'] === 'number' ? data['size'] : null,
      mime: typeof data['mime'] === 'string' ? data['mime'] : null,
      tmpPath,
      fd,
      nextSeq: 0,
      bytes: 0,
      hash: crypto.createHash('sha256'),
      url: expect?.url ?? null,
      onProgress: expect?.onProgress ?? null,
      done: (r) => expect?.resolve({ transferId, ...r }),
      fail: (err) => expect?.reject(err),
    };
    this.transfers.set(transferId, t);
    if (!expect) this.log(`relay: start ${transferId} без ожидания file.download (clientId=${clientId})`);
    this.log(`relay: start ${transferId} "${t.name}" (${t.size ?? '?'} bytes) от ${clientId}`);
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
    // ack — расширение ждёт его перед следующим чанком (backpressure);
    // уходит только клиенту-владельцу трансфера (D6/D7).
    this.sendAck(transferId, seq, t.clientId);
    // П.5: прогресс ждущему file.download (MCP notifications/progress наверху,
    // троттлинг — там же; сам релей отчитывается о каждом чанке). Ошибка
    // колбэка не должна ронять трансфер.
    if (t.onProgress) {
      try { t.onProgress(t.bytes, t.size); } catch { /* прогресс — best effort */ }
    }
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
      t.fail(new RelayError('FETCH_FAILED', `sha256 не сошёлся: ext=${expected} server=${sha256}`));
      return;
    }
    // П0-6: идемпотентность ретрая после клиентского -32001 — тот же url и
    // тот же контент (size+sha256) уже лежит в downloads → отдаём существующий
    // файл, а не плодим «name (1).ext».
    const existing = this.findCompleted(t.url, t.bytes, sha256);
    if (existing) {
      fs.rmSync(t.tmpPath, { force: true });
      this.manifest({ ts: new Date().toISOString(), url: t.url, name: existing, size: t.bytes, sha256, status: 'ok', dedup: true });
      this.log(`relay: dedup ${transferId} → существующий ${existing} (${t.bytes} bytes)`);
      t.done({ name: existing, size: t.bytes, sha256 });
      return;
    }
    const finalName = this.uniquify(t.name);
    fs.renameSync(t.tmpPath, path.join(this.downloadsDir, finalName));
    this.manifest({ ts: new Date().toISOString(), url: t.url, name: finalName, size: t.bytes, sha256, status: 'ok' });
    this.log(`relay: done ${transferId} → ${finalName} (${t.bytes} bytes)`);
    t.done({ name: finalName, size: t.bytes, sha256 });
  }

  /** Завершённая запись manifest с тем же url+size+sha256 и живым файлом на диске. */
  private findCompleted(url: string | null, size: number, sha256: string): string | null {
    if (!url) return null;
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(this.downloadsDir, 'manifest.jsonl'), 'utf8').split('\n');
    } catch {
      return null;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line); } catch { continue; }
      if (e['status'] !== 'ok' || e['url'] !== url || e['sha256'] !== sha256 || e['size'] !== size) continue;
      const name = String(e['name'] ?? '');
      if (name && fs.existsSync(path.join(this.downloadsDir, name))) return name;
    }
    return null;
  }

  private onAbort(data: Record<string, unknown>): void {
    const transferId = String(data['transferId'] ?? '');
    const t = this.transfers.get(transferId);
    const reason = String(data['reason'] ?? 'aborted by extension');
    if (t) {
      this.abortTransfer(t, reason);
    }
    // Трансфер неизвестен (уже завершён/чужой) — ожидание не трогаем:
    // его reject придёт через свой file.abort или resetClient.
  }

  private abortTransfer(t: Transfer, reason: string): void {
    this.transfers.delete(t.transferId);
    try { fs.closeSync(t.fd); } catch { /* уже закрыт */ }
    fs.rmSync(t.tmpPath, { force: true });
    this.manifest({ ts: new Date().toISOString(), url: t.url, name: t.name, size: t.bytes, sha256: null, status: `failed: ${reason}` });
    t.fail(new RelayError('FETCH_FAILED', reason));
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

  /** Отмена всех активных трансферов и ожиданий ЭТОГО клиента (при его дисконнекте). */
  resetClient(clientId: string, reason: string): void {
    for (const t of [...this.transfers.values()]) {
      if (t.clientId === clientId) this.abortTransfer(t, reason);
    }
    const mine = this.expects.filter((e) => e.clientId === clientId);
    this.expects = this.expects.filter((e) => e.clientId !== clientId);
    for (const e of mine) e.reject(new RelayError('BROWSER_OFFLINE', reason));
  }
}

function sanitizeName(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^\wа-яА-ЯёЁ .()\[\]-]/gu, '_') || 'download.bin';
}
