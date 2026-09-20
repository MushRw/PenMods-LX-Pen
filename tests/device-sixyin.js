'use strict';
/* 设备端真网验证 sixyin.js：kw/tx 搜索 + musicUrl */
const { execSync } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function adb(cmd) { return execSync('adb shell ' + JSON.stringify(cmd), { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }); }

async function rpc(inF, req, timeoutMs) {
  const p = '/tmp/lxp_r_' + req.id + '.json';
  adb('rm -f ' + p);
  const b64 = Buffer.from(JSON.stringify(Object.assign({ respPath: p }, req)), 'utf8').toString('base64');
  adb('echo ' + b64 + ' | base64 -d > ' + inF + '; echo > ' + inF);
  let resp = '';
  for (let i = 0; i < timeoutMs / 1000; i++) {
    await sleep(1000);
    resp = adb('cat ' + p + ' 2>/dev/null').trim();
    if (resp) break;
  }
  try { return JSON.parse(resp); } catch (e) { return { ok: false, error: resp.slice(0, 120) }; }
}

(async () => {
  const inF = '/tmp/lxp_in', outF = '/tmp/lxp_out';
  adb('pkill -9 -f "bin/penmusic"; rm -f ' + inF + ' ' + outF + '; mkfifo ' + inF + '; touch ' + outF + '; true');
  adb('nohup /userdisk/PenMods/plugins/lx-pen/bin/penmusic --script /userdisk/PenMods/plugins/lx-pen/scripts/sixyin.js --js-dir /userdisk/PenMods/plugins/lx-pen/js --in ' + inF + ' --out ' + outF + ' > /tmp/lxp_err.log 2>&1 & sleep 1; echo ok');
  await sleep(8000);

  for (const platform of ['kw', 'tx', 'kg']) {
    const s = await rpc(inF, { id: 100, cmd: 'search', platform, keyword: '海阔天空', page: 1, limit: 3 }, 25000);
    const list = s.ok ? (s.data.list || []) : [];
    console.log('[' + platform + '] search ok=' + s.ok + ' count=' + list.length + (s.ok ? '' : ' err=' + s.error));
    if (!list.length) continue;
    const song = list[0];
    console.log('  first:', song.name, '|', song.singer, '| songmid:', song.songmid, '| hash:', JSON.stringify(song.hash));
    const u = await rpc(inF, { id: 200, cmd: 'script', source: platform, action: 'musicUrl', info: { type: '128k', musicInfo: song } }, 25000);
    console.log('  musicUrl ok=' + u.ok + (u.ok ? ' url=' + String(u.data).slice(0, 90) : ' err=' + u.error));
  }
  adb('pkill -9 -f "bin/penmusic"; true');
  process.exit(0);
})();
