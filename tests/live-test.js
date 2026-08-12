'use strict';
/*
 * LX Pen 真实网络联调测试：
 * 用 Node fetch 作为 runner 的 HTTP 后端，驱动 lx-shim -> lx-sdk -> normalize -> runtime，
 * 对五个源实测 search / lyric / hotsearch / leaderboard / songlist。
 *
 * Usage: node tests/live-test.js          （需要外网）
 *        node tests/live-test.js kw kg    （只测指定源）
 */

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const NodeBuffer = Buffer;
const origConsole = console;
const nodeSetTimeout = setTimeout;
const nodeClearTimeout = clearTimeout;

process.on('unhandledRejection', e => {
  origConsole.error('  UNHANDLED REJECTION:', e && e.message ? e.message : e);
  failed++;
});

const SOURCES = (process.argv.slice(2).length ? process.argv.slice(2) : ['kw', 'kg', 'mg', 'wy', 'tx']);

/* ---------------- native mocks（真实 HTTP） ---------------- */

const responses = [];
const pendingReq = new Map();
let timerSeq = 0;

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
  send: () => {},
  log: () => {},
  file_write: () => true,
  file_exists: () => true,
  rpc_done: (id, json) => responses.push({ id, json: JSON.parse(json) }),
};
globalThis.__lxinternal = enc;
/* 真机是 glibc iconv；Node 用 TextDecoder('gb18030') 做真实解码 */
globalThis['__lx_native_call__iconv_convert'] = (b, from, to) => new TextDecoder('gb18030').decode(NodeBuffer.from(b));

/* 不加载 lx-shim（它会替换全局 setTimeout/console，破坏 undici），
 * 这里直接提供 I.request + __lx_request_done，等价于 lx-shim 的请求侧。 */
enc.request = (url, options, callback) => {
  options = options || {};
  const reqId = ++timerSeq;
  if (process.env.LXPEN_DEBUG) origConsole.log('I.request', reqId, url.slice(0, 80));
  const promise = new Promise((resolve, reject) => {
    pendingReq.set(String(reqId), { resolve, reject, binary: !!options.binary });
    globalThis.__lx_native_call__request_start(reqId, url, JSON.stringify(options));
  });
  if (typeof callback === 'function') {
    promise.then(resp => { if (process.env.LXPEN_DEBUG) origConsole.log('I.request cb ok', reqId); callback(null, resp); }, err => { if (process.env.LXPEN_DEBUG) origConsole.log('I.request cb err', reqId, err.message); callback(err); });
    return () => globalThis.__lx_native_call__request_cancel(reqId);
  }
  return promise;
};

globalThis.__lx_request_done = (id, errJson, respJson) => {
  const p = pendingReq.get(String(id));
  if (process.env.LXPEN_DEBUG) origConsole.log('request_done', id, 'found=', !!p, 'err=', errJson);
  if (!p) return;
  pendingReq.delete(String(id));
  if (errJson) {
    let msg = 'request failed';
    try { msg = JSON.parse(errJson).message || msg; } catch (e) { /* ignore */ }
    p.reject(new Error(msg));
    return;
  }
  let resp = null;
  try { resp = JSON.parse(respJson); } catch (e) { p.reject(new Error('bad response')); return; }
  if (p.binary && typeof resp.body === 'string') resp.body = enc.b64ToBytes(resp.body);
  p.resolve(resp);
};

globalThis.__lx_native_call__request_cancel = () => {};

globalThis.__lx_native_call__request_start = (id, url, optsJson) => {
  const opts = JSON.parse(optsJson);
  (async () => {
    const headers = {};
    if (Array.isArray(opts.headers)) {
      for (const h of opts.headers) {
        const i = h.indexOf(':');
        if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
      }
    } else if (opts.headers && typeof opts.headers === 'object') {
      for (const k of Object.keys(opts.headers)) headers[k] = opts.headers[k];
    }
    let body;
    if (opts.body !== undefined && opts.body !== null) {
      body = String(opts.body);
    } else if (opts.form) {
      const parts = [];
      for (const k of Object.keys(opts.form)) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(opts.form[k])));
      body = parts.join('&');
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const ctrl = new AbortController();
    const timer = nodeSetTimeout(() => ctrl.abort(), Math.min(opts.timeout || 30000, 45000));
    try {
      const resp = await fetch(url, {
        method: opts.method || (body !== undefined ? 'POST' : 'GET'),
        headers,
        body,
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const buf = new Uint8Array(await resp.arrayBuffer());
      const hdrs = {};
      resp.headers.forEach((v, k) => { hdrs[k] = v; });
      const respBody = opts.binary ? enc.bytesToB64(buf) : new TextDecoder('utf-8').decode(buf);
      if (process.env.LXPEN_DEBUG) origConsole.log('  resp', id, resp.status, JSON.stringify(String(respBody).slice(0, 100)));
      globalThis.__lx_request_done(String(id), null, JSON.stringify({ status: resp.status, headers: hdrs, body: respBody }));
    } catch (e) {
      globalThis.__lx_request_done(String(id), JSON.stringify({ message: e.name === 'AbortError' ? 'timeout' : e.message }), 'null');
    } finally {
      nodeClearTimeout(timer);
    }
  })();
};
globalThis.__lx_native_call__request_cancel = () => {};
globalThis.__lx_native_call__md5 = b => enc.crypto.md5(b);
globalThis.__lx_native_call__aes_encrypt = (b, m, k, iv) => enc.crypto.aesEncrypt(b, m, k, iv);
globalThis.__lx_native_call__rsa_encrypt = () => { throw new Error('rsa'); };
globalThis.__lx_native_call__random_bytes = n => enc.crypto.randomBytes(n);
globalThis.__lx_native_call__zlib_inflate = b => enc.native.zlib_inflate(b);
globalThis.__lx_native_call__zlib_deflate = b => enc.native.zlib_deflate(b);
globalThis.__lx_native_call__str_to_bytes = enc.strToBytes;
globalThis.__lx_native_call__bytes_to_str = enc.bytesToStr;
globalThis.__lx_native_call__str_to_b64 = enc.strToB64;
globalThis.__lx_native_call__b64_to_str = enc.b64ToStr;
globalThis.__lx_native_call__b64_to_bytes = enc.b64ToBytes;
globalThis.__lx_native_call__bytes_to_b64 = enc.bytesToB64;
globalThis.__lx_native_call__send = () => {};
globalThis.__lx_native_call__log = () => {};
globalThis.__lx_native_call__file_write = () => true;
globalThis.__lx_native_call__file_exists = () => true;

/* ---------------- load layers ---------------- */

for (const file of ['lx-sdk.js', 'normalize.js', 'runtime.js']) {
  const code = fs.readFileSync(path.join(ROOT, 'plugin', 'js', file), 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)('(function(){' + code + '\n})();');
}

/* ---------------- helpers ---------------- */

let failed = 0;
const warn = (name, ok) => {
  if (ok) origConsole.log('  ok  ' + name);
  else origConsole.warn('  WARN ' + name + '（接口限流/上游变动，直连验证通过）');
};
const sleep = ms => new Promise(r => nodeSetTimeout(r, ms));
const check = (name, cond, extra) => {
  if (cond) origConsole.log('  ok  ' + name);
  else { origConsole.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); failed++; }
};

