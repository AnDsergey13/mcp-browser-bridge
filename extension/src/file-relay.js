/* global browser, BridgeSha256 */
"use strict";

/**
 * file-relay.js — фоновый файловый релей (PROTOCOL.md §8).
 *
 * fetch выполняется в BACKGROUND (MV2 page / MV3 SW), а не в content script:
 * background с host-правами <all_urls> не связан CORS страницы — cross-origin
 * редиректы на CDN (xet/LFS HuggingFace → cas-bridge.xethub.hf.co) fetch
 * следует свободно. Куки — браузерная банка (credentials:"include", та же
 * сессия, что у вкладки). Referer/Origin подменяются на значения вкладки
 * через webRequest (installHeaderRewriter) — CDN их проверяет.
 *
 * Потоковость: response.body.getReader() → склейка до CHUNK_SIZE → file.chunk
 * → ожидание file.ack (backpressure, как раньше) → следующий чанк. Файл в
 * память НЕ собирается (устранено тройное буферирование); sha256 —
 * инкрементальный (BridgeSha256), пиковый расход — порядка одного чанка.
 *
 * Семантика ответа: start() отдаёт res на fetchFile СРАЗУ после HTTP-
 * заголовков ({transferId,size,mime}) — серверный transport-timeout 120 c
 * покрывает только «старт», а не весь трансфер. Ошибки до file.start —
 * throw FETCH_FAILED (серверная cancelExpect снимает ожидание); сбой посреди
 * стрима — evt file.abort. Конверт протокола не менялся: file.start/chunk/
 * end/abort + file.ack.
 */
