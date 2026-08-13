'use strict';
/*
 * LX Pen runner 级测试（Node 模拟 penmusic 原生层）：
 * 按 penmusic 加载顺序 eval lx-shim.js -> lx-sdk.js -> normalize.js -> runtime.js，
 * 通过 __lx_on_rpc 驱动 RPC，断言响应。
 *
 * Usage: node tests/runner-test.js
 */

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const NodeBuffer = Buffer;
/* lx-shim 会替换 console，测试输出固定用原始 console */
const origConsole = console;
const origExit = process.exit.bind(process);
/* lx-shim 会替换 globalThis.setTimeout，原生 mock 必须用原始版本 */
const nodeSetTimeout = setTimeout;
const nodeClearTimeout = clearTimeout;

/* ---------------- native mocks ---------------- */

const responses = [];
let timerSeq = 0;
const timers = new Map();

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
  aesEncrypt: (b, mode, key, iv) => {
    const alg = mode === 'ecb' ? 'aes-128-ecb' : 'aes-128-cbc';
    const c = nodeCrypto.createCipheriv(alg, NodeBuffer.from(key), mode === 'ecb' ? null : NodeBuffer.from(iv));
    return Uint8Array.from(NodeBuffer.concat([c.update(NodeBuffer.from(b)), c.final()]));
  },
  rsaEncrypt: () => { throw new Error('fake rsa'); },
  randomBytes: n => Uint8Array.from(nodeCrypto.randomBytes(n)),
};
enc.native = {
  zlib_inflate: b => Uint8Array.from(zlib.inflateSync(NodeBuffer.from(b))),
  zlib_deflate: b => Uint8Array.from(zlib.deflateSync(NodeBuffer.from(b))),
  iconv_convert: (b, from, to) => NodeBuffer.from(b).toString('utf8'),
};
globalThis.__lxinternal = enc;

/* penmusic register_natives 等价物 */
const nativeNames = [
  'set_timeout', 'clear_timeout', 'request_start', 'request_cancel',
  'md5', 'aes_encrypt', 'rsa_encrypt', 'random_bytes',
  'zlib_inflate', 'zlib_deflate',
  'iconv_convert',
  'str_to_bytes', 'bytes_to_str', 'str_to_b64', 'b64_to_str',
  'b64_to_bytes', 'bytes_to_b64',
  'send', 'log', 'file_write', 'file_exists', 'rpc_done',
];

