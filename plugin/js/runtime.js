'use strict';
/*
 * LX Pen runtime：FIFO JSON-RPC 桥。
 * 数据层全部走 globalThis.__lxSdk（lx-music 移植）；音源脚本走 lx 协议；
 * mpv 播放命令由 C 层直连处理。
 */

const I = globalThis.__lxinternal;
const native = I.native;
const sdk = globalThis.__lxSdk;
const toPenMusicInfo = globalThis.__toPenMusicInfo;
const toPenBoard = globalThis.__toPenBoard;
const asList = globalThis.__asList;
const extractBoards = globalThis.__extractBoards;
const extractTags = globalThis.__extractTags;

const PLATFORMS = ['kw', 'kg', 'mg', 'wy', 'tx'];

function getSrc(platform) {
  if (!PLATFORMS.includes(platform) || !sdk[platform]) throw new Error('unknown platform ' + platform);
  return sdk[platform];
}

function getPromise(ret) {
  return ret && typeof ret.promise !== 'undefined' ? ret.promise : ret;
}

/* ---------------- RPC handlers ---------------- */

async function handleSearch(req) {
  const platform = String(req.platform || '').toLowerCase();
  const keyword = String(req.keyword || '');
  const page = parseInt(req.page) || 1;
  const limit = parseInt(req.limit) || 30;
  if (!keyword) throw new Error('empty keyword');
  const src = getSrc(platform);
  const res = await getPromise(src.musicSearch.search(keyword, page, limit));
  return {
    list: asList(res).map(toPenMusicInfo),
    allPage: res && res.allPage ? res.allPage : 1,
    total: res && res.total ? res.total : 0,
    limit,
    source: platform,
  };
}

async function handleLyric(req) {
  const platform = String(req.source || '').toLowerCase();
  const info = req.info || {};
  const src = getSrc(platform);
  const res = await getPromise(src.getLyric(info));
  const lyricText = (res && res.lyric) || '';
  /* 顺带把 LRC 原文写到 /tmp，供宿主播放器（lxpenPlayer）显示歌词 */
  let path = '';
  if (lyricText) {
    const mid = String((info && (info.songmid || info.hash)) || 'x').replace(/[^A-Za-z0-9_-]/g, '');
    const p = '/tmp/lxpen_' + mid + '.lrc';
    if (native.file_write(p, lyricText)) path = p;
  }
  return {
    lyric: lyricText,
    tlyric: (res && res.tlyric) || '',
    rlyric: (res && res.rlyric) || '',
    lxlyric: (res && res.lxlyric) || '',
    path,
  };
}

async function handleDownload(req) {
  const url = String(req.url || '');
  const path = String(req.path || '');
  if (!url || !path) throw new Error('empty url/path');
  const resp = await I.request(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
    binary: true,
    timeout: 120000,
  });
  if (resp.status !== 200) throw new Error('download http ' + resp.status);
  if (!native.file_write(path, resp.body)) throw new Error('download write failed');
  return { path, size: resp.body && resp.body.byteLength ? resp.body.byteLength : 0 };
}

async function handlePic(req) {
  const platform = String(req.source || '').toLowerCase();
  const info = req.info || {};
  const src = getSrc(platform);
  const url = await getPromise(src.getPic(info));
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Get pic failed');
  return url;
}

async function handleCover(req) {
  const url = String(req.url || '');
  if (!url) throw new Error('empty url');
  const resp = await I.request(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
    binary: true,
    timeout: 20000,
  });
  if (resp.status !== 200) throw new Error('cover http ' + resp.status);
  if (!native.file_write('/tmp/lxpen_cover.jpg', resp.body)) throw new Error('cover write failed');
  return { path: '/tmp/lxpen_cover.jpg' };
}