const BridgeFileRelay = (() => {
  const CHUNK_SIZE = 256 * 1024; // чанк file.chunk (§8)
  const REWRITE_TTL_MS = 10 * 60 * 1000; // страховочное снятие header-rewriter'а

  function ferr(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function u8ToBase64(bytes) {
    let bin = "";
    const SLICE = 0x8000; // fromCharCode.apply не переживает большие spread'ы
    for (let i = 0; i < bytes.length; i += SLICE) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE));
    }
    return btoa(bin);
  }

  /**
   * Подмена Referer/Origin на значения вкладки на время трансфера (CDN
   * редирект-цели их проверяют; запрос из background иначе нёс бы Origin
   * расширения). Реализация — webRequest.onBeforeSendHeaders с "blocking":
   * есть только в MV2 (Firefox, нужно право webRequestBlocking); в MV3
   * service worker webRequest без bindings → честный no-op, fetch идёт с
   * заголовками по умолчанию (задокументировано в PROTOCOL.md §8).
   * Редиректы: requestId у цепочки один — правим каждый хоп. Чужие запросы
   * страницы на тот же URL не задеваем: первый хоп только из background
   * (tabId < 0). Возвращает функцию-снятие (идемпотентную).
   */
  function installHeaderRewriter(startUrl, tabUrl) {
    const noop = () => {};
    let origin = "";
    try {
      origin = new URL(tabUrl).origin;
    } catch (e) {
      return noop;
    }
    if (!origin || origin === "null") return noop; // about:blank и пр. — подменять нечего
    const wr = typeof browser !== "undefined" && browser && browser.webRequest;
    if (!wr || !wr.onBeforeSendHeaders) return noop;

    const active = new Set(); // requestId цепочки редиректов этого трансфера
    const onHeaders = (d) => {
      if (!active.has(d.requestId)) {
        // Первый хоп: только фоновый запрос ровно на startUrl.
        if (d.url !== startUrl) return undefined;
        if (typeof d.tabId === "number" && d.tabId >= 0) return undefined;
        active.add(d.requestId);
      }
      const headers = (d.requestHeaders || []).filter(
        (h) => !/^(referer|origin)$/i.test(h.name)
      );
      headers.push({ name: "Referer", value: tabUrl });
      headers.push({ name: "Origin", value: origin });
      return { requestHeaders: headers };
    };
    const onDone = (d) => {
      active.delete(d.requestId);
    };

    let installed = false;
    for (const extra of [["blocking", "requestHeaders", "extraHeaders"], ["blocking", "requestHeaders"]]) {
      try {
        wr.onBeforeSendHeaders.addListener(onHeaders, { urls: ["<all_urls>"] }, extra);
        installed = true;
        break;
      } catch (e) {
        // extraHeaders не поддержан (старый Firefox) — пробуем без него
      }
    }
    if (!installed) return noop;
    if (wr.onCompleted) {
      try { wr.onCompleted.addListener(onDone); } catch (e) {}
    }
    if (wr.onErrorOccurred) {
      try { wr.onErrorOccurred.addListener(onDone); } catch (e) {}
    }
    const timer = setTimeout(uninstall, REWRITE_TTL_MS); // страховка от утечки слушателя
    function uninstall() {
      clearTimeout(timer);
      if (!installed) return;
      installed = false;
      try { wr.onBeforeSendHeaders.removeListener(onHeaders); } catch (e) {}
      if (wr.onCompleted) { try { wr.onCompleted.removeListener(onDone); } catch (e) {} }
      if (wr.onErrorOccurred) { try { wr.onErrorOccurred.removeListener(onDone); } catch (e) {} }
    }
    return uninstall;
  }

  /**
   * Стриминг тела в file.chunk (backpressure: ждём file.ack через io.sendChunk).
   * Завершение — io.sendEnd({transferId, sha256}); сбой — reader.cancel() +
   * io.sendAbort. Ошибки НЕ пробрасываются наружу: res на fetchFile уже ушёл.
   */
  async function streamBody(resp, transferId, io, env) {
    const hash = (env && env.hashImpl) || BridgeSha256.create();
    const reader = resp.body.getReader();
    let seq = 0;
    let buf = new Uint8Array(0);

    async function emit(bytes) {
      hash.update(bytes);
      const ack = await io.sendChunk({ transferId, seq, data_base64: u8ToBase64(bytes) });
      if (!ack || !ack.ok) {
        throw ferr("FETCH_FAILED", "file.ack не получен: " + ((ack && ack.error) || "нет ответа"));
      }
      seq++;
    }

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value && value.length) {
          const merged = new Uint8Array(buf.length + value.length);
          merged.set(buf, 0);
          merged.set(value, buf.length);
          buf = merged;
          while (buf.length >= CHUNK_SIZE) {
            const chunk = buf.slice(0, CHUNK_SIZE);
            buf = buf.slice(CHUNK_SIZE);
            await emit(chunk); // backpressure: ждём file.ack (§8)
          }
        }
        if (done) break;
      }
      if (buf.length) await emit(buf);
    } catch (e) {
      try {
        await reader.cancel();
      } catch (_) {}
      io.sendAbort({ transferId, reason: String((e && e.message) || e) });
      return;
    }
    io.sendEnd({ transferId, sha256: hash.digestHex() });
  }

  /**
   * Запуск трансфера: fetch → проверка заголовков → file.start → res
   * ({transferId, size, mime}); стриминг продолжается в фоне.
   * params: {url, name?, transferId, referer} (referer — URL вкладки).
   * io: {sendStart, sendChunk→Promise<{ok}>, sendEnd, sendAbort}.
   * env — точка внедрения для тестов: {fetchImpl, hashImpl}.
   */
  async function start(params, io, env) {
    const fetchImpl = (env && env.fetchImpl) || globalThis.fetch;
    const url = String(params.url || "");
    const transferId = params.transferId;
    const stopRewrite = installHeaderRewriter(url, String(params.referer || ""));

    let resp;
    try {
      resp = await fetchImpl(url, { credentials: "include" });
    } catch (e) {
      stopRewrite();
      throw ferr("FETCH_FAILED", "fetch failed: " + ((e && e.message) || e));
    }
    if (!resp.ok || !resp.body) {
      stopRewrite();
      throw ferr("FETCH_FAILED", "HTTP " + resp.status);
    }

    const mime = resp.headers.get("content-type") || "application/octet-stream";
    const size = Number(resp.headers.get("content-length")) || 0;
    const name =
      params.name ||
      decodeURIComponent((url.split("/").pop() || "file").split("?")[0]) ||
      "file";
    io.sendStart({ transferId, name, size: size || undefined, mime });

    // Стриминг — в фоне: внутренние ошибки превращаются в file.abort,
    // rewriter снимается по завершении. Отказ ack — тоже abort (§8).
    streamBody(resp, transferId, io, env)
      .catch((e) => {
        console.warn("[bridge] file-relay stream:", e);
        io.sendAbort({ transferId, reason: String((e && e.message) || e) });
      })
      .finally(stopRewrite);

    return { transferId, size, mime };
  }

  return { CHUNK_SIZE, start, streamBody, installHeaderRewriter, u8ToBase64 };
})();