globalThis.__lx_native_call__set_timeout = (id, ms) => {
  const t = nodeSetTimeout(() => globalThis.__lx_timer_fire(id), ms);
  timers.set(id, t);
};
globalThis.__lx_native_call__clear_timeout = id => {
  const t = timers.get(id);
  if (t) nodeClearTimeout(t);
  timers.delete(id);
};
globalThis.__lx_native_call__request_start = (id, url, optsJson) => {
  const opts = JSON.parse(optsJson);
  nodeSetTimeout(() => {
    let resp = null;
    if (url.indexOf('newlyric.kuwo.cn') >= 0) {
      const lrc = '[ti:测试]\n[00:01.00]第一行歌词\n[00:05.00]第二行歌词\n';
      const key = NodeBuffer.from('yeelion');
      const lrcBytes = NodeBuffer.from(lrc, 'utf8');
      const xored = NodeBuffer.alloc(lrcBytes.length);
      for (let i = 0; i < lrcBytes.length; i++) xored[i] = lrcBytes[i] ^ key[i % key.length];
      const payload = NodeBuffer.concat([
        NodeBuffer.from('tp=content\r\n\r\n'),
        zlib.deflateSync(NodeBuffer.from(xored.toString('base64'), 'ascii')),
      ]);
      resp = { status: 200, headers: {}, body: enc.bytesToB64(payload) };
    } else if (url.indexOf('c.y.qq.com/lyric') >= 0) {
      resp = {
        status: 200,
        headers: {},
        body: JSON.stringify({
          code: 0,
          lyric: NodeBuffer.from('QQ第一句\nQQ第二句', 'utf8').toString('base64'),
          trans: NodeBuffer.from('QQ翻译', 'utf8').toString('base64'),
        }),
      };
    } else if (url.indexOf('songsearch.kugou.com') >= 0) {
      resp = {
        status: 200,
        headers: {},
        body: JSON.stringify({
          error_code: 0,
          data: { total: 1, lists: [{ Audioid: 9, FileHash: 'H1', SongName: '歌', Singers: [{ name: '唱' }], AlbumID: 'A', AlbumName: '专', Duration: 180, FileSize: 100, HQFileSize: 200, SQFileSize: 300, ResFileSize: 0, Grp: [] }] },
        }),
      };
    } else if (url.indexOf('hotword.kuwo.cn') >= 0) {
      resp = { status: 200, headers: {}, body: JSON.stringify({ status: 'ok', tagvalue: [{ key: '热搜词1' }, { key: '热搜词2' }] }) };
    } else if (url.indexOf('example.com/a.mp3') >= 0) {
      resp = { status: 200, headers: {}, body: enc.bytesToB64(NodeBuffer.from('ID3FAKEMP3BYTES')) };
    } else {
      resp = {
        status: 200,
        headers: {},
        body: JSON.stringify({
          TOTAL: '1',
          SHOW: '1',
          abslist: [{ MUSICRID: 'MUSIC_123', SONGNAME: '测试&amp;歌', ARTIST: '歌手', ALBUMID: 'A1', ALBUM: '专辑', DURATION: '210', N_MINFO: 'level:standard,bitrate:128,format:mp3,size:3.3MB;level:high,bitrate:320,format:mp3,size:8.4MB' }],
        }),
      };
    }
    globalThis.__lx_request_done(String(id), null, JSON.stringify(resp));
  }, 0);
};
globalThis.__lx_native_call__request_cancel = () => {};
globalThis.__lx_native_call__md5 = b => enc.crypto.md5(b);
globalThis.__lx_native_call__aes_encrypt = (b, m, k, iv) => enc.crypto.aesEncrypt(b, m, k, iv);
globalThis.__lx_native_call__rsa_encrypt = () => { throw new Error('fake rsa'); };
globalThis.__lx_native_call__random_bytes = n => enc.crypto.randomBytes(n);
globalThis.__lx_native_call__zlib_inflate = b => enc.native.zlib_inflate(b);
globalThis.__lx_native_call__zlib_deflate = b => enc.native.zlib_deflate(b);
globalThis.__lx_native_call__iconv_convert = (b, from, to) => NodeBuffer.from(b).toString('utf8');
globalThis.__lx_native_call__str_to_bytes = enc.strToBytes;
globalThis.__lx_native_call__bytes_to_str = enc.bytesToStr;
globalThis.__lx_native_call__str_to_b64 = enc.strToB64;
globalThis.__lx_native_call__b64_to_str = enc.b64ToStr;
globalThis.__lx_native_call__b64_to_bytes = enc.b64ToBytes;
globalThis.__lx_native_call__bytes_to_b64 = enc.bytesToB64;
globalThis.__lx_native_call__send = (e, d) => { /* lx.send */ };
globalThis.__lx_native_call__log = (lv, s) => { if (process.env.LXPEN_DEBUG) console.log('[runner]', lv, s); };
globalThis.__lx_native_call__file_write = () => true;
globalThis.__lx_native_call__file_exists = () => true;
globalThis.__lx_native_call__rpc_done = (id, json) => responses.push({ id, json: JSON.parse(json) });

/* ---------------- load layers in penmusic order ---------------- */

for (const file of ['lx-shim.js', 'lx-sdk.js', 'normalize.js', 'runtime.js']) {
  const code = fs.readFileSync(path.join(ROOT, 'plugin', 'js', file), 'utf8');
  try {
    // eslint-disable-next-line no-eval
    (0, eval)('(function(){' + code + '\n})();');
  } catch (e) {
    origConsole.error('layer load failed: ' + file + ' -> ' + (e && e.stack));
    throw e;
  }
}