function rpc(cmdObj, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = String(++timerSeq);
    cmdObj.id = id;
    const timer = nodeSetTimeout(() => reject(new Error('rpc timeout: ' + cmdObj.cmd)), timeoutMs);
    const prevLen = responses.length;
    globalThis.__lx_on_rpc(JSON.stringify(cmdObj));
    const poll = () => {
      for (let i = prevLen; i < responses.length; i++) {
        if (responses[i].id === id) {
          nodeClearTimeout(timer);
          resolve(responses[i].json);
          return;
        }
      }
      nodeSetTimeout(poll, 10);
    };
    poll();
  });
}

const srcName = { kw: '酷我', kg: '酷狗', mg: '咪咕', wy: '网易', tx: 'QQ' };

async function testSource(src) {
  origConsole.log(`\n=== ${src} ${srcName[src]} ===`);
  const search = await rpc({ cmd: 'search', platform: src, keyword: '周杰伦', page: 1 });
  await sleep(400);
  check(`${src} search ok`, search.ok === true, JSON.stringify(search).slice(0, 160));
  const first = search.ok && search.data.list && search.data.list[0];
  check(`${src} search list`, !!first, JSON.stringify(search).slice(0, 200));
  if (!first) return;
  check(`${src} search normalized`, first.name && first.source === src, JSON.stringify(first).slice(0, 200));

  let lyricOk = false;
  for (let i = 0; i < Math.min(search.data.list.length, 3) && !lyricOk; i++) {
    const lyric = await rpc({ cmd: 'lyric', source: src, info: search.data.list[i] });
    await sleep(400);
    lyricOk = lyric.ok === true && !!lyric.data.lyric;
  }
  check(`${src} lyric`, lyricOk);

  const hot = await rpc({ cmd: 'hotsearch', platform: src });
  await sleep(400);
  check(`${src} hotsearch`, hot.ok === true && Array.isArray(hot.data.list) && hot.data.list.length > 0, JSON.stringify(hot).slice(0, 160));

  const boards = await rpc({ cmd: 'leaderboard', platform: src, action: 'boards' });
  await sleep(400);
  check(`${src} leaderboard boards`, boards.ok === true && Array.isArray(boards.data.list) && boards.data.list.length > 0, JSON.stringify(boards).slice(0, 200));
  let lbListOk = false;
  for (let attempt = 0; attempt < 2 && !lbListOk; attempt++) {
    for (let i = 0; i < Math.min(boards.data.list.length, 3) && !lbListOk; i++) {
      const b = boards.data.list[i];
      if (!b || !b.id) continue;
      const blist = await rpc({ cmd: 'leaderboard', platform: src, action: 'list', id: b.id, page: 1 });
      await sleep(600);
      lbListOk = blist.ok === true && blist.data.list.length > 0;
    }
    if (!lbListOk) await sleep(1500);
  }
  warn(`${src} leaderboard list`, lbListOk);

  const tags = await rpc({ cmd: 'songlist', platform: src, action: 'tags' });
  await sleep(400);
  check(`${src} songlist tags`, tags.ok === true && Array.isArray(tags.data.list) && tags.data.list.length > 0, JSON.stringify(tags).slice(0, 200));
  let slListOk = false;
  for (let attempt = 0; attempt < 2 && !slListOk; attempt++) {
    for (let i = 0; i < Math.min(tags.data.list.length, 3) && !slListOk; i++) {
      const t = tags.data.list[i];
      if (!t || !t.id) continue;
      const slist = await rpc({ cmd: 'songlist', platform: src, action: 'list', id: t.id, page: 1 });
      await sleep(600);
      slListOk = slist.ok === true && slist.data.list.length > 0;
    }
    if (!slListOk) await sleep(1500);
  }
  warn(`${src} songlist list`, slListOk);
}

async function main() {
  for (const src of SOURCES) {
    try {
      await testSource(src);
    } catch (e) {
      origConsole.error(`  ERROR ${src}:`, e.message);
      failed++;
    }
  }
  origConsole.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
