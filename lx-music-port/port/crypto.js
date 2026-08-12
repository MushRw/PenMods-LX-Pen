'use strict';
/*
 * node:crypto shim for the pen QuickJS runtime.
 * Implements the subset used by lx-music-desktop's musicSdk:
 *   createHash('md5'|'sha1'), createCipheriv('aes-128-ecb'|'aes-128-cbc'),
 *   createDecipheriv (same modes), publicEncrypt (PKCS1 v1.5 via native,
 *   RSA_NO_PADDING via pure-JS BigInt), randomBytes, constants.
 *
 * Native gap: penmusic currently only exposes aes_encrypt (PKCS7), md5,
 * rsa_encrypt (PKCS1 v1.5), random_bytes. AES-128 DECRYPT is implemented here
 * in pure JS so kw leaderboard / wy eapiDecrypt work without native changes.
 */

const I = globalThis.__lxinternal;
require('__port/buffer.js');
const Buf = globalThis.Buffer;

/* ------------------------------------------------------------------ */
/* AES-128 tables                                                      */
/* ------------------------------------------------------------------ */

const SBOX = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];

const INV_SBOX = [
  0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb,
  0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87, 0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb,
  0x54, 0x7b, 0x94, 0x32, 0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
  0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49, 0x6d, 0x8b, 0xd1, 0x25,
  0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92,
  0x6c, 0x70, 0x48, 0x50, 0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
  0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05, 0xb8, 0xb3, 0x45, 0x06,
  0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02, 0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b,
  0x3a, 0x91, 0x11, 0x41, 0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
  0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8, 0x1c, 0x75, 0xdf, 0x6e,
  0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89, 0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b,
  0xfc, 0x56, 0x3e, 0x4b, 0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
  0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xec, 0x5f,
  0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d, 0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef,
  0xa0, 0xe0, 0x3b, 0x4d, 0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
  0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0c, 0x7d,
];

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
}

function keyExpansion(key) {
  const w = new Array(44);
  for (let i = 0; i < 4; i++) {
    w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  }
  for (let i = 4; i < 44; i++) {
    let t = w[i - 1];
    if (i % 4 === 0) {
      t = ((SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) |
        (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
      t = (((t << 8) | (t >>> 24)) ^ (RCON[i / 4 - 1] << 24)) >>> 0;
    }
    w[i] = (w[i - 4] ^ t) >>> 0;
  }
  return w;
}

function addRoundKey(s, w, round) {
  for (let c = 0; c < 4; c++) {
    const word = w[round * 4 + c];
    for (let r = 0; r < 4; r++) s[r + 4 * c] ^= (word >>> (24 - 8 * r)) & 0xff;
  }
}

function subBytes(s) {
  for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
}

function invSubBytes(s) {
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
}

function shiftRows(s) {
  const t = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) t[r + 4 * c] = s[r + 4 * ((c + r) % 4)];
  }
  for (let i = 0; i < 16; i++) s[i] = t[i];
}

function invShiftRows(s) {
  const t = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) t[r + 4 * c] = s[r + 4 * ((c - r + 4) % 4)];
  }
  for (let i = 0; i < 16; i++) s[i] = t[i];
}

function mixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const a0 = s[0 + 4 * c], a1 = s[1 + 4 * c], a2 = s[2 + 4 * c], a3 = s[3 + 4 * c];
    s[0 + 4 * c] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
    s[1 + 4 * c] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
    s[2 + 4 * c] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
    s[3 + 4 * c] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
  }
}

function invMixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const a0 = s[0 + 4 * c], a1 = s[1 + 4 * c], a2 = s[2 + 4 * c], a3 = s[3 + 4 * c];
    s[0 + 4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    s[1 + 4 * c] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    s[2 + 4 * c] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    s[3 + 4 * c] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}

function aes128EncryptBlock(inp, w) {
  const s = new Array(16);
  for (let i = 0; i < 16; i++) s[i] = inp[i];
  addRoundKey(s, w, 0);
  for (let round = 1; round <= 10; round++) {
    subBytes(s);
    shiftRows(s);
    if (round < 10) mixColumns(s);
    addRoundKey(s, w, round);
  }
  return s;
}

