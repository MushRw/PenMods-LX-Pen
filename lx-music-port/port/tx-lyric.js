'use strict';
/*
 * QQ 音乐歌词（lx-music-mobile tx/lyric.js 的 pen 移植）：
 * fcg_query_lyric_new.fcg 直接返回 base64 的 LRC/翻译，无需 qrc 解码。
 */

const I = globalThis.__lxinternal;
const { httpFetch } = require('__port/http.js');
const { decodeName } = require('__port/common.js');

const b64DecodeUnicode = str => {
  try {
    return I.bytesToStr(I.b64ToBytes(String(str)));
  } catch (e) {
    return '';
  }
};

function getLyric(songmid) {
  const requestObj = httpFetch(
    'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' +
    encodeURIComponent(songmid) +
    '&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&platform=yqq',
    { headers: { Referer: 'https://y.qq.com/portal/player.html' }, timeout: 20000 }
  );
  requestObj.promise = requestObj.promise.then(({ body }) => {
    if (!body || body.code !== 0 || !body.lyric) return Promise.reject(new Error('Get lyric failed'));
    return {
      lyric: decodeName(b64DecodeUnicode(body.lyric)),
      tlyric: decodeName(b64DecodeUnicode(body.trans)),
      rlyric: '',
      lxlyric: '',
    };
  });
  return requestObj;
}

module.exports = { getLyric, b64DecodeUnicode };
