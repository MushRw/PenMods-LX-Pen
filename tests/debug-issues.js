'use strict';
/* 临时调试：tx 搜索 / kw 歌词 / kw·mg 榜单列表 / kg·mg·kw 歌单列表 / mg 歌词 / wy 榜单列表 */
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
globalThis['__lx_native_call__iconv_convert'] = (b) => new TextDecoder('gb18030').decode(NodeBuffer.from(b));

enc.request = (url, options, callback) => {
  const reqId = ++seq;
  const promise = new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = nodeSetTimeout(() => ctrl.abort(), 30000);
    (async () => {
      try {
        const headers = {};
        for (const k of Object.keys(options.headers || {})) headers[k] = options.headers[k];
        let body;
        if (options.body !== undefined && options.body !== null) body = String(options.body);
        else if (options.form) {
          const parts = [];
          for (const k of Object.keys(options.form)) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(options.form[k])));
          body = parts.join('&');
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        const resp = await fetch(url, { method: options.method || (body !== undefined ? 'POST' : 'GET'), headers, body, signal: ctrl.signal, redirect: 'follow' });
        const buf = new Uint8Array(await resp.arrayBuffer());
        const respBody = options.binary ? enc.bytesToB64(buf) : new TextDecoder('utf-8').decode(buf);
        if (url.indexOf('newlyric.kuwo.cn') >= 0) origConsole.log('kw lyric resp:', resp.status, 'len', buf.length, 'head', JSON.stringify(NodeBuffer.from(buf).subarray(0, 30).toString('latin1')));
        resolve({ status: resp.status, headers: {}, body: respBody });
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
const show = (label, v) => origConsole.log(label, '=>', JSON.stringify(v).slice(0, 300));
const showErr = (label, e) => origConsole.log(label, 'ERR =>', e.message);

async function main() {
  /* tx 搜索 */
  try { show('tx search', await sdk.tx.musicSearch.search('周杰伦', 1, 5)); } catch (e) { showErr('tx search', e); }
  /* kw 歌词 */
  const kwS = await sdk.kw.musicSearch.search('周杰伦', 1, 1);
  try { const r = await sdk.kw.getLyric(kwS.list[0]).promise; show('kw lyric', r.lyric && r.lyric.slice(0, 120)); } catch (e) { origConsole.log('kw lyric STACK:', e.stack.split('\n').slice(0, 6).join('\n')); }
  /* mg 歌词 */
  const mgS = await sdk.mg.musicSearch.search('周杰伦', 1, 1);
  try { const r = await sdk.mg.getLyric(mgS.list[0]).promise; show('mg lyric', r.lyric && r.lyric.slice(0, 120)); } catch (e) { origConsole.log('mg lyric STACK:', e.stack.split('\n').slice(0, 6).join('\n')); }
  /* kw 榜单列表 */
  try { show('kw leaderboard list', await sdk.kw.leaderboard.getList('534804', 1)); } catch (e) { origConsole.log('kw lb STACK:', e.stack.split('\n').slice(0, 5).join('\n')); }
  /* mg 榜单列表 */
  try { show('mg leaderboard list', await sdk.mg.leaderboard.getList('83048887', 1)); } catch (e) { showErr('mg leaderboard list', e); }
  /* kw 歌单列表 */
  try { show('kw songlist list', await sdk.kw.songList.getList(undefined, '211-43', 1)); } catch (e) { showErr('kw songlist list', e); }
  /* kg 歌单列表 */
  try { show('kg songlist list', await sdk.kg.songList.getList(undefined, '12', 1)); } catch (e) { origConsole.log('kg songlist STACK:', e.stack.split('\n').slice(0, 5).join('\n')); }
  /* mg 歌单列表 */
  try { show('mg songlist list', await sdk.mg.songList.getList(undefined, '1001076096', 1)); } catch (e) { showErr('mg songlist list', e); }
  /* wy 榜单列表 */
  try {
    const wres = await sdk.wy.leaderboard.getData('3778678');
    const wbody = wres && wres.body ? wres.body : wres;
    origConsole.log('wy tracks:', wbody && wbody.playlist && Array.isArray(wbody.playlist.tracks) ? wbody.playlist.tracks.length : 'n/a', 'first:', JSON.stringify(wbody && wbody.playlist && wbody.playlist.tracks && wbody.playlist.tracks[0]).slice(0, 200));
  } catch (e) { showErr('wy leaderboard list', e); }
  /* kw 歌词手动管道 */
  try {
    const kwFirst = kwS.list[0];
    const kwUrl = 'http://newlyric.kuwo.cn/newlyric.lrc?user=12345%2Cweb%2Cweb%2Cweb&requester=localhost&req=1&rid=MUSIC_' + kwFirst.songmid + '&lrcx=1';
    const r2 = await fetch(kwUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const raw = NodeBuffer.from(await r2.arrayBuffer());
    origConsole.log('kw raw head:', JSON.stringify(raw.subarray(0, 30).toString('latin1')), 'len', raw.length);
  } catch (e) { origConsole.log('kw probe ERR', e.message); }
  process.exit(0);
}
main().catch(e => { origConsole.error('FATAL', e.message); process.exit(1); });
