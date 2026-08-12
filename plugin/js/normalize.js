'use strict';
/*
 * lx 结果 -> 插件 QML 字段的归一化（唯一自研逻辑，约 30 行）。
 */

const I = globalThis.__lxinternal;
const sdk = globalThis.__lxSdk;
const fmtPlayTime = sdk.common.formatPlayTime;

function toPenMusicInfo(it) {
  if (!it || typeof it !== 'object') return it;
  return {
    name: it.name || '',
    singer: it.singer || '',
    source: it.source || '',
    songmid: it.songmid !== undefined ? it.songmid : (it.songId !== undefined ? it.songId : ''),
    hash: it.hash || '',
    albumId: it.albumId || '',
    albumName: it.albumName || '',
    interval: typeof it.interval === 'number' ? fmtPlayTime(it.interval) : (it.interval || ''),
    img: it.img || null,
    lrc: it.lrc || null,
    otherSource: it.otherSource || null,
    types: it.types || [],
    _types: it._types || {},
    typeUrl: it.typeUrl || {},
    /* 歌词/封面等后续流程需要的透传字段 */
    copyrightId: it.copyrightId,
    lrcUrl: it.lrcUrl,
    mrcUrl: it.mrcUrl,
    trcUrl: it.trcUrl,
  };
}

function toPenBoard(it) {
  if (!it || typeof it !== 'object') return it;
  const id = it.boardid || it.id || it.specialid || it.listid || it.tagId || it.content_id || '';
  const name = it.boardtitle || it.name || it.title || it.tagName || it.specialname || '';
  return { id: String(id), name: String(name) };
}

function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.lists)) return data.lists;
  if (data && Array.isArray(data.info)) return data.info;
  return [];
}

/* 各源 getBoardsData() 返回结构不同，这里做“接口 -> 原始榜单数组”的提取 */
const LEADERBOARD_EXTRACT = {
  kw: d => (d && d.body && Array.isArray(d.body.child) ? d.body.child : asList(d)),
  kg: d => (d && d.body && d.body.data && Array.isArray(d.body.data.info) ? d.body.data.info : asList(d)),
  mg: d => {
    const body = d && d.body ? d.body : d;
    if (body && body.data && Array.isArray(body.data.contents)) {
      const out = [];
      for (const g of body.data.contents) {
        if (g && Array.isArray(g.contents)) out.push(...g.contents);
      }
      return out;
    }
    return asList(d);
  },
  tx: d => (d && d.body && d.body.data && Array.isArray(d.body.data.topList) ? d.body.data.topList : asList(d)),
  wy: d => {
    const raw = d && d.body ? d.body : d;
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.list)) return raw.list;
    return asList(d);
  },
};

function normBoard(b) {
  if (!b || typeof b !== 'object') return b;
  const id = String(b.id !== undefined ? b.id : (b.boardid || b.rankId || b.rankid || ''));
  let bangid = b.bangid !== undefined ? String(b.bangid) : '';
  if (!bangid && id) bangid = id.replace(/^[a-z]+__/, '');
  const name = String(b.name || b.rankname || b.rankName || b.boardtitle || '');
  return { id, name, bangid };
}

function extractBoards(src, data) {
  const raw = (LEADERBOARD_EXTRACT[src] || asList)(data);
  const srcSdk = sdk[src];
  if (srcSdk && srcSdk.leaderboard && typeof srcSdk.leaderboard.filterBoardsData === 'function') {
    try {
      return srcSdk.leaderboard.filterBoardsData(raw).map(normBoard);
    } catch (e) {
      /* 走通用提取 */
    }
  }
  return raw.map(normBoard);
}

/* 各源 getTags() 返回 {hotTag:[...]} 或 {tags:[{name,list:[...]}]} */
function extractTags(data) {
  if (!data) return [];
  if (Array.isArray(data.hotTag)) return data.hotTag;
  if (Array.isArray(data.tags)) {
    const out = [];
    for (const g of data.tags) {
      if (g && Array.isArray(g.list)) out.push(...g.list);
      else if (g) out.push(g);
    }
    return out;
  }
  return asList(data);
}

globalThis.__toPenMusicInfo = toPenMusicInfo;
globalThis.__toPenBoard = toPenBoard;
globalThis.__asList = asList;
globalThis.__extractBoards = extractBoards;
globalThis.__extractTags = extractTags;
