'use strict';
/* 本地用 lx SDK 搜索，拿 songmid */
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');
const ROOT = 'E:/code/youdao/lx-pen';
const KEYWORD = process.argv[2] || '海阔天空';

const sandbox = {
  console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
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
    const headers = Object.assign({ 'User-Agent': 'Mozilla/5.0' }, (opts.headers || []).reduce((o, h) => { const i = h.indexOf(':'); if (i > 0) o[h.slice(0, i).trim()] = h.slice(i + 1).trim(); return o; }, {}));
    const req = http.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: opts.method, headers, timeout: 20000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const resp = { status: res.statusCode, headers: res.headers, body: opts.binary ? buf.toString('base64') : buf.toString('utf8') };
        sandbox.__lx_request_done(String(id), null, JSON.stringify(resp));
      });
    });
    req.on('error', e => sandbox.__lx_request_done(String(id), JSON.stringify({ message: e.message }), '{}'));
    if (opts.body) req.write(opts.body);
    req.end();
  }, 1);
};
sandbox.__lx_native_call__request_cancel = () => {};
sandbox.__lx_native_call__md5 = b => crypto.createHash('md5').update(Buffer.from(b)).digest('hex');
sandbox.__lx_native_call__aes_encrypt = () => { throw new Error('fake'); };
sandbox.__lx_native_call__rsa_encrypt = () => { throw new Error('fake'); };
sandbox.__lx_native_call__random_bytes = n => Uint8Array.from(crypto.randomBytes(n));
sandbox.__lx_native_call__zlib_inflate = b => Uint8Array.from(zlib.inflateSync(Buffer.from(b)));
sandbox.__lx_native_call__zlib_deflate = b => Uint8Array.from(zlib.deflateSync(Buffer.from(b)));
sandbox.__lx_native_call__send = () => {};
sandbox.__lx_native_call__log = () => {};
sandbox.__lx_native_call__file_write = () => true;
sandbox.__lx_native_call__file_exists = () => true;
sandbox.__lx_native_call__rpc_done = () => {};
const alias = { str_to_bytes: enc.strToBytes, bytes_to_str: enc.bytesToStr, str_to_b64: enc.strToB64, b64_to_str: enc.b64ToStr, b64_to_bytes: enc.b64ToBytes, bytes_to_b64: enc.bytesToB64 };
for (const n of Object.keys(alias)) sandbox['__lx_native_call__' + n] = a => alias[n](a);
vm.runInContext(fs.readFileSync(ROOT + '/plugin/js/lx-shim.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(ROOT + '/plugin/js/lx-sdk.js', 'utf8'), sandbox);
(async () => {
  const res = await sandbox.__lxSdk.kw.musicSearch.search(KEYWORD, 1, 5);
  const list = res.list || [];
  console.log('kw 结果数:', list.length);
  list.slice(0, 5).forEach((s, i) => console.log(i, s.name, '|', s.singer, '| songmid:', s.songmid, '| hash:', s.hash || ''));
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
