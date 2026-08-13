'use strict';
/*
 * lx-music custom source API shim for penmusic.
 * Native functions are provided by penmusic.c as globalThis.__lx_native_call__*.
 * API follows the LX Music custom-source spec (desktop/mobile compatible subset).
 * Derived from lx-music-mobile (MIT, (c) lyswhut/lx-music-mobile) user-api-preload.js.
 */

/*
 * penmusic.c 以全局函数形式注册原生接口：__lx_native_call__<name>
 */
const native = {};
const __nativeNames = [
  'set_timeout', 'clear_timeout', 'request_start', 'request_cancel',
  'md5', 'aes_encrypt', 'rsa_encrypt', 'random_bytes',
  'zlib_inflate', 'zlib_deflate',
  'str_to_bytes', 'bytes_to_str', 'str_to_b64', 'b64_to_str',
  'b64_to_bytes', 'bytes_to_b64',
  'send', 'log', 'file_write', 'file_exists', 'download', 'rpc_done',
];
for (const __n of __nativeNames) {
  const __fn = globalThis['__lx_native_call__' + __n];
  if (typeof __fn === 'function') native[__n] = (...args) => __fn(...args);
  else native[__n] = () => { throw new Error('native ' + __n + ' unavailable'); };
}

/* 统一把 Array/类数组/Uint8Array 规整为 Uint8Array（sixyin 等音源常传普通字节数组） */
function toU8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input && typeof input === 'object' && typeof input.length === 'number') return Uint8Array.from(input);
  return null;
}
function strToBytes(str) { return native.str_to_bytes(String(str)); }
function bytesToStr(bytes) {
  const u = toU8(bytes);
  return native.bytes_to_str(u !== null ? u : bytes);
}
function strToB64(str) { return native.str_to_b64(String(str)); }
function b64ToStr(b64) { return native.b64_to_str(String(b64)); }
function b64ToBytes(b64) {
  const r = native.b64_to_bytes(String(b64));
  const u = toU8(r);
  return u !== null ? u : r;
}
function bytesToB64(bytes) {
  const u = toU8(bytes);
  return native.bytes_to_b64(u !== null ? u : bytes);
}
function bytesToHex(bytes) {
  const u = toU8(bytes);
  let s = '';
  const src = u !== null ? u : bytes;
  for (let i = 0; i < src.length; i++) s += (src[i] < 16 ? '0' : '') + src[i].toString(16);
  return s;
}

/* ---------------- timers ---------------- */
const __timers = Object.create(null);
let __timerSeq = 0;

globalThis.setTimeout = (callback, timeout, ...params) => {
  if (typeof callback !== 'function') throw new Error('setTimeout: callback required a function');
  const ms = typeof timeout === 'number' && timeout > 0 ? parseInt(timeout) : 0;
  const id = ++__timerSeq;
  __timers[id] = { callback, params };
  native.set_timeout(id, ms);
  return id;
};

globalThis.clearTimeout = (id) => {
  delete __timers[id];
  native.clear_timeout(id);
};

globalThis.__lx_timer_fire = (id) => {
  const t = __timers[id];
  delete __timers[id];
  if (!t) return;
  try {
    t.callback.apply(null, t.params);
  } catch (e) {
    native.log('error', 'timer error: ' + (e && e.message ? e.message : String(e)));
  }
};

/* ---------------- console ---------------- */
const consoleObj = {};
['log', 'info', 'warn', 'error', 'debug'].forEach(lv => {
  consoleObj[lv] = (...args) => {
    let s = '';
    for (const a of args) {
      if (s) s += ' ';
      if (typeof a === 'string') s += a;
      else if (a instanceof Uint8Array) s += bytesToStr(a);
      else {
        try { s += JSON.stringify(a); } catch (e) { s += String(a); }
      }
    }
    native.log(lv, s);
  };
});
/* 兼容部分音源脚本（ikun 等）的分组日志调用 */
consoleObj.group = consoleObj.groupEnd = consoleObj.groupCollapsed = () => {};
globalThis.console = consoleObj;

