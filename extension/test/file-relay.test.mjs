// file-relay.test.mjs — фоновый файловый релей (file-relay.js + sha256.js):
// эталонные вектора SHA-256, потоковая сборка чанков из fake ReadableStream,
// backpressure (chunk n+1 не раньше ack n), ранний res после заголовков,
// маппинг ошибок (HTTP/sеть/сбой посреди стрима), подмена Referer/Origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Песочница с обоими модулями (sha256.js → file-relay.js). */
function loadRelay(sandboxExtra = {}) {
  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    btoa,
    ...sandboxExtra,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["sha256.js", "file-relay.js"]) {
    vm.runInContext(readFileSync(path.join(SRC, f), "utf8"), sandbox, { filename: f });
  }
  vm.runInContext("globalThis.__relay = BridgeFileRelay; globalThis.__sha = BridgeSha256;", sandbox);
  return { Relay: sandbox.__relay, Sha: sandbox.__sha, sandbox };
}

// ---------- fake fetch / io ----------
function fakeReader(chunks, { throwAt = null } = {}) {
  let i = 0;
  return {
    async read() {
      if (throwAt !== null && i === throwAt) {
        i++;
        throw new Error("network reset mid-stream");
      }
      if (i < chunks.length) return { done: false, value: chunks[i++] };
      return { done: true };
    },
    async cancel() {},
  };
}

function fakeResponse(chunks, { status = 200, headers = {}, readerOpts } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    body: { getReader: () => fakeReader(chunks, readerOpts) },
  };
}

