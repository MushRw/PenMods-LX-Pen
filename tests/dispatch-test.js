'use strict';
/* 验证 sixyin 的 source 分发：kw 与 mg 应请求不同 API */
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');
const ROOT = 'E:/code/youdao/lx-pen';

const sandbox = {
  console: { log: (...a) => console.log('CONSOLE:', a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ').slice(0, 300)), info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, group: () => {}, groupEnd: () => {}, groupCollapsed: () => {} },
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
const reqs = [];
const timers = new Map();
sandbox.__lx_native_call__set_timeout = (id, ms) => { const t = setTimeout(() => sandbox.__lx_timer_fire(id), ms); timers.set(id, t); };
sandbox.__lx_native_call__clear_timeout = id => { const t = timers.get(id); if (t) clearTimeout(t); timers.delete(id); };
sandbox.__lx_native_call__request_start = (id, url, optsJson) => {
  reqs.push(url);
  setTimeout(() => {
    if (globalThis.__REAL_NET) {
      const http = url.indexOf('https:') === 0 ? require('https') : require('http');
      const u = new URL(url);
      const opts = JSON.parse(optsJson);
      const headers = Object.assign({ 'User-Agent': 'Mozilla/5.0' }, (opts.headers || []).reduce((o, h) => {
        const i = h.indexOf(':');
        if (i > 0) o[h.slice(0, i).trim()] = h.slice(i + 1).trim();
        return o;
      }, {}));
      const req = http.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: opts.method, headers, timeout: 20000 }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const resp = { status: res.statusCode, headers: res.headers, body: opts.binary ? buf.toString('base64') : buf.toString('utf8') };
          sandbox.__lx_request_done(String(id), null, JSON.stringify(resp));
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', e => sandbox.__lx_request_done(String(id), JSON.stringify({ message: e.message }), '{}'));
      if (opts.body) req.write(opts.body);
      req.end();
      return;
    }
    let resp;
    if (url.indexOf('hibai.cn') >= 0) resp = { status: 200, headers: {}, body: JSON.stringify({ success: true, qualityList: ['128k', '320k', 'flac'], platformList: ['tx', 'kw', 'kg', 'mg'] }) };
    else if (url.indexOf('kuwo.cn') >= 0) resp = { status: 200, headers: {}, body: 'url=https://example.com/kuwo.mp3' };
    else resp = { status: 200, headers: {}, body: JSON.stringify({ result: 'https://example.com/other.mp3' }) };
    sandbox.__lx_request_done(String(id), null, JSON.stringify(resp));
  }, 1);
};
sandbox.__lx_native_call__request_cancel = () => {};
sandbox.__lx_native_call__md5 = b => crypto.createHash('md5').update(Buffer.from(b)).digest('hex');
sandbox.__lx_native_call__aes_encrypt = () => { throw new Error('fake aes'); };
sandbox.__lx_native_call__rsa_encrypt = () => { throw new Error('fake rsa'); };
sandbox.__lx_native_call__random_bytes = n => Uint8Array.from(crypto.randomBytes(n));
sandbox.__lx_native_call__zlib_inflate = b => Uint8Array.from(zlib.inflateSync(Buffer.from(b)));
sandbox.__lx_native_call__zlib_deflate = b => Uint8Array.from(zlib.deflateSync(Buffer.from(b)));
sandbox.__lx_native_call__send = (ev, data) => {};
sandbox.__lx_native_call__log = () => {};
sandbox.__lx_native_call__file_write = () => true;
sandbox.__lx_native_call__file_exists = () => true;
sandbox.__lx_native_call__rpc_done = () => {};
const alias = { str_to_bytes: enc.strToBytes, bytes_to_str: enc.bytesToStr, str_to_b64: enc.strToB64, b64_to_str: enc.b64ToStr, b64_to_bytes: enc.b64ToBytes, bytes_to_b64: enc.bytesToB64 };
for (const n of Object.keys(alias)) sandbox['__lx_native_call__' + n] = a => alias[n](a);

vm.runInContext(fs.readFileSync(ROOT + '/plugin/js/lx-shim.js', 'utf8'), sandbox);
sandbox.__lx_set_script_meta({ name: '六音音源', description: 'v1.2.1 如失效请前往 www.sixyin.com 下载最新版本', version: 'v1.2.1', author: '六音', homepage: 'www.sixyin.com' });
vm.runInContext(fs.readFileSync(ROOT + '/plugin/scripts/sixyin-source.js', 'utf8'), sandbox);

setTimeout(async () => {
  globalThis.__REAL_NET = process.env.REAL_NET === '1';
  if (globalThis.__REAL_NET) console.log('=== REAL NET ===');
  console.log('=== kw ===');
  reqs.length = 0;
  try {
    const u = await sandbox.lx._dispatchRequest({ source: 'kw', action: 'musicUrl', info: { type: '128k', musicInfo: { songmid: '5886682' } } });
    console.log('kw result:', String(u).slice(0, 100));
  } catch (e) { console.log('kw ERR:', e.message); }
  console.log('kw requests:', reqs.map(r => r.slice(0, 90)));

  console.log('=== mg ===');
  reqs.length = 0;
  try {
    const u = await sandbox.lx._dispatchRequest({ source: 'mg', action: 'musicUrl', info: { type: '128k', musicInfo: { copyrightId: '1135162566', platform: 'mg', version: 'v1.2.1' } } });
    console.log('mg result:', String(u).slice(0, 100));
  } catch (e) { console.log('mg ERR:', e.message); }
  console.log('mg requests:', reqs.map(r => r.slice(0, 90)));

  console.log('=== kg ===');
  reqs.length = 0;
  try {
    const u = await sandbox.lx._dispatchRequest({ source: 'kg', action: 'musicUrl', info: { type: '128k', musicInfo: { hash: '7490C4D08ABF41E6829013609F4C804D', songmid: '7169390', albumId: '36462622', platform: 'kg' } } });
    console.log('kg result:', String(u).slice(0, 100));
  } catch (e) { console.log('kg ERR:', e.message); }
  console.log('kg requests:', reqs.map(r => r.slice(0, 90)));

  console.log('=== tx ===');
  reqs.length = 0;
  try {
    const u = await sandbox.lx._dispatchRequest({ source: 'tx', action: 'musicUrl', info: { type: '128k', musicInfo: { songmid: '001yS0N33yPm1B', platform: 'tx' } } });
    console.log('tx result:', String(u).slice(0, 100));
  } catch (e) { console.log('tx ERR:', e.message); }
  console.log('tx requests:', reqs.map(r => r.slice(0, 90)));
  process.exit(0);
}, 1500);
