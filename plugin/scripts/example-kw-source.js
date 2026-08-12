/**
 * @name 酷我示例音源
 * @description 使用酷我公开 convert_url 接口解析播放链接（示例，仅支持 kw）
 * @version 1.0.0
 * @author PenMods-Music
 */
'use strict';

const { EVENT_NAMES, request, on, send } = globalThis.lx;

const httpRequest = (url, options) => new Promise((resolve, reject) => {
  request(url, options, (err, resp) => {
    if (err) return reject(err);
    resolve(resp.body);
  });
});

on(EVENT_NAMES.request, ({ source, action, info }) => {
  switch (action) {
    case 'musicUrl': {
      const rid = 'MUSIC_' + String(info.musicInfo.songmid || '');
      return httpRequest(
        'http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=' + encodeURIComponent(rid) +
        '&format=mp3&response=url',
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }
      ).then(url => {
        const u = String(url || '').trim();
        if (!/^https?:\/\//i.test(u)) return Promise.reject(new Error('Get music url failed'));
        return u;
      });
    }
    default:
      return Promise.reject(new Error('unsupported action: ' + action));
  }
});

send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    kw: {
      name: '酷我音乐',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac'],
    },
  },
});
