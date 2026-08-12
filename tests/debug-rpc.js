'use strict';
/* 临时调试：走 runtime RPC 路径排查 kw/kg/mg/wy 剩余失败 */
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
const responses = [];

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
  rpc_done: (id, json) => {
    const j = JSON.parse(json);
    if (j.data && Array.isArray(j.data.list)) origConsole.log('  [rpc_done]', id, 'list len=', j.data.list.length, 'source=', j.data.source);
    responses.push({ id, json: j });
  },
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
        const rb = options.binary ? enc.bytesToB64(buf) : new TextDecoder('utf-8').decode(buf);
        resolve({ status: resp.status, headers: {}, body: rb });
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

function rpc(o) {
  return new Promise(res => {
    const id = String(++seq);
    o.id = id;
    const L = responses.length;
    globalThis.__lx_on_rpc(JSON.stringify(o));
    const poll = () => {
      for (let i = L; i < responses.length; i++) {
        if (responses[i].id === id) return res(responses[i].json);
      }
      nodeSetTimeout(poll, 5);
    };
    poll();
  });
}

async function main() {
  /* kw 歌词：给 hook 加日志 */
  const origHook = globalThis.__penHooks['kw_decode_lyric'];
  globalThis.__penHooks['kw_decode_lyric'] = async (data) => {
    origConsole.log('  [kw hook] lrcBase64 len=', String(data.lrcBase64).length, 'head=', JSON.stringify(String(data.lrcBase64).slice(0, 24)));
    const rawIn = NodeBuffer.from(data.lrcBase64, 'base64');
    origConsole.log('  [kw hook] in len=', rawIn.length, 'head=', JSON.stringify(rawIn.subarray(0, 14).toString('latin1')));
    const b64 = await origHook(data);
    const text = NodeBuffer.from(b64, 'base64').toString('utf8');
    origConsole.log('  [kw hook] decoded head:', JSON.stringify(text.slice(0, 100)));
    return b64;
  };
  const kwS = await rpc({ cmd: 'search', platform: 'kw', keyword: '周杰伦', page: 1 });
  for (let i = 0; i < Math.min(kwS.data.list.length, 3); i++) {
    const lr = await rpc({ cmd: 'lyric', source: 'kw', info: kwS.data.list[i] });
    origConsole.log('kw lyric[' + i + ']', lr.ok, lr.ok ? JSON.stringify(lr.data.lyric).slice(0, 80) : lr.error);
  }
  const kwTags = await rpc({ cmd: 'songlist', platform: 'kw', action: 'tags' });
  for (let i = 0; i < Math.min(kwTags.data.list.length, 3); i++) {
    const t = kwTags.data.list[i];
    const sl = await rpc({ cmd: 'songlist', platform: 'kw', action: 'list', id: t.id, page: 1 });
    origConsole.log('kw songlist[' + i + '] id=' + t.id, sl.ok ? 'ok len=' + sl.data.list.length : sl.error);
  }
  const kgB = await rpc({ cmd: 'leaderboard', platform: 'kg', action: 'boards' });
  for (let i = 0; i < Math.min(kgB.data.list.length, 3); i++) {
    const b = kgB.data.list[i];
    const bl = await rpc({ cmd: 'leaderboard', platform: 'kg', action: 'list', id: b.id, page: 1 });
    origConsole.log('kg lb[' + i + '] id=' + b.id, bl.ok ? 'ok len=' + bl.data.list.length : bl.error);
  }
  const mgS = await rpc({ cmd: 'search', platform: 'mg', keyword: '周杰伦', page: 1 });
  for (let i = 0; i < Math.min(mgS.data.list.length, 3); i++) {
    const lr = await rpc({ cmd: 'lyric', source: 'mg', info: mgS.data.list[i] });
    origConsole.log('mg lyric[' + i + '] lrcUrl=' + (mgS.data.list[i].lrcUrl || 'none'), lr.ok ? 'ok' : lr.error);
  }
  const mgB = await rpc({ cmd: 'leaderboard', platform: 'mg', action: 'boards' });
  for (let i = 0; i < Math.min(mgB.data.list.length, 4); i++) {
    const b = mgB.data.list[i];
    const bl = await rpc({ cmd: 'leaderboard', platform: 'mg', action: 'list', id: b.id, page: 1 });
    origConsole.log('mg lb[' + i + '] id=' + b.id + ' name=' + b.name, bl.ok ? 'ok len=' + bl.data.list.length : bl.error);
  }
  const mgT = await rpc({ cmd: 'songlist', platform: 'mg', action: 'tags' });
  for (let i = 0; i < Math.min(mgT.data.list.length, 3); i++) {
    const t = mgT.data.list[i];
    const sl = await rpc({ cmd: 'songlist', platform: 'mg', action: 'list', id: t.id, page: 1 });
    origConsole.log('mg songlist[' + i + '] id=' + t.id, sl.ok ? 'ok len=' + sl.data.list.length : sl.error);
  }
  const wyB = await rpc({ cmd: 'leaderboard', platform: 'wy', action: 'boards' });
  for (let i = 0; i < Math.min(wyB.data.list.length, 3); i++) {
    const b = wyB.data.list[i];
    const bl = await rpc({ cmd: 'leaderboard', platform: 'wy', action: 'list', id: b.id, page: 1 });
    origConsole.log('wy lb[' + i + '] id=' + b.id, bl.ok ? 'ok len=' + bl.data.list.length : bl.error);
  }
  /* 直接看 kg/mg 榜单原始返回 */
  try {
    const kgRaw = await globalThis.__lxSdk.kg.leaderboard.getList('8888', 1);
    origConsole.log('kg getList direct:', JSON.stringify(kgRaw).slice(0, 200));
    origConsole.log('kg asList direct len:', globalThis.__asList(kgRaw).length);
    const kgRpc = await rpc({ cmd: 'leaderboard', platform: 'kg', action: 'list', id: 'kg__8888', page: 1 });
    origConsole.log('kg lb rpc again:', kgRpc.ok ? 'ok len=' + kgRpc.data.list.length : kgRpc.error);
  } catch (e) { origConsole.log('kg getList direct ERR', e.message); }
  try {
    const mgRaw = await globalThis.__lxSdk.mg.leaderboard.getList('83048887', 1);
    origConsole.log('mg getList direct:', JSON.stringify(mgRaw).slice(0, 200));
  } catch (e) { origConsole.log('mg getList direct ERR', e.message); }
  /* mg 歌单 runtime 固定 id */
  {
    const sl = await rpc({ cmd: 'songlist', platform: 'mg', action: 'list', id: '1001076096', page: 1 });
    origConsole.log('mg songlist fixed id:', sl.ok ? 'ok len=' + sl.data.list.length : sl.error);
    const direct = await globalThis.__lxSdk.mg.songList.getList.call(globalThis.__lxSdk.mg.songList, undefined, '1001076096', 1);
    origConsole.log('mg songlist direct len:', globalThis.__asList(direct).length, 'keys:', direct && Object.keys(direct).join(','));
  }
  /* wy 榜单 getData 原始 */
  try {
    const w = await globalThis.__lxSdk.wy.leaderboard.getData('19723756');
    const wb = w && w.body ? w.body : w;
    origConsole.log('wy getData 19723756: playlist=', !!wb.playlist, 'tracks=', wb.playlist && Array.isArray(wb.playlist.tracks) ? wb.playlist.tracks.length : 'n/a');
  } catch (e) { origConsole.log('wy getData ERR', e.message); }
  process.exit(0);
}
main().catch(e => { origConsole.error('FATAL', e.message); process.exit(1); });
