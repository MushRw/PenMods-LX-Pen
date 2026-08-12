'use strict';
/*
 * 咪咕歌词（lx-music-desktop mg/lyric.js 的 pen 适配）：
 * 上游 resourceinfo.do 接口已失效（返回空 resource），改用搜索结果里自带的
 * lrcUrl/mrcUrl/trcUrl 直接取词；mrc 解析逻辑 1:1 保留自 mg/lyric.js。
 */

const { httpFetch } = require('__port/http.js');
const { decrypt } = require('musicSdk/mg/utils/mrc.js');

const MG_HEADERS = {
  Referer: 'https://app.c.nf.migu.cn/',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.115 Mobile Safari/537.36',
  channel: '0146921',
};

const mrcRxps = {
  lineTime: /^\s*\[(\d+),\d+\]/,
  wordTime: /\((\d+),\d+\)/,
  wordTimeAll: /(\(\d+,\d+\))/g,
};

function parseLyric(str) {
  str = String(str || '').replace(/\r/g, '');
  const lines = str.split('\n');
  const lxlrcLines = [];
  const lrcLines = [];
  for (const line of lines) {
    if (line.length < 6) continue;
    const result = mrcRxps.lineTime.exec(line);
    if (!result) continue;
    const startTime = parseInt(result[1]);
    let time = startTime;
    const ms = time % 1000;
    time = Math.floor(time / 1000);
    const m = Math.floor(time / 60).toString().padStart(2, '0');
    const s = Math.floor(time % 60).toString().padStart(2, '0');
    const tStr = m + ':' + s + '.' + ms;
    const words = line.replace(mrcRxps.lineTime, '');
    lrcLines.push('[' + tStr + ']' + words.replace(mrcRxps.wordTimeAll, ''));
    const times = words.match(mrcRxps.wordTimeAll);
    if (!times) continue;
    const newTimes = times.map(t => {
      const r = /\((\d+),(\d+)\)/.exec(t);
      return '<' + (parseInt(r[1]) - startTime) + ',' + r[2] + '>';
    });
    const wordArr = words.split(mrcRxps.wordTime);
    const newWords = newTimes.map((t, index) => t + wordArr[index]).join('');
    lxlrcLines.push('[' + tStr + ']' + newWords);
  }
  return { lyric: lrcLines.join('\n'), lxlyric: lxlrcLines.join('\n') };
}

function getText(url, tryNum) {
  tryNum = tryNum || 0;
  const requestObj = httpFetch(url, { headers: MG_HEADERS, timeout: 20000 });
  return requestObj.promise.then(({ statusCode, body }) => {
    if (statusCode === 200) return body;
    if (tryNum > 5 || statusCode === 404) return Promise.reject(new Error('歌词获取失败'));
    return getText(url, ++tryNum);
  });
}

function getMrc(url) {
  return getText(url).then(text => parseLyric(decrypt(text)));
}

function getLrc(url) {
  return getText(url).then(text => ({ lxlyric: '', lyric: typeof text === 'string' ? text : String(text) }));
}

function getTrc(url) {
  return url ? getText(url) : Promise.resolve('');
}

function getLyric(songInfo) {
  return {
    promise: (async () => {
      if (!songInfo) throw new Error('获取歌词失败');
      let p;
      if (songInfo.mrcUrl) p = getMrc(songInfo.mrcUrl);
      else if (songInfo.lrcUrl) p = getLrc(songInfo.lrcUrl);
      if (!p) throw new Error('获取歌词失败');
      const [lrcInfo, tlyric] = await Promise.all([p, getTrc(songInfo.trcUrl)]);
      lrcInfo.tlyric = tlyric || '';
      lrcInfo.rlyric = '';
      return lrcInfo;
    })(),
    cancelHttp() {},
  };
}

module.exports = { getLyric, parseLyric };
