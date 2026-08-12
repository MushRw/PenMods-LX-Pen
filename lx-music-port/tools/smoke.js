'use strict';
/*
 * Smoke test for dist/lx-sdk.js.
 * Simulates the pen's __lxinternal native layer in Node and verifies:
 *   - all 5 sources are registered with their method surface
 *   - crypto shim (md5 / sha1 / aes-128-ecb / aes-128-cbc / rsa no-padding)
 *   - Buffer utf16le roundtrip
 *   - httpFetch response mapping
 *   - kw.musicSearch.search end-to-end with a canned response
 *
 * Usage: node tools/smoke.js
 */

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const zlib = require('zlib');

/* capture Node's real Buffer BEFORE the bundle overrides globalThis.Buffer */
const NodeBuffer = Buffer;

/* ---------------- fake __lxinternal (mirrors lx-shim.js) ---------------- */

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
  crypto: {
    md5: b => nodeCrypto.createHash('md5').update(NodeBuffer.from(b)).digest('hex'),
    aesEncrypt: (b, mode, key, iv) => {
      const alg = mode === 'ecb' ? 'aes-128-ecb' : 'aes-128-cbc';
      const c = nodeCrypto.createCipheriv(alg, NodeBuffer.from(key), mode === 'ecb' ? null : NodeBuffer.from(iv));
      return Uint8Array.from(NodeBuffer.concat([c.update(NodeBuffer.from(b)), c.final()]));
    },
    rsaEncrypt: () => { throw new Error('fake rsa not implemented'); },
    randomBytes: n => Uint8Array.from(nodeCrypto.randomBytes(n)),
  },
  native: {
    zlib_inflate: b => Uint8Array.from(zlib.inflateSync(NodeBuffer.from(b))),
    zlib_deflate: b => Uint8Array.from(zlib.deflateSync(NodeBuffer.from(b))),
    /* 真机上是 glibc iconv；测试里字节已是 UTF-8，直接按 utf8 读出 */
    iconv_convert: (b, from, to) => NodeBuffer.from(b).toString('utf8'),
  },
  request: (url, opts, cb) => {
    let body;
    if (url.indexOf('newlyric.kuwo.cn') >= 0) {
      /* 酷我歌词（lrcx=1）：zlib( base64( xor(utf8歌词, 'yeelion') ) ) */
      const lrc = '[ti:测试]\n[00:01.00]第一行歌词\n[00:05.00]第二行歌词\n';
      const key = NodeBuffer.from('yeelion');
      const lrcBytes = NodeBuffer.from(lrc, 'utf8');
      const xored = NodeBuffer.alloc(lrcBytes.length);
      for (let i = 0; i < lrcBytes.length; i++) xored[i] = lrcBytes[i] ^ key[i % key.length];
      const payload = NodeBuffer.concat([
        NodeBuffer.from('tp=content\r\n\r\n'),
        zlib.deflateSync(NodeBuffer.from(xored.toString('base64'), 'ascii')),
      ]);
      cb(null, { status: 200, headers: {}, body: Uint8Array.from(payload) });
      return () => {};
    }
    if (url.indexOf('c.y.qq.com/lyric') >= 0) {
      body = JSON.stringify({
        code: 0,
        lyric: NodeBuffer.from('测试歌词第一句\n测试歌词第二句', 'utf8').toString('base64'),
        trans: NodeBuffer.from('翻译第一句', 'utf8').toString('base64'),
      });
    } else if (url.indexOf('songsearch.kugou.com') >= 0) {
      body = JSON.stringify({
        error_code: 0,
        data: {
          total: 1,
          lists: [{
            Audioid: 9,
            FileHash: 'H1',
            SongName: '歌',
            Singers: [{ name: '唱' }],
            AlbumID: 'A',
            AlbumName: '专',
            Duration: 180,
            FileSize: 100,
            HQFileSize: 200,
            SQFileSize: 300,
            ResFileSize: 0,
            Grp: [],
          }],
        },
      });
    } else {
      body = JSON.stringify({
        TOTAL: '1',
        SHOW: '1',
        abslist: [{
          MUSICRID: 'MUSIC_123',
          SONGNAME: '测试&amp;歌',
          ARTIST: '歌手',
          ALBUMID: 'A1',
          ALBUM: '专辑',
          DURATION: '210',
          N_MINFO: 'level:standard,bitrate:128,format:mp3,size:3.3MB;level:high,bitrate:320,format:mp3,size:8.4MB',
        }],
      });
    }
    setTimeout(() => {
      cb(null, { status: 200, headers: { 'content-type': 'application/json' }, body });
    }, 0);
    return () => {};
  },
};

globalThis.__lxinternal = enc;
/* port/iconv.js 直接读 register_natives 注册的全局函数 */
globalThis['__lx_native_call__iconv_convert'] = (b, from, to) => NodeBuffer.from(b).toString('utf8');

/* ---------------- load bundle ---------------- */

const code = fs.readFileSync(path.join(__dirname, '..', 'dist', 'lx-sdk.js'), 'utf8');
// eslint-disable-next-line no-eval
(0, eval)(code);

const sdk = globalThis.__lxSdk;
let failed = 0;
const check = (name, cond) => {
  if (cond) console.log('  ok  ' + name);
  else { console.error('  FAIL ' + name); failed++; }
};

