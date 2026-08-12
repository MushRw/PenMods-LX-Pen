'use strict';
/*
 * 酷我歌词解码（lx-music-mobile kw/decodeLyric.js 的 pen 移植）：
 *   tp=content 头 + zlib inflate + (可选) base64/XOR('yeelion') + GB18030 -> UTF-8。
 * 输出与桌面主进程 kw_decodeLyric.ts 一致：Promise<base64(解码后文本)>。
 */

const I = globalThis.__lxinternal;
const Buf = globalThis.Buffer;
require('__port/zlib.js');
const zlib = require('__port/zlib.js');
const iconv = require('__port/iconv.js');

const buf_key = Buf.from('yeelion');
const buf_key_len = buf_key.length;

const handleInflate = data => new Promise((resolve, reject) => {
  zlib.inflate(data, (err, result) => (err ? reject(err) : resolve(result)));
});

const decodeLyric = async (buf, isGetLyricx) => {
  if (buf.subarray(0, 10).toString('utf8') !== 'tp=content') return '';
  const lrcData = await handleInflate(buf.subarray(buf.indexOf('\r\n\r\n') + 4));
  if (!isGetLyricx) return iconv.decodeGbk(lrcData);
  const buf_str = Buf.from(lrcData.toString(), 'base64');
  const buf_str_len = buf_str.length;
  const output = new Uint8Array(buf_str_len);
  let i = 0;
  while (i < buf_str_len) {
    let j = 0;
    while (j < buf_key_len && i < buf_str_len) {
      output[i] = buf_str[i] ^ buf_key[j];
      i++;
      j++;
    }
  }
  return iconv.decodeGbk(output);
};

module.exports = async ({ lrcBase64, isGetLyricx }) => {
  const lrc = await decodeLyric(Buf.from(lrcBase64, 'base64'), !!isGetLyricx);
  return I.bytesToB64(I.strToBytes(lrc));
};