/* 模拟音源脚本注册 */
globalThis.lx.on(globalThis.lx.EVENT_NAMES.request, ({ source, action, info }) => {
  if (action === 'musicUrl') return Promise.resolve('https://example.com/a.mp3');
  return Promise.reject(new Error('unsupported action'));
});

/* ---------------- helpers ---------------- */

let failed = 0;
const check = (name, cond) => {
  if (cond) origConsole.log('  ok  ' + name);
  else { origConsole.error('  FAIL ' + name); failed++; }
};

function rpc(cmdObj, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const id = String(++timerSeq);
    cmdObj.id = id;
    const timer = nodeSetTimeout(() => reject(new Error('rpc timeout: ' + cmdObj.cmd)), timeoutMs);
    const prevLen = responses.length;
    globalThis.__lx_on_rpc(JSON.stringify(cmdObj));
    const poll = () => {
      for (let i = prevLen; i < responses.length; i++) {
        if (responses[i].id === id) {
          clearTimeout(timer);
          resolve(responses[i].json);
          return;
        }
      }
      nodeSetTimeout(poll, 5);
    };
    poll();
  });
}

/* ---------------- tests ---------------- */

async function main() {
  const ping = await rpc({ cmd: 'ping' });
  check('ping', ping.ok === true && ping.data === 'pong');

  const kw = await rpc({ cmd: 'search', platform: 'kw', keyword: '测试', page: 1 });
  check('search kw ok', kw.ok === true);
  check('search kw list', kw.ok && kw.data.list.length === 1);
  check('search kw normalized', kw.ok && kw.data.list[0].songmid === '123' && kw.data.list[0].name === '测试&歌');

  const kg = await rpc({ cmd: 'search', platform: 'kg', keyword: '歌', page: 1 });
  check('search kg ok', kg.ok === true);
  check('search kg hash', kg.ok && kg.data.list[0].hash === 'H1');

  const kwLyric = await rpc({ cmd: 'lyric', source: 'kw', info: { songmid: '123' } });
  check('lyric kw ok', kwLyric.ok === true);
  check('lyric kw text', kwLyric.ok && kwLyric.data.lyric.indexOf('第一行歌词') >= 0);

  const txLyric = await rpc({ cmd: 'lyric', source: 'tx', info: { songmid: 'SM001' } });
  check('lyric tx ok', txLyric.ok === true);
  check('lyric tx text', txLyric.ok && txLyric.data.lyric.indexOf('QQ第一句') >= 0);
  check('lyric tx trans', txLyric.ok && txLyric.data.tlyric.indexOf('QQ翻译') >= 0);

  const hot = await rpc({ cmd: 'hotsearch', platform: 'kw' });
  check('hotsearch kw ok', hot.ok === true);
  check('hotsearch kw list', hot.ok && hot.data.list.length === 2 && hot.data.list[0] === '热搜词1');

  const script = await rpc({ cmd: 'script', source: 'kw', action: 'musicUrl', info: { type: '128k', musicInfo: { songmid: '123' } } });
  check('script musicUrl', script.ok === true && script.data === 'https://example.com/a.mp3');

  const dl = await rpc({ cmd: 'download', url: 'https://example.com/a.mp3', path: '/tmp/lxpen_x.mp3' });
  check('download ok', dl.ok === true && dl.data.path === '/tmp/lxpen_x.mp3' && dl.data.size === 15);

  const lyricPath = await rpc({ cmd: 'lyric', source: 'kw', info: { songmid: '123' } });
  check('lyric path', lyricPath.ok === true && lyricPath.data.path === '/tmp/lxpen_123.lrc');

  const bad = await rpc({ cmd: 'search', platform: 'xx', keyword: 'x' });
  check('unknown platform error', bad.ok === false);

  origConsole.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  origConsole.error('runner test error:', e && e.stack ? e.stack : e);
  origExit(1);
});
