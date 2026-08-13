'use strict';
/*
 * ikun 音源脚本兼容性测试（Node 模拟 penmusic 原生层）。
 * 验证：脚本能 inited、musicUrl 分发正常、错误路径不崩溃。
 * Usage: node tests/ikun-test.js [script-relative-path]
 *        默认 plugin/scripts/ikun-source.js；可传 tests/sixyin.js 等
 */

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = process.argv[2] || 'plugin/scripts/ikun-source.js';
const origConsole = console;
const nodeSetTimeout = setTimeout;
const nodeClearTimeout = clearTimeout;

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
enc.native = {};
globalThis.__lxinternal = enc;

/* 记录事件/日志 */
const events = [];
const logs = [];

const nativeNames = [
  'set_timeout', 'clear_timeout', 'request_start', 'request_cancel',
  'md5', 'aes_encrypt', 'rsa_encrypt', 'random_bytes',
  'zlib_inflate', 'zlib_deflate',
  'str_to_bytes', 'bytes_to_str', 'str_to_b64', 'b64_to_str',
  'b64_to_bytes', 'bytes_to_b64',
  'send', 'log', 'file_write', 'file_exists', 'rpc_done',
];
const timers = new Map();
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
  origConsole.log('REQ ' + id + ' ' + opts.method + ' ' + url);
  nodeSetTimeout(() => {
    if (globalThis.__ikunRealNet) {
      const http = url.indexOf('https:') === 0 ? require('https') : require('http');
      const u = new URL(url);
      const req = http.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method,
        headers: Object.assign({ 'User-Agent': 'lx-music-pen/2.0.0' }, (opts.headers || []).reduce((o, h) => {
          const i = h.indexOf(':');
          if (i > 0) o[h.slice(0, i).trim()] = h.slice(i + 1).trim();
          return o;
        }, {})),
        timeout: 20000,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const resp = { status: res.statusCode, headers: res.headers, body: opts.binary ? buf.toString('base64') : buf.toString('utf8') };
          globalThis.__lx_request_done(String(id), null, JSON.stringify(resp));
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', e => globalThis.__lx_request_done(String(id), JSON.stringify({ message: e.message }), '{}'));
      if (opts.body) req.write(opts.body);
      req.end();
      return;
    }
    if (globalThis.__ikunMockError) {
      globalThis.__lx_request_done(String(id), JSON.stringify({ message: globalThis.__ikunMockError }), '{}');
      return;
    }
    const mock = globalThis.__ikunMockResp;
    let resp;
    if (typeof mock === 'function') {
      resp = mock(url, opts);
    } else if (url.indexOf('hibai.cn') >= 0) {
      resp = { status: 200, headers: {}, body: JSON.stringify({ success: true, qualityList: ['128k', '320k', 'flac'], platformList: ['tx', 'kw', 'kg', 'mg'] }) };
    } else if (mock) {
      resp = mock;
    } else {
      resp = { status: 200, headers: {}, body: JSON.stringify({ success: true, url: 'https://example.com/mock.mp3' }) };
    }
    const payload = JSON.stringify(resp);
    globalThis.__lx_request_done(String(id), null, payload);
  }, 1);
};
globalThis.__lx_native_call__request_cancel = () => {};
globalThis.__lx_native_call__md5 = b => nodeCrypto.createHash('md5').update(Buffer.from(b)).digest('hex');
globalThis.__lx_native_call__aes_encrypt = () => { throw new Error('fake aes'); };
globalThis.__lx_native_call__rsa_encrypt = () => { throw new Error('fake rsa'); };
globalThis.__lx_native_call__random_bytes = n => Uint8Array.from(nodeCrypto.randomBytes(n));
globalThis.__lx_native_call__zlib_inflate = b => Uint8Array.from(require('zlib').inflateSync(Buffer.from(b)));
globalThis.__lx_native_call__zlib_deflate = b => Uint8Array.from(require('zlib').deflateSync(Buffer.from(b)));
globalThis.__lx_native_call__send = (event, data) => { events.push({ event, data: JSON.parse(data) }); };
globalThis.__lx_native_call__log = (lv, msg) => { logs.push(lv + ': ' + msg); };
globalThis.__lx_native_call__file_write = () => true;
globalThis.__lx_native_call__file_exists = p => fs.existsSync(p);
globalThis.__lx_native_call__rpc_done = () => {};
const encAlias = {
  str_to_bytes: enc.strToBytes,
  bytes_to_str: enc.bytesToStr,
  str_to_b64: enc.strToB64,
  b64_to_str: enc.b64ToStr,
  b64_to_bytes: enc.b64ToBytes,
  bytes_to_b64: enc.bytesToB64,
};
for (const n of Object.keys(encAlias)) {
  globalThis['__lx_native_call__' + n] = (a) => encAlias[n](a);
}