function aes128DecryptBlock(inp, w) {
  const s = new Array(16);
  for (let i = 0; i < 16; i++) s[i] = inp[i];
  addRoundKey(s, w, 10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(s);
    invSubBytes(s);
    addRoundKey(s, w, round);
    invMixColumns(s);
  }
  invShiftRows(s);
  invSubBytes(s);
  addRoundKey(s, w, 0);
  return s;
}

function aesCrypt(data, key, iv, encrypt, mode) {
  const w = keyExpansion(key);
  /* PKCS7: encrypt always pads (even when aligned); decrypt never pads */
  const pad = encrypt ? 16 - (data.length % 16) : 0;
  const paddedLen = encrypt ? data.length + pad : data.length;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  if (encrypt) {
    for (let i = data.length; i < paddedLen; i++) padded[i] = pad;
  }
  const out = new Uint8Array(paddedLen);
  if (mode === 'cbc') {
    let prev = iv ? Buf.from(iv).slice(0, 16) : new Uint8Array(16);
    for (let off = 0; off < paddedLen; off += 16) {
      const block = new Array(16);
      for (let i = 0; i < 16; i++) block[i] = encrypt ? padded[off + i] ^ prev[i] : padded[off + i];
      const r = encrypt
        ? aes128EncryptBlock(block, w)
        : aes128DecryptBlock(block, w);
      for (let i = 0; i < 16; i++) {
        out[off + i] = encrypt ? r[i] : (r[i] ^ prev[i]);
      }
      for (let i = 0; i < 16; i++) prev[i] = encrypt ? out[off + i] : padded[off + i];
    }
  } else {
    for (let off = 0; off < paddedLen; off += 16) {
      const block = [];
      for (let i = 0; i < 16; i++) block.push(padded[off + i]);
      const r = encrypt
        ? aes128EncryptBlock(block, w)
        : aes128DecryptBlock(block, w);
      for (let i = 0; i < 16; i++) out[off + i] = r[i];
    }
  }
  let result = out;
  if (!encrypt && paddedLen > 0) {
    const p = result[paddedLen - 1];
    if (p >= 1 && p <= 16 && p <= paddedLen) {
      result = result.slice(0, paddedLen - p);
    }
  }
  return Buf.from(result);
}

/* ------------------------------------------------------------------ */
/* SHA-1 (pure JS)                                                     */
/* ------------------------------------------------------------------ */

