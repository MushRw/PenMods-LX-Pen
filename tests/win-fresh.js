'use strict';
/*
 * Windows 真机音源验证：加载音源脚本 -> 搜索 -> 取音乐 URL。
 * Usage: node tests/win-fresh.js <script.js> [keyword] [platform]
 * 走真实网络（酷我/酷狗等官方接口），不发任何本地 mock。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = 'E:/code/youdao/lx-pen';
const scriptPath = path.resolve(process.argv[2] || path.join(ROOT, 'plugin/scripts/lx-source.js'));
const keyword = process.argv[3] || '周杰伦';
const platform = process.argv[4] || 'kw';

if (!fs.existsSync(scriptPath)) { console.log('脚本不存在:', scriptPath); process.exit(1); }

const child = spawn(path.join(ROOT, 'runner/penmusic-win.exe'), [
  '--script', scriptPath,
  '--js-dir', path.join(ROOT, 'plugin/js'),
  '--in', '-', '--out', '-',
], { stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
let seq = 0;
const pending = new Map();
let finished = false;
let tested = 0;

const timer = setTimeout(() => { console.log('=> 总超时'); done(); }, 120000);

function send(req) {
  const id = ++seq;
  return new Promise(resolve => {
    pending.set(String(id), resolve);
    child.stdin.write(JSON.stringify(Object.assign({ id, respPath: '/tmp/win_fresh_' + id + '.json' }, req)) + '\n');
  });
}

function done() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  setTimeout(() => { try { child.kill(); } catch (e) {} process.exit(0); }, 150);
}

let firstSong = null;

child.stdout.on('data', d => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg);
  }
});
child.stderr.on('data', d => console.log('[stderr]', d.toString('utf8').trim().slice(0, 300)));
child.on('exit', c => { console.log('runner exit', c); done(); });

async function handle(msg) {
  if (msg.event === 'log') {
    if (msg.level !== 'debug') console.log('[log]', String(msg.text).slice(0, 300));
    return;
  }
  if (msg.event === 'inited') {
    const sources = (msg.data && msg.data.sources) || {};
    const names = Object.keys(sources);
    console.log('INITED 平台:', names.map(n => n + '[' + (sources[n].qualitys || []).join('/') + ']').join(' '));
    if (!names.includes(platform)) { console.log('=> 脚本不支持平台', platform); return done(); }
    console.log('== 搜索:', platform, keyword);
    const res = await send({ cmd: 'search', platform, keyword, page: 1, limit: 5 });
    if (!res || !res.ok) { console.log('=> 搜索失败:', res && res.error); return done(); }
    const list = (res.data && res.data.list) || [];
    console.log('=> 搜索到', list.length, '首');
    if (!list.length) return done();
    firstSong = list[0];
    console.log('   第一首:', firstSong.name, '-', firstSong.singer, '| songmid=', firstSong.songmid, '| interval=', firstSong.interval);
    for (const q of ['128k', '320k']) {
      console.log('== 取 URL:', q);
      const r = await send({ cmd: 'script', source: platform, action: 'musicUrl', info: { type: q, musicInfo: firstSong } });
      if (r && r.ok) {
        console.log('=> ' + q + ' OK:', String(r.data).slice(0, 150));
        // 抽验能否真的下载（前 1KB）
        const dl = await send({ cmd: 'download', url: r.data, path: 'C:/temp/lxp_probe_' + q + '.mp3' });
        console.log('=> ' + q + ' 下载:', dl && dl.ok ? ('OK ' + dl.data.size + ' bytes') : ('FAIL ' + (dl && dl.error)));
        tested++;
      } else {
        console.log('=> ' + q + ' FAIL:', r && r.error);
      }
    }
    return done();
  }
  if (msg.event === 'initFailed') { console.log('INIT FAIL:', msg.error); return done(); }
  if (msg.id && pending.has(String(msg.id))) {
    const resolve = pending.get(String(msg.id));
    pending.delete(String(msg.id));
    resolve(msg);
  }
}
