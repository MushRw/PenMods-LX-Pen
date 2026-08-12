'use strict';
/* JS port of vendor/common/lyricUtils/util.ts (decodeName). */

const encodeNames = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#039;': "'",
};

const decodeName = (str = '') => {
  if (!str) return '';
  return String(str).replace(/(?:&amp;|&lt;|&gt;|&quot;|&apos;|&#039;|&nbsp;)/gm, s => encodeNames[s] || s);
};

module.exports = { decodeName };