/* ---------------- lx object ---------------- */
const lx = {};
lx.version = '2.0.0';
/* 与 lx-music 桌面版一致：sixyin 等音源用 env 作为服务端 p 参数，'pen' 会导致鉴权失败 */
lx.env = 'desktop';
lx.currentScriptInfo = {
  name: 'LX Pen source',
  description: 'LX Pen custom music source',
  version: '1.0.0',
  author: '',
  homepage: '',
  rawScript: '',
};
/* runner 可在 eval 音源脚本前调用，用脚本头部注释解析出的元数据覆盖（sixyin 等校验这些字段） */
globalThis.__lx_set_script_meta = (meta) => {
  if (!meta || typeof meta !== 'object') return;
  const info = lx.currentScriptInfo;
  for (const k of ['name', 'description', 'version', 'author', 'homepage', 'rawScript']) {
    if (typeof meta[k] === 'string') info[k] = meta[k];
  }
};
lx.EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' };

let __requestHandler = null;
lx.on = (event, handler) => {
  if (event !== lx.EVENT_NAMES.request) throw new Error('unsupported event: ' + event);
  if (typeof handler !== 'function') throw new Error('lx.on: handler required');
  __requestHandler = handler;
};

lx._dispatchRequest = (payload) => {
  if (typeof __requestHandler !== 'function') return Promise.reject(new Error('script did not register request handler'));
  return Promise.resolve().then(() => __requestHandler(payload));
};

lx.send = (event, data) => {
  native.send(String(event), JSON.stringify(data === undefined ? null : data));
};

/* ---------------- request ---------------- */
let __reqSeq = 0;
const __pendingReqs = Object.create(null);

function encodeForm(obj) {
  const parts = [];
  for (const k of Object.keys(obj || {})) {
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])));
  }
  return parts.join('&');
}

function encodeMultipart(obj) {
  const boundary = '----penmusic' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
  let body = '';
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    body += '--' + boundary + '\r\n';
    body += 'Content-Disposition: form-data; name="' + k + '"\r\n\r\n';
    body += String(v) + '\r\n';
  }
  body += '--' + boundary + '--\r\n';
  return { body, contentType: 'multipart/form-data; boundary=' + boundary };
}

lx.request = (url, options, callback) => {
  if (typeof url !== 'string' || !url) throw new Error('request: url required');
  options = options || {};
  let method = (options.method || '').toUpperCase();
  let body = null;
  const headers = [];
  const hdrs = options.headers || {};
  for (const k of Object.keys(hdrs)) headers.push(k + ': ' + hdrs[k]);

  if (options.body !== undefined && options.body !== null) {
    body = String(options.body);
  }
  if (options.form) {
    body = encodeForm(options.form);
    headers.push('Content-Type: application/x-www-form-urlencoded');
  }
  if (options.formData) {
    const m = encodeMultipart(options.formData);
    body = m.body;
    headers.push('Content-Type: ' + m.contentType);
  }
  if (!method && body !== null) method = 'POST';
  if (!method) method = 'GET';

  const reqId = ++__reqSeq;
  native.log('debug', 'REQ ' + reqId + ' ' + method + ' ' + url);
  const opts = {
    method,
    headers,
    body,
    timeout: typeof options.timeout === 'number' && options.timeout > 0 ? parseInt(options.timeout) : 30000,
    binary: !!options.binary,
  };

  const promise = new Promise((resolve, reject) => {
    __pendingReqs[reqId] = { resolve, reject, binary: opts.binary };
    native.request_start(reqId, url, JSON.stringify(opts));
  });

  if (typeof callback === 'function') {
    promise.then(resp => callback(null, resp), err => callback(err));
    return () => native.request_cancel(reqId);
  }
  return promise;
};

