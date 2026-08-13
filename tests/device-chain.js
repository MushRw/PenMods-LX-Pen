'use strict';
/* 设备完整链路验证：搜索(中文) -> musicUrl -> download */
const { execSync } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function adb(cmd) { return execSync('adb shell ' + JSON.stringify(cmd), { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }); }
(async () => {
  const inF = '/tmp/lxp_in', outF = '/tmp/lxp_out';
  adb('rm -f ' + inF + ' ' + outF + '; mkfifo ' + inF + '; touch ' + outF + '; true');
  adb('nohup /userdisk/PenMods/plugins/lx-pen/bin/penmusic --script /userdisk/PenMods/plugins/lx-pen/scripts/lx-source.js --js-dir /userdisk/PenMods/plugins/lx-pen/js --in ' + inF + ' --out ' + outF + ' > /tmp/lxp_err.log 2>&1 & sleep 1; echo ok');
  await sleep(8000);
  const sp = '/tmp/lxp_s.json';
  adb('rm -f ' + sp);
  const sb64 = Buffer.from(JSON.stringify({ id: 1, respPath: sp, cmd: 'search', platform: 'kw', keyword: '海阔天空', page: 1, limit: 3 }), 'utf8').toString('base64');
  adb('echo ' + sb64 + ' | base64 -d > ' + inF + '; echo > ' + inF);
  await sleep(5000);
  const s = adb('cat ' + sp + ' 2>/dev/null');
  let list;
  try { list = JSON.parse(s).data.list; } catch (e) {}
  if (!list || !list.length) { console.log('search fail:', (s || '').slice(0, 200)); process.exit(0); }
  const song = list[0];
  console.log('首曲:', song.name, '| songmid:', song.songmid, '| hash:', JSON.stringify(song.hash));
  const rp = '/tmp/lxp_r.json';
  adb('rm -f ' + rp);
  const rb64 = Buffer.from(JSON.stringify({ id: 2, respPath: rp, cmd: 'script', source: 'kw', action: 'musicUrl', info: { type: '128k', musicInfo: song } }), 'utf8').toString('base64');
  adb('echo ' + rb64 + ' | base64 -d > ' + inF + '; echo > ' + inF);
  await sleep(10000);
  const r = adb('cat ' + rp + ' 2>/dev/null');
  let url;
  try { url = JSON.parse(r).data; } catch (e) {}
  console.log('musicUrl:', url ? url.slice(0, 100) : (r || '').slice(0, 150));
  if (!url) process.exit(0);
  const dp = '/tmp/lxp_d.json';
  adb('rm -f ' + dp + ' /tmp/lxp_dl.mp3');
  const db64 = Buffer.from(JSON.stringify({ id: 3, respPath: dp, cmd: 'download', url, path: '/tmp/lxp_dl.mp3' }), 'utf8').toString('base64');
  const t0 = Date.now();
  adb('echo ' + db64 + ' | base64 -d > ' + inF + '; echo > ' + inF);
  let resp = '';
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    resp = adb('cat ' + dp + ' 2>/dev/null').trim();
    if (resp) break;
  }
  console.log('download (' + ((Date.now() - t0) / 1000).toFixed(1) + 's):', resp.slice(0, 100));
  console.log('file:', adb('ls -la /tmp/lxp_dl.mp3 2>/dev/null'));
  adb('pkill -9 -f "bin/penmusic"; rm -f /tmp/lxp_in /tmp/lxp_out /tmp/lxp_*.json /tmp/lxp_dl.mp3; true');
  process.exit(0);
})();
