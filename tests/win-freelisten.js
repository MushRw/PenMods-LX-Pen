'use strict';
const { spawn } = require('child_process');
const path = require('path');
const ROOT = 'E:/code/youdao/lx-pen';

const child = spawn(path.join(ROOT, 'runner/penmusic-win.exe'), [
  '--script', path.join(ROOT, 'plugin/scripts/freelisten-source.js'),
  '--js-dir', path.join(ROOT, 'plugin/js'),
  '--in', '-', '--out', '-',
], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
let seq = 0;
const pending = new Map();

child.stdout.on('data', d => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.event === 'inited') {
      console.log('INITED sources=', Object.keys(msg.data.sources).join(','));
      run();
    } else if (msg.id && pending.has(String(msg.id))) {
      const { resolve } = pending.get(String(msg.id));
      pending.delete(String(msg.id));
      resolve(msg);
    } else if (msg.event === 'log' && msg.level === 'debug') {
      process.stderr.write(msg.text + '\n');
    }
  }
});
child.stderr.on('data', d => process.stderr.write('[runner] ' + d));
child.on('exit', c => console.log('exit', c));

function rpc(obj) {
  return new Promise(resolve => {
    const id = ++seq;
    pending.set(String(id), { resolve });
    child.stdin.write(JSON.stringify(Object.assign({ id }, obj)) + '\n');
    setTimeout(() => { if (pending.has(String(id))) { pending.delete(String(id)); resolve({ ok: false, error: 'timeout' }); } }, 30000);
  });
}

async function run() {
  /* 先搜索，拿免费歌曲再逐个平台试 */
  const s = await rpc({ cmd: 'search', platform: 'kw', keyword: '两只老虎', page: 1, limit: 5 });
  if (!s.ok) { console.log('SEARCH FAIL', s.error); child.kill(); process.exit(1); }
  const list = s.data.list || [];
  console.log('SEARCH ok count=', list.length, 'first=', list[0] && (list[0].name + ' - ' + list[0].singer));
  for (const song of list.slice(0, 3)) {
    const r = await rpc({ cmd: 'script', source: 'kw', action: 'musicUrl', info: { type: '128k', musicInfo: song } });
    console.log('kw[' + song.songmid + ']:', r.ok ? String(r.data).slice(0, 120) : 'FAIL ' + r.error);
  }
  /* kg 平台 */
  const s2 = await rpc({ cmd: 'search', platform: 'kg', keyword: '两只老虎', page: 1, limit: 3 });
  if (s2.ok && s2.data.list && s2.data.list.length) {
    const song = s2.data.list[0];
    const r = await rpc({ cmd: 'script', source: 'kg', action: 'musicUrl', info: { type: '128k', musicInfo: song } });
    console.log('kg[' + song.songmid + ']:', r.ok ? String(r.data).slice(0, 120) : 'FAIL ' + r.error);
  }
  child.kill();
  process.exit(0);
}
