'use strict';
/* 临时调试：真实请求 kw 搜索，打印每一步 */
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const zlib = require('zlib');
const ROOT = path.resolve(__dirname, '..');
const NodeBuffer = Buffer;
const origConsole = console;
const nodeSetTimeout = setTimeout;
const nodeClearTimeout = clearTimeout;
let seq = 0;

const enc = {
  strToBytes: s => Uint8Array.from(NodeBuffer.from(String(s), 'utf8')),
  bytesToStr: b => NodeBuffer.from(b).toString('utf8'),
  strToB64: s => NodeBuffer.from(String(s), 'utf8').toString('base64'),
  b64ToStr: s => NodeBuffer.from(String(s), 'base64').toString('utf8'),
  b64ToBytes: s => Uint8Array.from(NodeBuffer.from(String(s), 'base64')),
  bytesToB64: b => NodeBuffer.from(b).toString('base64'),
  bytesToHex: b => NodeBuffer.from(b).toString('hex'),
  hexToBytes: s => Uint8Array.from(NodeBuffer.from(String(s), 'hex')),
  bytesArg: v => (v instanceof Uint8Array ? v : enc.strToBytes(v)),
};
enc.crypto = {
  md5: b => nodeCrypto.createHash('md5').update(NodeBuffer.from(b)).digest('hex'),
  aesEncrypt: (b, m, k, iv) => {
    const a = m === 'ecb' ? 'aes-128-ecb' : 'aes-128-cbc';
    const c = nodeCrypto.createCipheriv(a, NodeBuffer.from(k), m === 'ecb' ? null : NodeBuffer.from(iv));
    return Uint8Array.from(NodeBuffer.concat([c.update(NodeBuffer.from(b)), c.final()]));
  },
  rsaEncrypt: () => { throw new Error('rsa'); },
  randomBytes: n => Uint8Array.from(nodeCrypto.randomBytes(n)),
};
enc.native = {
  zlib_inflate: b => Uint8Array.from(zlib.inflateSync(NodeBuffer.from(b))),
  zlib_deflate: b => Uint8Array.from(zlib.deflateSync(NodeBuffer.from(b))),
  send: () => {}, log: () => {}, file_write: () => true, file_exists: () => true,
  rpc_done: (id, json) => origConsole.log('RPC_DONE', id, json.slice(0, 100)),
};
globalThis.__lxinternal = enc;
globalThis['__lx_native_call__iconv_convert'] = (b) => NodeBuffer.from(b).toString('utf8');

enc.request = (url, options, callback) => {
  options = options || {};
  const reqId = ++seq;
  origConsole.log('REQ', reqId, url.slice(0, 100));
  const promise = new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = nodeSetTimeout(() => ctrl.abort(), 30000);
    (async () => {
      try {
        const headers = {};
        for (const k of Object.keys(options.headers || {})) headers[k] = options.headers[k];
        const resp = await fetch(url, { method: options.method || 'GET', headers, signal: ctrl.signal, redirect: 'follow' });
        const buf = new Uint8Array(await resp.arrayBuffer());
        const body = options.binary ? enc.bytesToB64(buf) : new TextDecoder('utf-8').decode(buf);
        origConsole.log('RESP', reqId, resp.status, 'len', body.length, JSON.stringify(String(body).slice(0, 200)));
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { origConsole.log('  json parse fail'); }
        if (parsed) origConsole.log('  TOTAL=', parsed.TOTAL, 'SHOW=', parsed.SHOW, 'abslist=', parsed.abslist ? parsed.abslist.length : 'n/a');
        resolve({ status: resp.status, headers: {}, body: parsed !== null ? parsed : body });
      } catch (e) {
        reject(new Error(e.name === 'AbortError' ? 'timeout' : e.message));
      } finally {
        nodeClearTimeout(timer);
      }
    })();
  });
  if (typeof callback === 'function') {
    promise.then(r => callback(null, r), e => callback(e));
    return () => {};
  }
  return promise;
};

for (const f of ['lx-sdk.js', 'normalize.js', 'runtime.js']) {
  // eslint-disable-next-line no-eval
  (0, eval)('(function(){' + fs.readFileSync(path.join(ROOT, 'plugin', 'js', f), 'utf8') + '\n})();');
}

origConsole.log('layers loaded; sdk kw search...');
globalThis.__lxSdk.kw.musicSearch.search('周杰伦', 1, 5)
  .then(r => {
    origConsole.log('SEARCH RESOLVED list=', Array.isArray(r.list) ? r.list.length : 'n/a');
    origConsole.log('first=', JSON.stringify(r.list && r.list[0]).slice(0, 200));
  }, e => origConsole.log('SEARCH ERR', e.message))
  .finally(() => nodeSetTimeout(() => process.exit(0), 500));