globalThis.__lx_request_done = (id, errJson, respJson) => {
  /* pen 上无 process 全局（旧插件每次请求完成都会 ReferenceError 的根因） */
  if (globalThis.__lxinternal && typeof process !== 'undefined' && process.env && process.env.DEBUG_RAW) {
    const dbg = globalThis.__lxinternal;
    dbg.native.log('debug', 'req_done id=' + id + ' err=' + errJson + ' resp=' + String(respJson).slice(0, 200));
  }
  const p = __pendingReqs[String(id)];
  delete __pendingReqs[String(id)];
  if (!p) return;
  if (errJson) {
    let msg = 'request failed';
    try { msg = JSON.parse(errJson).message || msg; } catch (e) { /* ignore */ }
    native.log('debug', 'REQERR ' + id + ' ' + msg);
    p.reject(new Error(msg));
    return;
  }
  let resp = null;
  try { resp = JSON.parse(respJson); } catch (e) { p.reject(new Error('bad response')); return; }
  /* 原版 lx preload（needle）返回 statusCode；penmusic C 层返回 status —— 兼容两者 */
  if (resp.statusCode === undefined && resp.status !== undefined) resp.statusCode = resp.status;
  if (resp.status === undefined && resp.statusCode !== undefined) resp.status = resp.statusCode;
  native.log('debug', 'DONE ' + id + ' status=' + resp.status + ' body=' + String(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)).slice(0, 200));
  if (p.binary) {
    if (typeof resp.body === 'string') resp.body = b64ToBytes(resp.body);
  } else if (typeof resp.body === 'string') {
    /* 与 lx-music 原版 preload 一致：JSON 响应自动解析为对象（ikun 等音源依赖 body.code） */
    try { resp.body = JSON.parse(resp.body); } catch (e) { /* 保留原始字符串 */ }
  }
  p.resolve(resp);
};

/* ---------------- utils ---------------- */
function bytesArg(v) {
  const u = toU8(v);
  if (u !== null) return u;
  if (v === undefined || v === null) return strToBytes('');
  return strToBytes(v);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function normBufFormat(format) {
  format = String(format || 'utf8').toLowerCase();
  if (format === 'utf-8') return 'utf8';
  return format;
}

const buffer = {
  from(input, format) {
    if (input instanceof Uint8Array) return input.slice(0);
    if (Array.isArray(input) || (input && typeof input === 'object' && typeof input.length === 'number')) {
      return Uint8Array.from(input);
    }
    if (typeof input !== 'string') throw new Error('buffer.from: unsupported input');
    format = normBufFormat(format);
    if (format === 'base64') return b64ToBytes(input);
    if (format === 'hex') return hexToBytes(input);
    if (format === 'utf8') return strToBytes(input);
    throw new Error('buffer.from: unsupported format ' + format);
  },
  bufToString(input, format) {
    format = normBufFormat(format);
    const u = toU8(input);
    if (u !== null) input = u;
    if (typeof input === 'string') {
      /* 模拟原版 Buffer.from(buf, 'binary')：字符串按 latin1 转字节 */
      const bytes = new Uint8Array(input.length);
      for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i) & 0xff;
      input = bytes;
    }
    if (!(input instanceof Uint8Array)) throw new Error('bufToString: expected Uint8Array');
    if (format === 'base64') return bytesToB64(input);
    if (format === 'hex') return bytesToHex(input);
    if (format === 'utf8') return bytesToStr(input);
    throw new Error('bufToString: unsupported format ' + format);
  },
};

const crypto = {
  aesEncrypt(input, mode, key, iv) {
    let m;
    if (mode === 'AES/CBC/PKCS7Padding' || mode === 'aes-128-cbc') m = 'cbc';
    else if (mode === 'AES' || mode === 'aes-128-ecb') m = 'ecb';
    else if (mode === 'cbc' || mode === 'ecb') m = mode;
    else throw new Error('aesEncrypt: unsupported mode ' + mode);
    return native.aes_encrypt(bytesArg(input), m, bytesArg(key), bytesArg(iv));
  },
  md5(input) {
    return native.md5(bytesArg(input));
  },
  randomBytes(size) {
    return native.random_bytes(size);
  },
  rsaEncrypt(input, key) {
    return native.rsa_encrypt(bytesArg(input), String(key));
  },
};

const zlib = {
  inflate(input) {
    return Promise.resolve(native.zlib_inflate(bytesArg(input)));
  },
  deflate(input) {
    return Promise.resolve(native.zlib_deflate(bytesArg(input)));
  },
};

lx.utils = { buffer, crypto, zlib };

Object.defineProperty(globalThis, 'lx', {
  value: lx,
  writable: false,
  configurable: true,
  enumerable: true,
});

/* internal helpers shared with adapters/runtime */
globalThis.__lxinternal = {
  request: lx.request,
  crypto,
  buffer,
  bytesArg,
  strToBytes,
  bytesToStr,
  strToB64,
  b64ToStr,
  b64ToBytes,
  bytesToB64,
  bytesToHex,
  hexToBytes,
  native,
};

