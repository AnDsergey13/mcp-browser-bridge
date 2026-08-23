"use strict";

/**
 * sha256.js — инкрементальный SHA-256 на чистом JS, внешних зависимостей
 * ноль (решение проекта). Нужен файловому релею (file-relay.js): digest
 * считается по мере стриминга чанков, файл целиком в память не собирается
 * (раньше content script склеивал файл ради crypto.subtle — тройное
 * буферирование, ~3x RAM на гигабайтном файле).
 *
 * API: BridgeSha256.create() → { update(Uint8Array), digestHex() }.
 * digestHex() терминальный: повторный вызов вернёт тот же digest, состояние
 * при этом не портится (padding считается на копии).
 * Проверен на эталонных векторах (test/file-relay.test.mjs).
 */
const BridgeSha256 = (() => {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H_INIT = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  function create() {
    const h = H_INIT.slice();
    const w = new Uint32Array(64);
    const block = new Uint8Array(64); // недобранный хвост между update()
    let blockLen = 0;
    let lenLo = 0; // младшее слово длины в БИТАХ
    let lenHi = 0; // старшее

    function compress() {
      for (let i = 0; i < 16; i++) {
        const o = i * 4;
        w[i] = (block[o] << 24) | (block[o + 1] << 16) | (block[o + 2] << 8) | block[o + 3];
      }
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
        const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }

    function update(u8) {
      let bits = u8.length * 8; // < 2^53 — точно
      lenLo = (lenLo + bits) >>> 0;
      if (lenLo < bits >>> 0) lenHi = (lenHi + 1) >>> 0;
      lenHi = (lenHi + Math.floor(u8.length / 0x20000000)) >>> 0; // перенос битов длины > 2^32
      let off = 0;
      while (off < u8.length) {
        const take = Math.min(64 - blockLen, u8.length - off);
        block.set(u8.subarray(off, off + take), blockLen);
        blockLen += take;
        off += take;
        if (blockLen === 64) {
          compress();
          blockLen = 0;
        }
      }
    }

    function digestHex() {
      // padding на копии состояния — исходный hasher остаётся валидным
      const saved = { h: h.slice(), block: block.slice(), blockLen, lenLo, lenHi };
      const bitsLo = lenLo, bitsHi = lenHi;
      update(new Uint8Array([0x80]));
      while (blockLen !== 56) update(new Uint8Array([0]));
      block[56] = bitsHi >>> 24; block[57] = bitsHi >>> 16; block[58] = bitsHi >>> 8; block[59] = bitsHi;
      block[60] = bitsLo >>> 24; block[61] = bitsLo >>> 16; block[62] = bitsLo >>> 8; block[63] = bitsLo;
      compress();
      let out = "";
      for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, "0");
      // откат состояния (hasher остаётся пригодным — на случай повторного digestHex)
      h.set(saved.h); block.set(saved.block); blockLen = saved.blockLen;
      lenLo = saved.lenLo; lenHi = saved.lenHi;
      return out;
    }

    return { update, digestHex };
  }

  return { create };
})();
