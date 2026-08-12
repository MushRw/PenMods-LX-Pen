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
  'send', 'log', 'file_write', 'file_exists', 'rpc_done',
];
for (const __n of __nativeNames) {
  const __fn = globalThis['__lx_native_call__' + __n];
  if (typeof __fn === 'function') native[__n] = (...args) => __fn(...args);
  else native[__n] = () => { throw new Error('native ' + __n + ' unavailable'); };
}

function strToBytes(str) { return native.str_to_bytes(String(str)); }
function bytesToStr(bytes) { return native.bytes_to_str(bytes); }
function strToB64(str) { return native.str_to_b64(String(str)); }
function b64ToStr(b64) { return native.b64_to_str(String(b64)); }
function b64ToBytes(b64) { return native.b64_to_bytes(String(b64)); }
function bytesToB64(bytes) { return native.bytes_to_b64(bytes); }

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
globalThis.console = consoleObj;

/* ---------------- lx object ---------------- */
const lx = {};
lx.version = '2.0.0';
lx.env = 'pen';
lx.currentScriptInfo = { name: '', description: '', version: '', author: '', homepage: '', rawScript: '' };
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
    p.reject(new Error(msg));
    return;
  }
  let resp = null;
  try { resp = JSON.parse(respJson); } catch (e) { p.reject(new Error('bad response')); return; }
  if (p.binary && typeof resp.body === 'string') resp.body = b64ToBytes(resp.body);
  p.resolve(resp);
};

/* ---------------- utils ---------------- */
function bytesArg(v) {
  if (v instanceof Uint8Array) return v;
  if (v === undefined || v === null) return strToBytes('');
  return strToBytes(v);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

const buffer = {
  from(input, format) {
    if (input instanceof Uint8Array) return input.slice(0);
    if (typeof input !== 'string') throw new Error('buffer.from: unsupported input');
    format = format || 'utf8';
    if (format === 'base64') return b64ToBytes(input);
    if (format === 'hex') return hexToBytes(input);
    if (format === 'utf8') return strToBytes(input);
    throw new Error('buffer.from: unsupported format ' + format);
  },
  bufToString(input, format) {
    if (!(input instanceof Uint8Array)) throw new Error('bufToString: expected Uint8Array');
    format = format || 'utf8';
    if (format === 'base64') return bytesToB64(input);
    if (format === 'hex') return bytesToHex(input);
    if (format === 'utf8') return bytesToStr(input);
    throw new Error('bufToString: unsupported format ' + format);
  },
};

const crypto = {
  aesEncrypt(input, mode, key, iv) {
    let m;
    if (mode === 'AES/CBC/PKCS7Padding') m = 'cbc';
    else if (mode === 'AES') m = 'ecb';
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