/* ---------------- source surface ---------------- */

console.log('sources:', Object.keys(sdk).filter(k => typeof sdk[k] === 'object').join(', '));
for (const src of ['kw', 'kg', 'mg', 'wy', 'tx']) {
  const s = sdk[src];
  check(src + ' registered', !!s);
  if (!s) continue;
  const methods = ['musicSearch', 'getLyric', 'getPic', 'leaderboard', 'songList', 'comment', 'hotSearch'];
  if (src === 'kw') methods.push('tipSearch');
  for (const method of methods) {
    check(`${src}.${method}`, typeof s[method] === 'object' || typeof s[method] === 'function');
  }
}

/* ---------------- crypto shim ---------------- */

const C = sdk.internal.crypto;

check('md5', C.createHash('md5').update('abc').digest('hex') === '900150983cd24fb0d6963f7d28e17f72');
check('sha1', C.createHash('sha1').update('abc').digest('hex') === 'a9993e364706816aba3e25717850c26c9cd0d89d');

const key = '0123456789abcdef';
const iv = '0001020304050607';
{
  const cipher = C.createCipheriv('aes-128-ecb', key, '');
  const ct = NodeBuffer.concat([cipher.update(NodeBuffer.from('hello world', 'utf8')), cipher.final()]);
  const decipher = C.createDecipheriv('aes-128-ecb', key, '');
  const pt = NodeBuffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  check('aes-128-ecb roundtrip', pt === 'hello world');
}
{
  const cipher = C.createCipheriv('aes-128-cbc', key, iv);
  const ct = NodeBuffer.concat([cipher.update(NodeBuffer.from('hello world', 'utf8')), cipher.final()]);
  const decipher = C.createDecipheriv('aes-128-cbc', key, iv);
  const pt = NodeBuffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  check('aes-128-cbc roundtrip', pt === 'hello world');
}
{
  /* wy public key, RSA_NO_PADDING -> 128-byte output, no throw */
  const pub = '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----';
  const input = NodeBuffer.alloc(128);
  input[127] = 0x42;
  let out = null;
  try {
    out = C.publicEncrypt({ key: pub, padding: C.constants.RSA_NO_PADDING }, input);
  } catch (e) {
    console.error('  rsa error:', e.message);
  }
  check('rsa no-padding 128 bytes', out instanceof Uint8Array && out.length === 128);
}

/* ---------------- Buffer utf16le ---------------- */

check('buffer utf16le roundtrip', globalThis.Buffer.from('中文abc', 'utf16le').toString('utf16le') === '中文abc');
check('buffer hex roundtrip', globalThis.Buffer.from('00ff10', 'hex').toString('hex') === '00ff10');

/* ---------------- httpFetch mapping ---------------- */

sdk.internal.http.httpFetch('http://example.com/x', { method: 'get' }).promise.then(resp => {
  check('httpFetch statusCode', resp.statusCode === 200);
  check('httpFetch body parsed', typeof resp.body === 'object' && resp.body.TOTAL === '1');
}).catch(e => {
  console.error('  httpFetch failed:', e.message);
  failed++;
});

/* ---------------- kw search end-to-end ---------------- */

sdk.kw.musicSearch.search('测试', 1).then(res => {
  check('kw search list length', res.list.length === 1);
  if (res.list.length) {
    check('kw search songmid', res.list[0].songmid === '123');
    check('kw search name decoded', res.list[0].name === '测试&歌');
    check('kw search interval', res.list[0].interval === '03:30');
    check('kw search types', JSON.stringify(res.list[0].types.map(t => t.type)) === JSON.stringify(['320k', '128k']));
  }
}).catch(e => {
  console.error('  kw search failed:', e.message);
  failed++;
}).finally(() => {
  setTimeout(() => {
    console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  }, 50);
});

/* ---------------- kw lyric (xor + inflate + iconv) ---------------- */

sdk.kw.getLyric({ songmid: '123' }).promise.then(info => {
  check('kw lyric has line1', typeof info.lyric === 'string' && info.lyric.indexOf('第一行歌词') >= 0);
  check('kw lyric has line2', typeof info.lyric === 'string' && info.lyric.indexOf('第二行歌词') >= 0);
}).catch(e => {
  console.error('  kw lyric failed:', e.message);
  failed++;
});

/* ---------------- tx lyric (mobile base64 LRC) ---------------- */

sdk.tx.getLyric({ songmid: 'SM001' }).promise.then(info => {
  check('tx lyric', typeof info.lyric === 'string' && info.lyric.indexOf('测试歌词第一句') >= 0);
  check('tx tlyric', typeof info.tlyric === 'string' && info.tlyric.indexOf('翻译第一句') >= 0);
}).catch(e => {
  console.error('  tx lyric failed:', e.message);
  failed++;
});

/* ---------------- kg search end-to-end ---------------- */

sdk.kg.musicSearch.search('歌', 1).then(res => {
  check('kg search list length', res.list.length === 1);
  if (res.list.length) {
    check('kg search songmid', res.list[0].songmid === 9);
    check('kg search singer', res.list[0].singer === '唱');
    check('kg search hash', res.list[0].hash === 'H1');
  }
}).catch(e => {
  console.error('  kg search failed:', e.message);
  failed++;
});
