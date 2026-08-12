'use strict';
/*
 * 把子目录 lx-music-port 的打包产物同步到插件 js 目录。
 * Usage: node scripts/sync-lx-sdk.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const src = path.join(ROOT, 'lx-music-port', 'dist', 'lx-sdk.js');
const dst = path.join(ROOT, 'plugin', 'js', 'lx-sdk.js');

if (!fs.existsSync(src)) {
  console.error('missing ' + src + '（请先执行 lx-pen/lx-music-port: node tools/build.js）');
  process.exit(1);
}
fs.copyFileSync(src, dst);
const sha = crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex').slice(0, 16);
console.log('synced: ' + dst);
console.log('sha256: ' + sha);
