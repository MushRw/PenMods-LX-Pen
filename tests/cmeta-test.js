'use strict';
/* 模拟 C 层 set_script_meta_from_head：不改 env，用 C 层解析的元数据加载 sixyin */
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');
const ROOT = 'E:/code/youdao/lx-pen';

/* 模拟 C 层解析：从脚本头提取 @name/@description/@version */
function parseMetaFromHead(file) {
  const buf = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const key of ['name', 'description', 'version', 'author', 'homepage']) {
    const re = new RegExp('@' + key + '\\s+([^\\n\\r*]+)');
    const m = buf.match(re);
    if (m) out[key] = m[1].trim().replace(/\s+\*\/?$/, '').trim();
  }
  return out;
}

const sandbox = {
  console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, group: () => {}, groupEnd: () => {}, groupCollapsed: () => {} },
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
    let resp;
    if (url.indexOf('hibai.cn') >= 0) resp = { status: 200, headers: {}, body: JSON.stringify({ success: true, qualityList: ['128k', '320k', 'flac'], platformList: ['tx', 'kw', 'kg', 'mg'] }) };
    else resp = { status: 200, headers: {}, body: 'url=https://example.com/mock.mp3' };
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
sandbox.__lx_native_call__send = (ev, data) => { console.log('EVENT', ev); };
sandbox.__lx_native_call__log = () => {};
sandbox.__lx_native_call__file_write = () => true;
sandbox.__lx_native_call__file_exists = () => true;
sandbox.__lx_native_call__rpc_done = () => {};
const alias = { str_to_bytes: enc.strToBytes, bytes_to_str: enc.bytesToStr, str_to_b64: enc.strToB64, b64_to_str: enc.b64ToStr, b64_to_bytes: enc.b64ToBytes, bytes_to_b64: enc.bytesToB64 };
for (const n of Object.keys(alias)) sandbox['__lx_native_call__' + n] = a => alias[n](a);

try {
  vm.runInContext(fs.readFileSync(ROOT + '/plugin/js/lx-shim.js', 'utf8'), sandbox);
  const meta = parseMetaFromHead(ROOT + '/plugin/scripts/sixyin-source.js');
  console.log('parsed meta:', JSON.stringify(meta));
  sandbox.__lx_set_script_meta(meta);
  console.log('env =', sandbox.lx.env);
  vm.runInContext(fs.readFileSync(ROOT + '/plugin/scripts/sixyin-source.js', 'utf8'), sandbox);
  console.log('sixyin loaded OK (sync)');
  setTimeout(() => { console.log('done, no crash'); process.exit(0); }, 1500);
} catch (e) {
  console.log('LOAD ERROR:', e.message);
  process.exit(1);
}
