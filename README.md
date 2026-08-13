# LX Pen — 有道词典笔五源音乐插件

> 本项目代码全部由 DeepSeek 负责开发。

面向有道词典笔 YDP02X（aarch64 / glibc 2.27 / 320×170 深色屏）的音乐插件。
数据层完整移植 [LX Music](https://github.com/lyswhut/lx-music-desktop)（桌面/移动版）的
musicSdk 与歌词实现；播放交给宿主系统播放器（`YMediaManager::playAudio`），支持
在线直连 + 后台缓存（LRU 10 首）与本地下载。

## 功能

- 五源搜索（酷我 / 酷狗 / 咪咕 / 网易云 / QQ），歌词（含翻译）、封面；
- 点歌即用宿主系统播放器播放：播放页、悬浮球、后台续播、上一首/下一首全部复用系统 UI；
- 自动连播：歌曲播完后由宿主播放器自身逻辑驱动，插件只负责把队列推进到下一首；
- 搜索结果行 `↓` 下载到 `/userdisk/Music/LX-Pen/`（文件管理可见），下载页可播放/删除，记录持久化；
- 播放队列与当前索引持久化，重开插件页面自动恢复上下文（不打断播放、不重启 runner）；
- 页面关闭且播放已停止时自动回收后台 runner；停止播放并退出即时回收。

## 架构

```text
lx-pen/
├── plugin/                  # 安装到 /userdisk/PenMods/plugins/lx-pen/
│   ├── metadata.json        # 插件清单（main_qml + main_so）
│   ├── liblxpen_player.so   # 宿主播放器接管组件（钩子 + 队列 + 连播 + 缓存）
│   ├── qml/                 # UI：首页（搜索/下载入口/设置）/ 下载页 / 设置页
│   ├── js/                  # 数据层
│   │   ├── lx-sdk.js        #   lx-music-port 打包产物（五源数据层，勿手改）
│   │   ├── lx-shim.js       #   lx 音源脚本协议 v2.0.0 shim + Node 兼容层
│   │   ├── normalize.js     #   lx 结果 -> 插件字段归一化
│   │   └── runtime.js       #   FIFO JSON-RPC 桥（search/lyric/download/script...）
│   ├── scripts/             # 用户音源脚本（当前仅酷我 lx-source.js 实测可用）
│   ├── gconv/               # GB18030/GBK iconv 模块（酷我歌词解码用）
│   └── bin/penmusic         # QuickJS runner（aarch64 交叉编译）
├── player/                  # lxpen_player.cpp -> liblxpen_player.so（宿主播放器接管）
├── runner/                  # penmusic.c + quickjs + build.sh
├── lx-music-port/           # lx-music 数据层移植 + 垫片（tools/build.js 打包成 lx-sdk.js）
└── tests/                   # runner 级测试（canned / 真网 / 设备链路）
```

### 播放链路

1. QML 点歌 → SO `setQueue + playIndex` → runner 经音源脚本取 `musicUrl` → 歌词 → 缓存命中/在线直连；
2. SO 按 MusicPlayer 调用序列把媒体实体交给宿主 `playAudio`，宿主负责出声、播放页、悬浮球；
3. 宿主上一首/下一首按钮与"播完自动下一首"均经宿主 `onClickedNext/Prev`、`onSoundEnd` 事件回流到 SO，
   由 SO 推进插件队列；`onSoundEnd` 按会话号（`seq==m_ourSeq`）+ 8 秒防误触过滤误触发；
4. 页面关闭：播放中保留 runner 与 SO（后台续播、自动连播继续）；已停止则数秒内回收 runner 并释放音频锁；
5. 重开页面：只重连 runner（不重启、不打断播放），并从持久化的队列/索引恢复上一首/下一首与连播上下文。

## 构建与测试

```shell
# 1. 数据层（仓库根目录）
cd lx-music-port && node tools/build.js && node tools/smoke.js

# 2. 同步 + runner 级回归
cd .. && node scripts/sync-lx-sdk.js
node tests/runner-test.js          # canned RPC（无需网络）
python tests/win-test.py           # Windows 端 runner 真网冒烟（可选）

# 3. 交叉编译（aarch64，设备用；或直接走 GitHub Actions）
cd runner && ./build.sh            # 需要 aarch64-linux-gnu-gcc 6.5.0
sh player/build-player.sh          # 需要 aarch64 Qt 5.15.2（QTDIR）

# 4. 打包
python3 scripts/package.py
```

GitHub Actions（`.github/workflows/build.yml`）在 push/tag 时自动完成：
aarch64 工具链（glibc 2.27）→ 数据层 → runner → `liblxpen_player.so` → 打包；
tag `v*` 会自动发布 Release（产物 `lx-pen.zip`）。

## 部署

1. 解压 `lx-pen.zip`，把 `lx-pen/` 放到词典笔 `/userdisk/PenMods/plugins/`；
2. `chmod +x /userdisk/PenMods/plugins/lx-pen/bin/penmusic`；
3. 清理 QML 缓存：`rm -rf /.cache/NeteaseYoudao/YoudaoDictPen/qmlcache` 后重启 App（守护进程会自动拉起）；
4. 插件管理器启用「LX Pen」，设置页确认音源脚本为 `lx-source.js`。

## RPC 接口（runner）

`search / lyric / pic / cover / script(musicUrl) / download / ping / leaderboard / songlist / hotsearch`

## 已知限制

- **音源**：当前提供酷我音源脚本（`lx-source.js`，搜索、320k 完整版、歌词、下载全通）；
  音源脚本由用户提供，放入 `scripts/` 后可在设置页选择。
- **自动连播依赖宿主**：播完自动切歌由宿主播放器的 `onSoundEnd → onClickedNext` 机制驱动，
  插件只负责推进队列；若宿主行为变化，连播可能失效（8 秒防误触与会话号校验已尽量兼容）。
- **歌词**：酷我歌词走原生 glibc iconv（GB18030），插件自带 gconv 模块到 `/tmp/gconv`；
  Windows 开发版 runner 无完整 iconv/curl，仅用于逻辑测试。
- **页面关闭后的 runner 回收**：播放中退出 → runner 保留（后台续播需要）；停止播放并退出 → 数秒内回收；
  若页面关闭且**暂停超过 10 分钟**，runner 会空闲退出，此后从悬浮球直接切歌会失败（重开插件页面即恢复）。
- **热搜 / 榜单 / 歌单**：RPC 数据层已实现并通过测试，首页 UI 入口目前为占位（Toast「开发中」）。
- **下载**：保存到 `/userdisk/Music/LX-Pen/`；文件名由「歌名-歌手」生成，重名会覆盖；
  下载列表上限 50 条（超出只裁记录，文件仍留在磁盘）。
- **UI**：320×170 深色布局（对齐 YColors）；触摸热区最小 24px；
  系统播放器自带控件未做定制，部分按钮（如播放列表）对单曲队列无实际作用。
- **平台**：目标为 YDP02X（aarch64 / glibc 2.27）；其他机型/固件未验证。

## 许可证

lx-music 代码保留 Apache-2.0 / MIT 出处声明；插件本体 GPL-3.0（与 PenMods 生态一致）。