function makeIo() {
  const events = [];
  const acks = []; // deferred-контроль backpressure
  return {
    events,
    acks,
    sendStart: (d) => events.push({ ev: "start", ...d }),
    sendChunk: (d) => {
      events.push({ ev: "chunk", seq: d.seq, bytes: Buffer.from(d.data_base64, "base64") });
      let resolve;
      const p = new Promise((r) => (resolve = r));
      acks.push({ resolve, seq: d.seq });
      return p;
    },
    sendEnd: (d) => events.push({ ev: "end", ...d }),
    sendAbort: (d) => events.push({ ev: "abort", ...d }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

/** Прогнать стрим до конца, отвечая ok на каждый ack по мере появления. */
async function drainAcks(io, chunkCount) {
  for (let n = 0; n < chunkCount; n++) {
    while (io.acks.length <= n) await tick();
    io.acks[n].resolve({ ok: true });
    await tick();
  }
}

// ---------- sha256 ----------
test("sha256: эталонные вектора (пустая строка, abc)", () => {
  const { Sha } = loadRelay();
  const hex = (s) => {
    const h = Sha.create();
    h.update(new TextEncoder().encode(s));
    return h.digestHex();
  };
  assert.equal(hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("sha256: 1 МБ случайного кусками нечётного размера — совпадает с crypto", () => {
  const { Sha } = loadRelay();
  const data = crypto.randomBytes(1024 * 1024 + 13);
  const h = Sha.create();
  const sizes = [1, 7, 63, 64, 65, 1000, 65536];
  let off = 0;
  let n = 0;
  while (off < data.length) {
    const sz = sizes[n++ % sizes.length];
    h.update(data.subarray(off, off + sz));
    off += sz;
  }
  assert.equal(h.digestHex(), crypto.createHash("sha256").update(data).digest("hex"));
});

// ---------- потоковая сборка ----------
test("stream: склейка до 256 КБ, порядок seq, sha256 на лету, без хранения файла", async () => {
  const { Relay } = loadRelay();
  const source = crypto.randomBytes(600 * 1024); // 2 полных чанка + хвост
  // режем источник на куски, пересекающие границы чанков
  const slices = [];
  for (let off = 0; off < source.length; off += 100003) slices.push(source.subarray(off, off + 100003));
  const resp = fakeResponse(slices);
  const io = makeIo();
  const streamP = Relay.streamBody(resp, "t_t1", io);

  const expectChunks = Math.ceil(source.length / Relay.CHUNK_SIZE);
  assert.equal(expectChunks, 3);
  await drainAcks(io, expectChunks);
  await streamP;

  const chunks = io.events.filter((e) => e.ev === "chunk");
  assert.deepEqual(chunks.map((c) => c.seq), [0, 1, 2]);
  assert.deepEqual(
    chunks.map((c) => c.bytes.length),
    [Relay.CHUNK_SIZE, Relay.CHUNK_SIZE, source.length - 2 * Relay.CHUNK_SIZE]
  );
  assert.deepEqual(Buffer.concat(chunks.map((c) => c.bytes)), source);
  const end = io.events.find((e) => e.ev === "end");
  assert.equal(end.transferId, "t_t1");
  assert.equal(end.sha256, crypto.createHash("sha256").update(source).digest("hex"));
  assert.equal(io.events.some((e) => e.ev === "abort"), false);
});

test("stream: backpressure — следующий чанк не уходит до ack предыдущего", async () => {
  const { Relay } = loadRelay();
  const source = crypto.randomBytes(Relay.CHUNK_SIZE + 10); // ровно 2 чанка
  const resp = fakeResponse([source]);
  const io = makeIo();
  const streamP = Relay.streamBody(resp, "t_t2", io);

  while (io.acks.length < 1) await tick();
  await tick();
  assert.equal(io.events.filter((e) => e.ev === "chunk").length, 1, "chunk 1 ждёт ack chunk 0");
  io.acks[0].resolve({ ok: true });
  while (io.acks.length < 2) await tick();
  await tick();
  assert.equal(io.events.filter((e) => e.ev === "chunk").length, 2);
  assert.equal(io.events.some((e) => e.ev === "end"), false, "end ждёт ack хвоста");
  io.acks[1].resolve({ ok: true });
  await streamP;
  assert.equal(io.events.some((e) => e.ev === "end"), true);
});

test("stream: отказ ack → file.abort, file.end не шлём", async () => {
  const { Relay } = loadRelay();
  const resp = fakeResponse([crypto.randomBytes(1000)]);
  const io = makeIo();
  const streamP = Relay.streamBody(resp, "t_t3", io);
  while (io.acks.length < 1) await tick();
  io.acks[0].resolve({ ok: false, error: "ACK_TIMEOUT" });
  await streamP;
  const abort = io.events.find((e) => e.ev === "abort");
  assert.ok(abort, "file.abort отправлен");
  assert.match(abort.reason, /ack/i);
  assert.equal(io.events.some((e) => e.ev === "end"), false);
});

// ---------- start(): ранний res и маппинг ошибок ----------
const PARAMS = { url: "https://hf.co/datasets/d/resolve/main/f.parquet", name: "f.parquet", transferId: "t_9", referer: "https://hf.co/datasets/d" };

test("start: res уходит СРАЗУ после заголовков, до окончания стриминга", async () => {
  const { Relay } = loadRelay();
  const content = crypto.randomBytes(300 * 1024);
  const resp = fakeResponse([content], {
    headers: { "content-type": "application/vnd.apache.parquet", "content-length": String(content.length) },
  });
  const io = makeIo();
  const fetchImpl = async (url, opts) => {
    assert.equal(url, PARAMS.url);
    assert.equal(opts.credentials, "include");
    return resp;
  };
  const res = await Relay.start(PARAMS, io, { fetchImpl });
  // объект из vm-песочницы — сравниваем по полям (cross-realm прототипы)
  assert.equal(res.transferId, "t_9");
  assert.equal(res.size, content.length);
  assert.equal(res.mime, "application/vnd.apache.parquet");
  const start = io.events.find((e) => e.ev === "start");
  assert.ok(start, "file.start ушёл до res");
  assert.equal(start.name, "f.parquet");
  assert.equal(start.size, content.length);
  // стриминг ещё не завершён (ack ни одного не отдали) — но res уже есть
  assert.equal(io.events.some((e) => e.ev === "end"), false);
  await drainAcks(io, 2); // 256 КБ + хвост
  await tick();
  assert.equal(io.events.some((e) => e.ev === "end"), true);
});

test("start: HTTP != 2xx → FETCH_FAILED до file.start", async () => {
  const { Relay } = loadRelay();
  const io = makeIo();
  const fetchImpl = async () => fakeResponse([], { status: 404 });
  await assert.rejects(Relay.start(PARAMS, io, { fetchImpl }), (e) => {
    assert.equal(e.code, "FETCH_FAILED");
    assert.match(e.message, /HTTP 404/);
    return true;
  });
  assert.equal(io.events.length, 0, "ни file.start, ни abort — трансфер не начинался");
});

test("start: сетевой сбой fetch → FETCH_FAILED до file.start", async () => {
  const { Relay } = loadRelay();
  const io = makeIo();
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(Relay.start(PARAMS, io, { fetchImpl }), (e) => {
    assert.equal(e.code, "FETCH_FAILED");
    assert.match(e.message, /Failed to fetch/);
    return true;
  });
  assert.equal(io.events.length, 0);
});

test("start: сетевая ошибка с cause → тип и цепочка cause в сообщении (П.6)", async () => {
  const { Relay } = loadRelay();
  const io = makeIo();
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch", { cause: new Error("ERR_CERT_DATE_INVALID") });
  };
  await assert.rejects(Relay.start(PARAMS, io, { fetchImpl }), (e) => {
    assert.equal(e.code, "FETCH_FAILED");
    assert.match(e.message, /TypeError: Failed to fetch/);
    assert.match(e.message, /cause: Error: ERR_CERT_DATE_INVALID/);
    return true;
  });
  assert.equal(io.events.length, 0);
});

test("start: HTTP-ошибка несёт statusText и финальный URL (П.6)", async () => {
  const { Relay } = loadRelay();
  const io = makeIo();
  const resp = fakeResponse([], { status: 403 });
  resp.statusText = "Forbidden";
  resp.url = "https://cdn.example/redirected/file";
  await assert.rejects(Relay.start(PARAMS, io, { fetchImpl: async () => resp }), (e) => {
    assert.equal(e.code, "FETCH_FAILED");
    assert.match(e.message, /HTTP 403 Forbidden/);
    assert.match(e.message, /финальный URL: https:\/\/cdn\.example\/redirected\/file/);
    return true;
  });
});

test("start: редирект на негрантованный домен → FETCH_FAILED ДО чтения тела (П.5)", async () => {
  const { Relay } = loadRelay();
  const io = makeIo();
  const resp = fakeResponse([crypto.randomBytes(100)]);
  resp.url = "https://evil.example/x.bin";
  const params = { ...PARAMS, checkRedirect: (u) => !u.includes("evil.example") };
  await assert.rejects(Relay.start(params, io, { fetchImpl: async () => resp }), (e) => {
    assert.equal(e.code, "FETCH_FAILED");
    assert.match(e.message, /редирект на негрантованный домен/);
    assert.match(e.message, /evil\.example/);
    return true;
  });
  assert.equal(io.events.length, 0, "file.start не отправлялся — тело не читалось");
});

test("start: редирект на грантованный домен → трансфер идёт (П.5)", async () => {
  const { Relay } = loadRelay();
  const io = makeIo();
  const content = crypto.randomBytes(100);
  const resp = fakeResponse([content]);
  resp.url = "https://cdn.allowed.example/x.bin";
  const params = { ...PARAMS, checkRedirect: () => true };
  const res = await Relay.start(params, io, { fetchImpl: async () => resp });
  assert.equal(res.transferId, "t_9");
  await drainAcks(io, 1);
  await tick();
  assert.equal(io.events.some((e) => e.ev === "end"), true);
});

test("start: сбой посреди стрима → file.abort (res уже ушёл раньше)", async () => {
  const { Relay } = loadRelay();
  const io = makeIo();
  // первый кусок — ровно полный чанк (меньший не эмитится до конца стрима)
  const chunks = [crypto.randomBytes(Relay.CHUNK_SIZE), crypto.randomBytes(100)];
  const resp = fakeResponse(chunks, { readerOpts: { throwAt: 1 } });
  const res = await Relay.start(PARAMS, io, { fetchImpl: async () => resp });
  assert.equal(res.transferId, "t_9");
  await drainAcks(io, 1); // первый чанк прошёл
  await tick();
  const abort = io.events.find((e) => e.ev === "abort");
  assert.ok(abort, "file.abort после сетевого сбоя");
  assert.match(abort.reason, /network reset/);
  assert.equal(io.events.some((e) => e.ev === "end"), false);
});

// ---------- Referer/Origin ----------
function fakeWebRequest() {
  const listeners = new Map();
  const ev = (name) => ({
    addListener: (fn) => listeners.set(name, (listeners.get(name) || []).concat(fn)),
    removeListener: (fn) =>
      listeners.set(name, (listeners.get(name) || []).filter((f) => f !== fn)),
    fire: (d) => (listeners.get(name) || []).map((fn) => fn(d)),
    count: () => (listeners.get(name) || []).length,
  });
  return { onBeforeSendHeaders: ev("send"), onCompleted: ev("done"), onErrorOccurred: ev("err") };
}

test("Referer/Origin подменяются на значения вкладки, включая хопы редиректа", async () => {
  const wr = fakeWebRequest();
  const { Relay } = loadRelay({ browser: { webRequest: wr } });
  const tabUrl = "https://hf.co/datasets/d/resolve/main/f.parquet";
  const stop = Relay.installHeaderRewriter(PARAMS.url, tabUrl);

  // первый хоп: фоновый запрос на startUrl → заголовки подменены
  const [r1] = wr.onBeforeSendHeaders.fire({
    requestId: "r1",
    url: PARAMS.url,
    tabId: -1,
    requestHeaders: [
      { name: "Accept", value: "*/*" },
      { name: "Origin", value: "moz-extension://deadbeef" },
      { name: "Referer", value: "moz-extension://deadbeef/" },
    ],
  });
  const byName = Object.fromEntries(r1.requestHeaders.map((h) => [h.name.toLowerCase(), h.value]));
  assert.equal(byName["referer"], tabUrl);
  assert.equal(byName["origin"], "https://hf.co");
  assert.equal(byName["accept"], "*/*");

  // хоп редиректа на CDN (тот же requestId, другой url) → тоже подменён
  const [r2] = wr.onBeforeSendHeaders.fire({
    requestId: "r1",
    url: "https://cas-bridge.xethub.hf.co/x/abc",
    tabId: -1,
    requestHeaders: [{ name: "Accept", value: "*/*" }],
  });
  const byName2 = Object.fromEntries(r2.requestHeaders.map((h) => [h.name.toLowerCase(), h.value]));
  assert.equal(byName2["referer"], tabUrl);
  assert.equal(byName2["origin"], "https://hf.co");

  // чужой запрос СТРАНИЦЫ на тот же startUrl (tabId >= 0) — не трогаем
  const [r3] = wr.onBeforeSendHeaders.fire({
    requestId: "r2",
    url: PARAMS.url,
    tabId: 5,
    requestHeaders: [],
  });
  assert.equal(r3, undefined);
  // чужой фоновый запрос на другой url — не трогаем
  const [r4] = wr.onBeforeSendHeaders.fire({ requestId: "r3", url: "https://other.example/x", tabId: -1, requestHeaders: [] });
  assert.equal(r4, undefined);

  stop();
  assert.equal(wr.onBeforeSendHeaders.count(), 0, "слушатель снят");
  assert.equal(wr.onCompleted.count(), 0);
  assert.equal(wr.onErrorOccurred.count(), 0);
});

test("Referer: без webRequest (MV3 SW) rewriter — честный no-op", () => {
  const { Relay } = loadRelay({ browser: { webRequest: {} } });
  const stop = Relay.installHeaderRewriter(PARAMS.url, "https://hf.co/page");
  assert.equal(typeof stop, "function");
  stop(); // не падает
  // и без browser вовсе
  const bare = loadRelay();
  bare.Relay.installHeaderRewriter(PARAMS.url, "https://hf.co/page")();
});

test("Referer: не-http вкладка (about:blank) → rewriter не ставится", () => {
  const wr = fakeWebRequest();
  const { Relay } = loadRelay({ browser: { webRequest: wr } });
  Relay.installHeaderRewriter(PARAMS.url, "about:blank");
  assert.equal(wr.onBeforeSendHeaders.count(), 0);
});