async function handleScript(req) {
  const source = String(req.source || '');
  const action = String(req.action || '');
  const info = req.info || {};
  const result = await globalThis.lx._dispatchRequest({ source, action, info });
  if (action === 'musicUrl') {
    if (typeof result !== 'string' || !/^https?:\/\//i.test(result)) throw new Error('Get music url failed');
    return result;
  }
  if (action === 'pic') {
    if (typeof result !== 'string' || !/^https?:\/\//i.test(result)) throw new Error('Get pic failed');
    return result;
  }
  if (action === 'lyric') {
    const o = result || {};
    if (typeof o.lyric !== 'string') throw new Error('Get lyric failed');
    return { lyric: o.lyric, tlyric: o.tlyric || '', rlyric: o.rlyric || '', lxlyric: o.lxlyric || '' };
  }
  return result;
}

async function handleLeaderboard(req) {
  const platform = String(req.platform || '').toLowerCase();
  const src = getSrc(platform);
  const action = String(req.action || 'boards');
  if (action === 'boards') {
    const data = await getPromise(src.leaderboard.getBoardsData());
    return { list: extractBoards(platform, data), source: platform };
  }
  const page = parseInt(req.page) || 1;
  const id = String(req.id || '').replace(/^[a-z]+__/, '');
  if (!id) throw new Error('empty board id');
  if (platform === 'wy') {
    /* wy 榜单走 weapi 歌单详情 */
    const res = await getPromise(src.leaderboard.getData(id));
    const body = res && res.body ? res.body : res;
    const tracks = body && body.playlist && Array.isArray(body.playlist.tracks) ? body.playlist.tracks : [];
    const list = tracks.map(t => toPenMusicInfo({
      songmid: t.id,
      name: t.name,
      singer: Array.isArray(t.ar) ? t.ar.map(a => a.name || '').join('、') : '',
      albumName: t.al && t.al.name,
      albumId: t.al && t.al.id,
      img: t.al && t.al.picUrl,
      interval: t.dt ? Math.round(t.dt / 1000) : 0,
      source: 'wy',
    }));
    return { list, allPage: 1, total: list.length, source: platform };
  }
  const res = await getPromise(src.leaderboard.getList(id, page));
  return {
    list: asList(res).map(toPenMusicInfo),
    allPage: src.leaderboard && src.leaderboard.allPage ? src.leaderboard.allPage : 1,
    total: src.leaderboard && src.leaderboard.total ? src.leaderboard.total : 0,
    source: platform,
  };
}

async function handleSongList(req) {
  const platform = String(req.platform || '').toLowerCase();
  const src = getSrc(platform);
  const action = String(req.action || 'tags');
  if (action === 'tags') {
    const data = await getPromise(src.songList.getTags());
    return { list: extractTags(data).map(toPenBoard), source: platform };
  }
  const page = parseInt(req.page) || 1;
  if (action === 'search') {
    const keyword = String(req.keyword || '');
    if (!keyword) throw new Error('empty keyword');
    const res = await getPromise(src.songList.search(keyword, page));
    return { list: asList(res).map(toPenMusicInfo), source: platform };
  }
  const id = String(req.id || '');
  if (!id) throw new Error('empty list id');
  /* kw 的 getList(sortId, tagId, page) 需要 sortId（桌面 UI 默认“推荐”=5） */
  const sortId = platform === 'kw' ? (String(req.sortId || '5')) : undefined;
  const res = platform === 'kw' || platform === 'kg' || platform === 'mg' || platform === 'tx'
    ? await getPromise(src.songList.getList.call(src.songList, sortId, id, page))
    : await getPromise(src.songList.getList.call(src.songList, id, page));
  return {
    list: asList(res).map(toPenMusicInfo),
    allPage: src.songList && src.songList.allPage ? src.songList.allPage : 1,
    total: src.songList && src.songList.total ? src.songList.total : 0,
    source: platform,
  };
}

async function handleHotSearch(req) {
  const platform = String(req.platform || '').toLowerCase();
  const src = getSrc(platform);
  const res = await getPromise(src.hotSearch.getList());
  return {
    source: platform,
    list: (res && Array.isArray(res.list) ? res.list : []).map(String),
  };
}

async function handlePing() {
  return 'pong';
}

async function __handleRpc(req) {
  switch (req.cmd) {
    case 'search': return await handleSearch(req);
    case 'lyric': return await handleLyric(req);
    case 'download': return await handleDownload(req);
    case 'pic': return await handlePic(req);
    case 'cover': return await handleCover(req);
    case 'script': return await handleScript(req);
    case 'leaderboard': return await handleLeaderboard(req);
    case 'songlist': return await handleSongList(req);
    case 'hotsearch': return await handleHotSearch(req);
    case 'ping': return await handlePing();
    default: throw new Error('unknown cmd ' + req.cmd);
  }
}

globalThis.__handleRpc = __handleRpc;

globalThis.__lx_on_rpc = jsonStr => {
  let req = null;
  try {
    req = JSON.parse(jsonStr);
  } catch (e) {
    native.rpc_done('0', JSON.stringify({ ok: false, error: 'bad json' }));
    return;
  }
  const id = String(req.id);
  /* SO 侧（宿主播放器组件）请求时把响应额外写到独立文件，避免与 QML 轮询争用同一输出文件 */
  const respPath = String(req.respPath || '');
  Promise.resolve()
    .then(() => __handleRpc(req))
    .then(
      data => {
        const json = JSON.stringify({ ok: true, data });
        native.rpc_done(id, json);
        if (respPath) native.file_write(respPath, json);
      },
      err => {
        const json = JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) });
        native.rpc_done(id, json);
        if (respPath) native.file_write(respPath, json);
      }
    );
};

native.log('info', 'LX Pen runtime ready');
