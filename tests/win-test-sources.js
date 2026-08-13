'use strict';
/* Windows runner 真实网络批量测试音源：加载 -> kw musicUrl(免费歌) */
const { spawn } = require('child_process');
const path = require('path');
const ROOT = 'E:/code/youdao/lx-pen';

function testSource(name, scriptRel) {
  return new Promise(resolve => {
    const child = spawn(path.join(ROOT, 'runner/penmusic-win.exe'), [
      '--script', path.join(ROOT, scriptRel),
      '--js-dir', path.join(ROOT, 'plugin/js'),
      '--in', '-', '--out', '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let seq = 0;
    const pending = new Map();
    let inited = false;
    const timeout = setTimeout(() => { console.log(name, '=> TIMEOUT'); child.kill(); resolve(); }, 60000);
    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.event === 'inited' && !inited) {
          inited = true;
          console.log(name, 'INITED', Object.keys(msg.data.sources).join(','));
          const reqId = ++seq;
          pending.set(String(reqId), { resolve: () => {} });
          child.stdin.write(JSON.stringify({ id: reqId, cmd: 'script', source: 'kw', action: 'musicUrl', info: { type: '128k', musicInfo: { songmid: '397242799' } } }) + '\n');
          setTimeout(() => {
            if (pending.has(String(reqId))) { pending.delete(String(reqId)); console.log(name, '=> musicUrl TIMEOUT'); cleanup(); }
          }, 55000);
        } else if (msg.event === 'initFailed') {
          clearTimeout(timeout);
          console.log(name, 'INIT FAIL:', msg.error);
          cleanup();
        } else if (msg.id && pending.has(String(msg.id))) {
          pending.delete(String(msg.id));
          clearTimeout(timeout);
          const url = msg.ok ? String(msg.data) : ('FAIL ' + msg.error);
          console.log(name, '=>', url.slice(0, 120));
          cleanup();
        } else if (msg.event === 'log' && msg.level === 'log' && /failed|Error|pay/i.test(msg.text)) {
          console.log(name, 'log:', msg.text.slice(0, 100));
        } else if (msg.event === 'log' && msg.level === 'debug') {
          console.log(name, 'dbg:', msg.text);
        }
      }
    });
    child.stderr.on('data', () => {});
    child.on('exit', () => { clearTimeout(timeout); resolve(); });
    function cleanup() { try { child.kill(); } catch (e) {} }
  });
}

(async () => {
  await testSource('lx', 'tests/sources/lx.js');
  process.exit(0);
})();
