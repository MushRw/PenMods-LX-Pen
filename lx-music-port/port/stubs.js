'use strict';
/*
 * Stubs for desktop-only / Electron-only imports that musicSdk touches:
 *   - @common/ipcNames / @common/rendererIpc (main-process lyric decode)
 *   - ../api-source (musicUrl is resolved by user script at runtime)
 *   - dns (libcurl resolves hostnames natively)
 *   - renderer/utils/message (requestMsg)
 */

/*
 * 桌面版把歌词解码丢给主进程 IPC；pen 上通过 __penHooks 注册 JS 实现
 * （如 port/kw-decodeLyric.js、port/tx-lyric.js），未注册才报错。
 */
const rendererInvoke = (name, data) => {
  const hook = globalThis.__penHooks && globalThis.__penHooks[name];
  if (typeof hook === 'function') return hook(data);
  throw new Error('rendererInvoke unsupported on pen: ' + name);
};

const WIN_MAIN_RENDERER_EVENT_NAME = {
  handle_kw_decode_lyric: 'kw_decode_lyric',
  handle_tx_decode_lyric: 'tx_decode_lyric',
};

const apis = () => {
  throw new Error('musicUrl is resolved via user script (runtime.js handleScript), not musicSdk.apis()');
};

const requestMsg = {
  fail: '请求异常',
  unachievable: '接口无法访问',
  timeout: '请求超时',
  notConnectNetwork: '无法连接到服务器',
  cancelRequest: '取消http请求',
  tooManyRequests: '服务器繁忙',
};

const dnsLookup = (hostname, options, callback) => {
  if (typeof options === 'function') callback = options;
  if (typeof callback === 'function') callback(null, hostname, 4);
};

module.exports = {
  rendererInvoke,
  WIN_MAIN_RENDERER_EVENT_NAME,
  apis,
  requestMsg,
  dnsLookup,
};
