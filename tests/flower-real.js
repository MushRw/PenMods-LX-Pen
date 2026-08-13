'use strict';
/* Node 真实网络加载 flower/grass（rawScript 由 C 层逻辑提供），诊断初始化与 musicUrl */
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');
const ROOT = 'E:/code/youdao/lx-pen';
const SCRIPT = process.env.SCRIPT || 'tests/sources/flower.js';

const sandbox = {
  console: { log: (...a) => console.log('CONSOLE:', a.map(x => typeof x === 'string' ? x.slice(0, 150) : JSON.stringify(x).slice(0, 150)).join(' ')), info: () => {}, warn: () => {}, error: (...a) => console.log('CONSOLE-ERR:', a.map(String).join(' ').slice(0, 150)), debug: () => {}, group: () => {}, groupEnd: () => {}, groupCollapsed: () => {} },
  setTimeout, clearTimeout, Uint8Array, ArrayBuffer, Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, RegExp, Error, TypeError, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const enc = {
  strToBytes: s => Uint8Array.from(Buffer.from(String(s), 'utf8')),
  bytesToStr: b => Buffer.from(b).toString('utf8'),
  strToB64: s => Buffer.from(String(s), 'utf8').toString('base64'),
  b64ToStr: s => Buffer.from(String(s), 'base64').toString('utf8'),
  b64ToBytes: s => Uint8Array.from(Buffer.from(String(s), 'base64')),
  bytesToB64: b => Buffer.from(b).toString('base64'),
  bytesToHex: b => Buffer.from(b).toString('hex'),
  hexToBytes: s => Uint8Array.from(Buffer.from(String(s), 'hex')),
};
sandbox.__lxinternal = enc;
const timers = new Map();
sandbox.__lx_native_call__set_timeout = (id, ms) => { const t = setTimeout(() => sandbox.__lx_timer_fire(id), ms); timers.set(id, t); };
sandbox.__lx_native_call__clear_timeout = id => { const t = timers.get(id); if (t) clearTimeout(t); timers.delete(id); };
sandbox.__lx_native_call__request_start = (id, url, optsJson) => {
  setTimeout(() => {
    const http = url.indexOf('https:') === 0 ? require('https') : require('http');
    const u = new URL(url);
    const opts = JSON.parse(optsJson);
    const headers = Object.assign({ 'User-Agent': 'lx-pen-test' }, (opts.headers || []).reduce((o, h) => { const i = h.indexOf(':'); if (i > 0) o[h.slice(0, i).trim()] = h.slice(i + 1).trim(); return o; }, {}));
    const req = http.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: opts.method, headers, timeout: 25000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        console.log('REQ', id, res.statusCode, url.slice(0, 80), 'body=', buf.slice(0, 90).toString('utf8').replace(/\n/g, ' '));
        const resp = { status: res.statusCode, headers: res.headers, body: opts.binary ? buf.toString('base64') : buf.toString('utf8') };
        sandbox.__lx_request_done(String(id), null, JSON.stringify(resp));
      });
    });
    req.on('timeout', () => { console.log('REQ', id, 'TIMEOUT', url.slice(0, 80)); req.destroy(new Error('timeout')); });
    req.on('error', e => { console.log('REQ', id, 'ERR', e.message, url.slice(0, 80)); sandbox.__lx_request_done(String(id), JSON.stringify({ message: e.message }), '{}'); });
    if (opts.body) req.write(opts.body);
    req.end();
  }, 1);
};
sandbox.__lx_native_call__request_cancel = () => {};
sandbox.__lx_native_call__md5 = b => crypto.createHash('md5').update(Buffer.from(b)).digest('hex');
sandbox.__lx_native_call__aes_encrypt = () => { throw new Error('fake aes'); };
sandbox.__lx_native_call__rsa_encrypt = () => { throw new Error('fake rsa'); };
sandbox.__lx_native_call__random_bytes = n => Uint8Array.from(crypto.randomBytes(n));
sandbox.__lx_native_call__zlib_inflate = b => Uint8Array.from(zlib.inflateSync(Buffer.from(b)));
sandbox.__lx_native_call__zlib_deflate = b => Uint8Array.from(zlib.deflateSync(Buffer.from(b)));
sandbox.__lx_native_call__send = (ev, data) => { console.log('EVENT', ev, data.slice(0, 100)); };
sandbox.__lx_native_call__log = (lv, msg) => console.log('LOG', lv, msg.slice(0, 120));
sandbox.__lx_native_call__file_write = () => true;
sandbox.__lx_native_call__file_exists = () => true;
sandbox.__lx_native_call__rpc_done = () => {};
const alias = { str_to_bytes: enc.strToBytes, bytes_to_str: enc.bytesToStr, str_to_b64: enc.strToB64, b64_to_str: enc.b64ToStr, b64_to_bytes: enc.b64ToBytes, bytes_to_b64: enc.bytesToB64 };
for (const n of Object.keys(alias)) sandbox['__lx_native_call__' + n] = a => alias[n](a);

/* 模拟 C 层 set_script_meta_from_head：rawScript = 全文 */
const raw = fs.readFileSync(ROOT + '/' + SCRIPT, 'utf8');
function parseMeta(buf) {
  const out = { rawScript: buf };
  for (const key of ['name', 'description', 'version', 'author', 'homepage']) {
    const re = new RegExp('@' + key + '\\s+([^\\n\\r*]+)');
    const m = buf.match(re);
    if (m) out[key] = m[1].trim().replace(/\s+\*\/?$/, '').trim();
  }
  return out;
}

vm.runInContext(fs.readFileSync(ROOT + '/plugin/js/lx-shim.js', 'utf8'), sandbox);
sandbox.__lx_set_script_meta(parseMeta(raw));
console.log('meta:', JSON.stringify({ name: sandbox.lx.currentScriptInfo.name, version: sandbox.lx.currentScriptInfo.version, rawLen: sandbox.lx.currentScriptInfo.rawScript.length }));
try {
  vm.runInContext(raw, sandbox);
  console.log('script loaded OK');
} catch (e) { console.log('LOAD ERR:', e.message); process.exit(1); }

setTimeout(async () => {
  console.log('--- wait 25s, test kw musicUrl ---');
  try {
    const u = await sandbox.lx._dispatchRequest({ source: 'kw', action: 'musicUrl', info: { type: '128k', musicInfo: { songmid: '397242799' } } });
    console.log('kw musicUrl:', String(u).slice(0, 150));
  } catch (e) { console.log('kw ERR:', e.message); }
  process.exit(0);
}, 25000);