/* ------------------------------------------------------------------ */
/* Node 兼容层：webpack 打包的音源（lx v4 等）require('crypto'/'buffer') */
/* ------------------------------------------------------------------ */

/* 纯 JS SHA-256（词典笔 C 层无 sha256；签名计算频率低，性能足够） */
function jsSha256(data) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bytes = [];
  for (let i = 0; i < data.length; i++) bytes.push(data.charCodeAt(i) & 0xff);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i * 8)) & 0xff);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  function hex(v) {
    let s = (v >>> 0).toString(16);
    while (s.length < 8) s = '0' + s;
    return s;
  }
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

/* 简化 Node Buffer（webpack 音源常用 from/alloc/toString/concat/isBuffer） */
function nodeBufferFrom(input, encoding) {
  if (input instanceof Uint8Array) return input.slice(0);
  if (typeof input === 'string') {
    encoding = String(encoding || 'utf8').toLowerCase();
    if (encoding === 'hex') return hexToBytes(input);
    if (encoding === 'base64') return b64ToBytes(input);
    return strToBytes(input);
  }
  throw new Error('Buffer.from unsupported input');
}
function nodeBufferToString(buf, encoding) {
  const u = toU8(buf);
  encoding = String(encoding || 'utf8').toLowerCase();
  if (encoding === 'hex') return bytesToHex(u !== null ? u : buf);
  if (encoding === 'base64') return bytesToB64(u !== null ? u : buf);
  return bytesToStr(u !== null ? u : buf);
}
function NodeBuffer() {}
NodeBuffer.from = nodeBufferFrom;
NodeBuffer.alloc = (size, fill) => {
  const out = new Uint8Array(size);
  if (fill !== undefined && fill !== 0) out.fill(typeof fill === 'number' ? fill : fill.charCodeAt(0));
  return out;
};
NodeBuffer.allocUnsafe = size => new Uint8Array(size);
NodeBuffer.concat = (list) => {
  let len = 0;
  for (const b of list) len += b.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
};
NodeBuffer.isBuffer = b => b instanceof Uint8Array || (b && b.constructor === NodeBuffer);
NodeBuffer.byteLength = s => String(s).length;
NodeBuffer.prototype.toString = function (encoding, start, end) {
  const slice = this.slice(start || 0, end === undefined ? this.length : end);
  return nodeBufferToString(slice, encoding);
};
NodeBuffer.prototype.slice = function (start, end) {
  return new Uint8Array(this.buffer ? this.buffer : this, start || 0, (end === undefined ? this.length : end) - (start || 0));
};

const nodeCrypto = {
  createHash(alg) {
    alg = String(alg).toLowerCase();
    if (alg === 'md5') {
      let data = '';
      return {
        update(d) {
          data += typeof d === 'string' ? d : bytesToStr(toU8(d) || d);
          return this;
        },
        digest(enc) {
          const h = native.md5(strToBytes(data));
          return enc === 'hex' ? bytesToHex(toU8(h) || h) : toU8(h) || h;
        },
      };
    }
    if (alg === 'sha256') {
      let data = '';
      return {
        update(d) {
          data += typeof d === 'string' ? d : bytesToStr(toU8(d) || d);
          return this;
        },
        digest(enc) {
          const h = jsSha256(data);
          return enc === 'hex' ? h : strToBytes(h);
        },
      };
    }
    throw new Error('createHash unsupported: ' + alg);
  },
  createHmac() { throw new Error('createHmac not supported'); },
  createCipheriv() { throw new Error('createCipheriv not supported'); },
  randomBytes: size => native.random_bytes(size),
};

globalThis.require = (name) => {
  if (name === 'crypto') return nodeCrypto;
  if (name === 'buffer') return { Buffer: NodeBuffer };
  throw new Error('module not found: ' + name);
};
globalThis.Buffer = NodeBuffer;
globalThis.process = {
  env: {},
  version: 'v18.0.0',
  platform: 'linux',
  arch: 'arm64',
  nextTick: (fn, ...args) => setTimeout(() => fn.apply(null, args), 0),
  exit: () => { /* 音源脚本可能调用 process.exit（环境检测），在 runner 内忽略 */ },
};
