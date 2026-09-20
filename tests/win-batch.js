'use strict';
/*
 * 批量验证音源脚本（Windows runner + 真实网络）。
 * Usage: node tests/win-batch.js <dir-with-js> [keyword] [platform]
 * 每个脚本：加载 -> 搜索 -> 取 128k/320k URL，输出一行结论。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = 'E:/code/youdao/lx-pen';
const dir = path.resolve(process.argv[2] || path.join(ROOT, 'plugin/scripts'));
const keyword = process.argv[3] || '周杰伦';
const platform = process.argv[4] || 'kw';
const files = fs.readdirSync(dir).filter(f => /\.js$/i.test(f)).sort();

function testOne(file) {
  return new Promise(resolve => {
    const out = { file, platforms: '', search: '-', q: {} };
    const t0 = Date.now();
    const child = spawn(path.join(ROOT, 'runner/penmusic-win.exe'), [
      '--script', path.join(dir, file),
      '--js-dir', path.join(ROOT, 'plugin/js'),
      '--in', '-', '--out', '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let seq = 0;
    const pending = new Map();
    let settled = false;
    const timer = setTimeout(() => finish('超时'), 45000);

    function finish(note) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.took = ((Date.now() - t0) / 1000).toFixed(1) + 's';
      if (note) out.search = out.search + ' ' + note;
      try { child.kill(); } catch (e) {}
      resolve(out);
    }
    function send(req) {
      const id = ++seq;
      return new Promise(res => { pending.set(String(id), res); child.stdin.write(JSON.stringify(Object.assign({ id }, req)) + '\n'); });
    }

    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        handle(msg);
      }
    });
    child.stderr.on('data', () => {});
    child.on('exit', () => finish(null));

    async function handle(msg) {
      if (msg.event === 'log') return;
      if (msg.event === 'initFailed') { out.platforms = 'INIT FAIL: ' + String(msg.error).slice(0, 60); return finish(null); }
      if (msg.event === 'inited') {
        const s = (msg.data && msg.data.sources) || {};
        out.platforms = Object.keys(s).map(n => n + (s[n].qualitys ? '[' + s[n].qualitys.join('/') + ']' : '')).join(' ');
        if (!s[platform]) { out.search = '不支持 ' + platform; return finish(null); }
        const r = await send({ cmd: 'search', platform, keyword, page: 1, limit: 5 });
        if (!r || !r.ok) { out.search = '搜索失败: ' + (r && r.error); return finish(null); }
        const list = (r.data && r.data.list) || [];
        out.search = list.length + ' 首';
        if (!list.length) return finish(null);
        const song = list[0];
        out.song = song.name + '-' + song.singer;
        for (const q of ['128k', '320k']) {
          const rr = await send({ cmd: 'script', source: platform, action: 'musicUrl', info: { type: q, musicInfo: song } });
          out.q[q] = rr && rr.ok ? String(rr.data).replace(/^https?:\/\//, '').slice(0, 70) : ('FAIL:' + (rr && rr.error));
        }
        return finish(null);
      }
      if (msg.id && pending.has(String(msg.id))) {
        const res = pending.get(String(msg.id));
        pending.delete(String(msg.id));
        res(msg);
      }
    }
  });
}

(async () => {
  console.log('批量测试目录:', dir, '| 关键字:', keyword, '| 平台:', platform);
  for (const f of files) {
    const r = await testOne(f);
    console.log('\n=== ' + r.file + ' (' + r.took + ')');
    console.log('    平台: ' + (r.platforms || '(无)'));
    console.log('    搜索: ' + r.search + (r.song ? ' | 首曲: ' + r.song : ''));
    for (const q of Object.keys(r.q)) console.log('    ' + q + ': ' + r.q[q]);
  }
  process.exit(0);
})();
