'use strict';
/*
 * Pure helper functions that musicSdk imports from renderer/utils/index.ts /
 * common/utils/common.ts. Hand-ported, no DOM / Electron dependencies.
 */

const I = globalThis.__lxinternal;

const numFix = n => (n < 10 ? '0' + n : n.toString());

const formatPlayTime = time => {
  const m = Math.trunc(time / 60);
  const s = Math.trunc(time % 60);
  return m === 0 && s === 0 ? '--/--' : numFix(m) + ':' + numFix(s);
};

const formatPlayTime2 = time => {
  const m = Math.trunc(time / 60);
  const s = Math.trunc(time % 60);
  return numFix(m) + ':' + numFix(s);
};

const sizeFormate = size => {
  if (!size) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const number = Math.floor(Math.log(size) / Math.log(1024));
  return (size / Math.pow(1024, Math.floor(number))).toFixed(2) + ' ' + units[number];
};

const toDateObj = date => {
  if (!date) return '';
  if (typeof date === 'string') {
    if (!date.includes('T')) date = date.split('.')[0].replace(/-/g, '/');
    date = new Date(date); /* 桌面版 switch 会 fall-through 到 number 分支 */
  }
  if (typeof date === 'number') date = new Date(date);
  return date;
};

const dateFormat = (_date, format = 'Y-M-D h:m:s') => {
  const date = toDateObj(_date);
  if (!date) return '';
  return format
    .replace('Y', date.getFullYear().toString())
    .replace('M', numFix(date.getMonth() + 1))
    .replace('D', numFix(date.getDate()))
    .replace('h', numFix(date.getHours()))
    .replace('m', numFix(date.getMinutes()))
    .replace('s', numFix(date.getSeconds()));
};

const formatPlayCount = num => {
  if (num > 100000000) return Math.trunc(num / 10000000) / 10 + '亿';
  if (num > 10000) return Math.trunc(num / 1000) / 10 + '万';
  return String(num);
};

/* desktop version uses i18n; simplified Chinese for the pen */
const dateFormat2 = time => {
  const differ = Math.trunc((Date.now() - time) / 1000);
  if (differ < 60) return differ + '秒前';
  if (differ < 3600) return Math.trunc(differ / 60) + '分钟前';
  if (differ < 86400) return Math.trunc(differ / 3600) + '小时前';
  return dateFormat(time, 'Y-M-D');
};

const encodeNames = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#039;': "'",
};

const decodeName = (str = '') => {
  if (!str) return '';
  return String(str).replace(/(?:&amp;|&lt;|&gt;|&quot;|&apos;|&#039;|&nbsp;)/gm, s => encodeNames[s] || s);
};

const toMD5 = str => I.crypto.md5(I.strToBytes(String(str)));

const getRandom = (min, max) => Math.floor(Math.random() * (max - min)) + min;

const isUrl = path => /https?:\/\//.test(path);

module.exports = {
  formatPlayTime,
  formatPlayTime2,
  sizeFormate,
  toDateObj,
  dateFormat,
  formatPlayCount,
  dateFormat2,
  decodeName,
  toMD5,
  getRandom,
  isUrl,
};
