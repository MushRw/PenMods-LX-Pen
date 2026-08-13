# LX Pen — 有道词典笔五源音乐插件

基于 [LX Music](https://github.com/lyswhut/lx-music-desktop)（桌面/移动版）数据层从零重写的
PenMods 插件：酷我 / 酷狗 / 咪咕 / 网易云 / QQ 五源搜索、歌词、封面；播放交给宿主系统播放器
（`YMediaManager::playAudio`），支持在线直连 + 后台缓存（LRU 10 首）与本地下载。

## 结构

```text
lx-pen/
├── plugin/                 # 安装到 /userdisk/PenMods/plugins/lx-pen/
│   ├── metadata.json
│   ├── icon.png
│   ├── qml/                # UI（320×170，深色主题对齐 YColors）
│   ├── js/
│   │   ├── lx-shim.js      # lx 音源脚本协议 v2.0.0（源自 lx-music-mobile）
│   │   ├── lx-sdk.js       # lx-music-port 打包产物（五源数据层，勿手改）
│   │   ├── normalize.js    # lx 结果 -> QML 字段归一化
│   │   └── runtime.js      # FIFO JSON-RPC 桥（直连 __lxSdk）
│   ├── scripts/            # 用户音源脚本（musicUrl 解析）
│   └── bin/penmusic        # runner（aarch64 交叉编译）
├── lx-music-port/          # 数据层（lx-music-desktop/mobile 移植 + 垫片 + 补丁）
│   ├── port/               #   Buffer/crypto/http/zlib/iconv 垫片与歌词实现
│   ├── vendor/             #   lx-music 原文件（只读参考）
│   └── tools/              #   build.js（打包成 dist/lx-sdk.js）+ smoke.js
├── runner/                 # penmusic.c + quickjs + build.sh（aarch64）
├── scripts/                # sync-lx-sdk.js / package.py
└── tests/                  # runner-test.js（canned）/ live-test.js（真网）
```

数据层代码在本仓库子目录 `lx-music-port/`（lx-music-desktop musicSdk 移植 + 垫片 + 补丁），
通过 `node scripts/sync-lx-sdk.js` 把产物同步到 `plugin/js/lx-sdk.js`。

## 构建与测试

```shell
# 1. 数据层（在 lx-pen 仓库根目录执行）
cd lx-music-port && node tools/build.js && node tools/smoke.js

# 2. 同步 + runner 级测试
cd .. && node scripts/sync-lx-sdk.js
node tests/runner-test.js          # canned RPC（无需网络）
node tests/live-test.js            # 真网五源（需要外网，接口偶发限流）

# 3. 交叉编译 runner（aarch64，设备用）
cd runner && ./build.sh            # 需要 aarch64-linux-gnu-gcc 6.5.0

# 4. 打包
python3 scripts/package.py
```

## 部署

1. 把 `plugin/` 目录整体放到词典笔 `/userdisk/PenMods/plugins/lx-pen/`。
2. 插件管理器里启用「LX Pen」。
3. 音源脚本放到 `scripts/`（自带酷我示例），设置页选择后重启 runner。

## RPC 面

`search / lyric / pic / cover / script(musicUrl) / download / ping / leaderboard / songlist / hotsearch`

## 播放架构

- runner（penmusic）负责解析 `musicUrl` / 歌词 / 下载；宿主系统播放器负责出声与悬浮球后台播放；
- 手动切歌 / 自动连播由宿主播放器事件驱动（`onClickedNext/Prev`、`onSoundEnd`），队列在 SO 内维护；
- 重开插件页面只重连 runner（不重启、不打断播放）；页面关闭且宿主已停止播放时自动回收 runner；
- 搜索结果行 `↓` 下载到文件管理可见的 `/userdisk/Music/LX-Pen/`，下载页可播放 / 删除，记录持久化。

## 已知限制

- 榜单/歌单列表接口受平台限流影响，偶发失败（数据层直连验证通过；UI 入口本轮为占位）。
- 播放 URL 依赖用户音源脚本；酷我示例脚本仅支持 kw。
- 酷我歌词用原生 glibc iconv（GB18030）；Windows 开发版 runner 无 iconv/curl。
- 播放中退出插件后若再手动停止播放，runner 需等待空闲超时（10 分钟）才退出。
- 许可证：lx-music 代码保留 Apache-2.0/MIT 出处；插件本体 GPL-3.0。