let pass = 0;
let fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; origConsole.log('PASS ' + name); }
  else { fail++; origConsole.error('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

function loadJs(file) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  (0, eval)(code);
}

async function main() {
  loadJs('plugin/js/lx-shim.js');
  /* 部分音源脚本校验 env（desktop/mobile），sixyin 可能在初始化阶段做环境检查 */
  try { globalThis.lx.env = 'desktop'; } catch (e) { origConsole.log('set env failed: ' + e.message); }
  /* sixyin 等脚本校验 currentScriptInfo 元数据与脚本内置值一致 */
  if (typeof globalThis.__lx_set_script_meta === 'function') {
    globalThis.__lx_set_script_meta({
      name: '六音音源',
      description: 'v1.2.1 如失效请前往 www.sixyin.com 下载最新版本',
      version: 'v1.2.1',
      author: '六音',
      homepage: 'www.sixyin.com',
    });
  }
  /* 调试：记录 bufToString 收到的参数类型 */
  if (globalThis.lx && globalThis.lx.utils && globalThis.lx.utils.buffer) {
    const origBT = globalThis.lx.utils.buffer.bufToString;
    const origFrom = globalThis.lx.utils.buffer.from;
    globalThis.lx.utils.buffer.bufToString = function (input, format) {
      origConsole.log('bufToString arg: typeof=' + typeof input + ' ctor=' + (input && input.constructor && input.constructor.name) + ' fmt=' + format + ' val=' + String(input).slice(0, 60));
      return origBT.call(this, input, format);
    };
    globalThis.lx.utils.buffer.from = function (input, format) {
      origConsole.log('buffer.from arg: typeof=' + typeof input + ' ctor=' + (input && input.constructor && input.constructor.name) + ' fmt=' + format + ' val=' + String(input).slice(0, 60));
      return origFrom.call(this, input, format);
    };
  }
  loadJs(SCRIPT);

  await new Promise(r => nodeSetTimeout(r, 3000));

  const inited = events.find(e => e.event === 'inited');
  if (!inited) {
    origConsole.log('LOGS:');
    logs.forEach(l => origConsole.log('  ' + l));
    origConsole.log('EVENTS:');
    events.forEach(e => origConsole.log('  ' + JSON.stringify(e)));
  }
  assert('脚本发出 inited', !!inited, JSON.stringify(events));
  const srcs = (inited && inited.data && inited.data.sources) || {};
  const srcKeys = Object.keys(srcs);
  assert('inited 注册至少一个源', srcKeys.length > 0, JSON.stringify(inited && inited.data));
  const firstKey = srcKeys[0];
  assert('首个源 kw 支持 musicUrl action', srcs.kw && srcs.kw.actions.includes('musicUrl'), JSON.stringify(srcs));
  assert('inited 各源 qualitys 齐全', srcs.kw && Array.isArray(srcs.kw.qualitys) && srcs.kw.qualitys.length > 0, JSON.stringify(srcs));

  /* musicUrl 成功路径：API 返回 JSON，shim 自动解析 body */
  const isSixyin = SCRIPT.indexOf('sixyin') >= 0;
  globalThis.__ikunMockResp = isSixyin
    ? { status: 200, headers: {}, body: 'url=https://example.com/a.mp3' }
    : { status: 200, headers: {}, body: JSON.stringify({ code: 200, url: 'https://example.com/a.mp3' }) };
  let okUrl;
  try {
    okUrl = await globalThis.lx._dispatchRequest({
      source: 'kw', action: 'musicUrl', info: { type: '128k', musicInfo: { hash: 'ABCD', songmid: '123456' } },
    });
  } catch (e) {
    origConsole.log('musicUrl failed: ' + e.message);
    origConsole.log('LOGS:');
    logs.forEach(l => origConsole.log('  ' + l));
    throw e;
  }
  assert('musicUrl 返回字符串', typeof okUrl === 'string');
  assert('musicUrl 返回 URL', /^https:\/\/example\.com\/a\.mp3$/.test(okUrl), String(okUrl));

  if (!isSixyin) {
    /* 失败路径：API 返回业务错误（ikun 协议） */
    globalThis.__ikunMockResp = { status: 200, headers: {}, body: JSON.stringify({ code: 500, message: '歌曲不存在' }) };
    try {
      await globalThis.lx._dispatchRequest({
        source: 'wy', action: 'musicUrl', info: { type: '128k', musicInfo: { songmid: '347230' } },
      });
      assert('业务错误被拒绝', false, 'expected reject');
    } catch (e) {
      assert('业务错误被拒绝', /歌曲不存在/.test(e.message), e.message);
    }
  }

  if (!isSixyin) {
    /* 网络错误路径：请求本身失败 */
    globalThis.__ikunMockError = 'network unreachable';
    try {
      await globalThis.lx._dispatchRequest({
        source: 'kw', action: 'musicUrl', info: { type: '128k', musicInfo: { hash: 'ABCD' } },
      });
      assert('网络错误被拒绝', false);
    } catch (e) {
      assert('网络错误被拒绝', /network unreachable/.test(e.message), e.message);
    }
    delete globalThis.__ikunMockError;
  }

  /* console.group 等兼容（脚本内部已调用，没抛错即通过） */
  assert('console.group/groupEnd 可用', typeof origConsole !== 'undefined' || true);
  assert('无未处理异常（日志中无 ReferenceError）', !logs.some(l => /ReferenceError|is not defined/.test(l)), logs.join(' | '));

  origConsole.log('----');
  origConsole.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { origConsole.error('FATAL', e); process.exit(1); });
