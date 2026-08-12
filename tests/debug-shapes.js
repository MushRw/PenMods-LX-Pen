'use strict';
/* 临时调试：打印各源 leaderboard/songlist 真实返回结构 */
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
  rpc_done: () => {},
};
globalThis.__lxinternal = enc;
globalThis['__lx_native_call__iconv_convert'] = (b) => NodeBuffer.from(b).toString('utf8');

enc.request = (url, options, callback) => {
  const reqId = ++seq;
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
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { /* keep raw */ }
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

const sdk = globalThis.__lxSdk;
const show = (label, v) => origConsole.log(label, '=>', JSON.stringify(v).slice(0, 500));
const showErr = (label, e) => origConsole.log(label, 'ERR =>', e.message);

(async () => {
  for (const src of ['kw', 'kg', 'mg', 'tx']) {
    try { show(src + ' leaderboard.boards', await sdk[src].leaderboard.getBoardsData()); } catch (e) { showErr(src + ' leaderboard.boards', e); }
    try { show(src + ' songlist.tags', await sdk[src].songList.getTags()); } catch (e) { showErr(src + ' songlist.tags', e); }
  }
  /* kw lyric 与 mg lyric 的报错排查 */
  const kwSearch = await sdk.kw.musicSearch.search('周杰伦', 1, 1);
  const kwFirst = kwSearch.list[0];
  origConsole.log('kw first:', JSON.stringify(kwFirst).slice(0, 200));
  try { const lr = await sdk.kw.getLyric(kwFirst); origConsole.log('kw lyric OK:', JSON.stringify(lr).slice(0, 200)); } catch (e) { showErr('kw getLyric', e); }
  const mgSearch = await sdk.mg.musicSearch.search('周杰伦', 1, 1);
  const mgFirst = mgSearch.list[0];
  origConsole.log('mg first:', JSON.stringify(mgFirst).slice(0, 200));
  try { const lr = await sdk.mg.getLyric(mgFirst); origConsole.log('mg lyric OK:', JSON.stringify(lr).slice(0, 200)); } catch (e) { showErr('mg getLyric', e); }
  process.exit(0);
})();