function sha1Bytes(bytes) {
  const len = bytes.length;
  const ml = len * 8;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, ml >>> 0, false);
  dv.setUint32(padded.length - 8, Math.floor(ml / 0x100000000), false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      w[i] = ((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) << 1) | ((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) >>> 31);
      w[i] >>>= 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = ((((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0);
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false); odv.setUint32(4, h1, false); odv.setUint32(8, h2, false);
  odv.setUint32(12, h3, false); odv.setUint32(16, h4, false);
  return out;
}

/* ------------------------------------------------------------------ */
/* RSA NO_PADDING (pure JS, BigInt)                                    */
/* ------------------------------------------------------------------ */

function parsePemPublicKey(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = I.b64ToBytes(b64);
  const ints = [];
  let i = 0;
  while (i < der.length - 1) {
    if (der[i] === 0x02) {
      let len = der[i + 1];
      let off = 2;
      if (len & 0x80) {
        const nlen = len & 0x7f;
        len = 0;
        for (let k = 0; k < nlen; k++) len = len * 256 + der[i + 2 + k];
        off = 2 + nlen;
      }
      const start = i + off;
      ints.push(der.slice(start, start + len));
      i = start + len;
    } else {
      i++;
    }
  }
  if (ints.length < 2) throw new Error('parsePemPublicKey: no modulus/exponent found');
  let n = ints[0];
  /* DER INTEGER may carry a leading 0x00 for the sign bit */
  while (n.length > 1 && n[0] === 0) n = n.slice(1);
  return { n, e: ints[1] };
}

function bytesToBigInt(bytes) {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function bigIntToBytes(v, size) {
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function rsaNoPadding(data, pem) {
  const { n, e } = parsePemPublicKey(pem);
  const modulus = bytesToBigInt(n);
  const exp = bytesToBigInt(e);
  const size = n.length;
  let msg = data;
  if (msg.length < size) {
    const pad = new Uint8Array(size);
    pad.set(msg, size - msg.length);
    msg = pad;
  }
  let m = bytesToBigInt(msg);
  if (m >= modulus) m = m % modulus;
  let result = 1n;
  let base = m;
  let eBits = exp;
  while (eBits > 0n) {
    if (eBits & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    eBits >>= 1n;
  }
  return Buf.from(bigIntToBytes(result, size));
}

/* ------------------------------------------------------------------ */
/* node:crypto facade                                                  */
/* ------------------------------------------------------------------ */

function toBytes(v) {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return I.strToBytes(v);
  if (Array.isArray(v)) return Uint8Array.from(v);
  throw new Error('crypto: unsupported input');
}

function createHash(alg) {
  alg = String(alg || '').toLowerCase();
  let data = null;
  return {
    update(v) {
      data = data ? Buf.concat([data, Buf.from(toBytes(v))]) : Buf.from(toBytes(v));
      return this;
    },
    digest(encoding) {
      const bytes = data || new Uint8Array(0);
      let raw;
      if (alg === 'md5') raw = I.crypto.md5(bytes);
      else if (alg === 'sha1') raw = I.bytesToHex(sha1Bytes(bytes));
      else throw new Error('crypto: unsupported hash ' + alg);
      if (encoding === 'hex') return raw;
      const rb = I.hexToBytes(raw);
      if (encoding === 'base64') return I.bytesToB64(rb);
      return Buf.from(rb);
    },
  };
}

function createCipheriv(alg, key, iv) {
  alg = String(alg || '').toLowerCase();
  const mode = alg.indexOf('ecb') >= 0 ? 'ecb' : 'cbc';
  const k = Buf.from(toBytes(key));
  const ivb = iv === undefined || iv === null || iv === '' ? new Uint8Array(0) : Buf.from(toBytes(iv));
  return {
    update(v) {
      if (mode === 'ecb') return aesCrypt(toBytes(v), k, null, true, 'ecb');
      return aesCrypt(toBytes(v), k, ivb, true, 'cbc');
    },
    final() { return Buf.alloc(0); },
  };
}

function createDecipheriv(alg, key, iv) {
  alg = String(alg || '').toLowerCase();
  const mode = alg.indexOf('ecb') >= 0 ? 'ecb' : 'cbc';
  const k = Buf.from(toBytes(key));
  const ivb = iv === undefined || iv === null || iv === '' ? new Uint8Array(0) : Buf.from(toBytes(iv));
  return {
    update(v) {
      if (mode === 'ecb') return aesCrypt(toBytes(v), k, null, false, 'ecb');
      return aesCrypt(toBytes(v), k, ivb, false, 'cbc');
    },
    final() { return Buf.alloc(0); },
  };
}

function publicEncrypt(options, buffer) {
  const key = typeof options === 'object' ? options.key : options;
  const padding = typeof options === 'object' ? options.padding : undefined;
  if (padding === 3) return rsaNoPadding(toBytes(buffer), key);
  return Buf.from(I.crypto.rsaEncrypt(toBytes(buffer), String(key)));
}

function randomBytes(size) {
  return Buf.from(I.crypto.randomBytes(size || 16));
}

module.exports = {
  createHash,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  randomBytes,
  constants: { RSA_NO_PADDING: 3, RSA_PKCS1_PADDING: 1 },
  // internal, for tests
  __aesCrypt: aesCrypt,
  __sha1Bytes: sha1Bytes,
  __parsePemPublicKey: parsePemPublicKey,
};
