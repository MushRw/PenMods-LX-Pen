'use strict';
/*
 * lx-sdk bundle entry. Registers globalThis.__lxSdk with the 5 online sources
 * (search / lyric / pic / leaderboard / songList / comment / hotSearch /
 * tipSearch / singer / album where available).
 *
 * musicUrl 不在其中：与桌面版一致，由“音源脚本”(userApi) 在运行时提供，
 * pen 侧对应 PenMods-Music 的 runtime.js handleScript。
 */

require('__port/buffer.js');

const kw = require('musicSdk/kw/index.js').default;
const kg = require('musicSdk/kg/index.js').default;
const mg = require('musicSdk/mg/index.js').default;
const wy = require('musicSdk/wy/index.js').default;
const tx = require('musicSdk/tx/index.js').default;
const common = require('__port/common.js');
const stubs = require('__port/stubs.js');

/* 桌面版歌词实现中经 IPC 的解码路径，改为 pen 上的 JS 实现 */
globalThis.__penHooks = globalThis.__penHooks || {};
globalThis.__penHooks[stubs.WIN_MAIN_RENDERER_EVENT_NAME.handle_kw_decode_lyric] = require('__port/kw-decodeLyric.js');

/* QQ 歌词：桌面版走 qrc 专有二进制；改用 lx-music-mobile 的 base64 LRC 接口 */
const txLyricMobile = require('__port/tx-lyric.js');
tx.getLyric = function (songInfo) {
  return txLyricMobile.getLyric(songInfo && songInfo.songmid);
};

/* 咪咕：resourceinfo 接口已失效，改用搜索结果自带的 lrcUrl/mrcUrl */
const mgLyric = require('__port/mg-lyric.js');
mg.getLyric = mgLyric.getLyric;

const internal = {
  crypto: require('__port/crypto.js'),
  http: require('__port/http.js'),
  zlib: require('__port/zlib.js'),
  buffer: require('__port/buffer.js'),
  stubs: require('__port/stubs.js'),
};

module.exports = {
  kw,
  kg,
  mg,
  wy,
  tx,
  common,
  internal,
  sources: [
    { name: '酷我音乐', id: 'kw' },
    { name: '酷狗音乐', id: 'kg' },
    { name: 'QQ音乐', id: 'tx' },
    { name: '网易音乐', id: 'wy' },
    { name: '咪咕音乐', id: 'mg' },
  ],
};
