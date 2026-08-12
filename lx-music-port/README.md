# lx-music-port — lx-music-desktop JS 移植包（词典笔 PenMods 用）

从 [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop)（master，v2.12.2）整理出可移植到有道词典笔
YDP02X（PenMods 插件运行时）的 JS 层。目标是让 **搜索 / 歌词 / 封面 / 榜单 / 歌单 / 热搜 / 评论** 等
musicSdk 能力直接跑在 penmusic（QuickJS）runner 里。

> 与桌面版一致：**播放 URL（musicUrl）不由 musicSdk 提供**，而是由"音源脚本"在运行时解析
> （pen 侧对应 PenMods-Music 的 `runtime.js handleScript` + `lx-shim.js`）。

## 目录结构

```text
lx-music-port/
├── vendor/                  # lx-music-desktop 原文件（只读参考，未改动）
│   ├── musicSdk/            #   kw / kg / mg / wy / tx 五源 + options/utils（已剔除 api-test/temp/bd/xm）
│   ├── common/lyricUtils/   #   kg.js（krc 解码）、util.ts
│   ├── renderer/            #   request.js / message.ts / utils-index.ts（参考）
│   ├── main/                #   kw/tx 歌词解码主进程实现（参考）
│   └── userApi/preload.js   #   音源脚本协议 v2.0.0（参考）
├── port/                    # 移植层（pen 运行时可执行）
│   ├── buffer.js            #   Buffer 垫片（utf8/base64/hex/utf16le/binary）
│   ├── crypto.js            #   node:crypto 垫片（md5/sha1/AES-128/ECB/CBC/RSA）
│   ├── zlib.js              #   zlib → 原生 zlib_inflate/deflate
│   ├── http.js              #   needle 风格 httpFetch → 原生 libcurl request
│   ├── common.js            #   纯工具（formatPlayTime/sizeFormate/decodeName/...）
│   ├── stubs.js             #   IPC/apis/dns/requestMsg 占位
│   ├── lyric-util.js        #   util.ts 的 JS 版
│   └── index.js             #   入口，注册 globalThis.__lxSdk
├── dist/lx-sdk.js           # 打包产物（单文件，penmusic 可直接 eval）
└── tools/
    ├── build.js             # 迷你打包器（import/export → CommonJS + 依赖拓扑排序）
    └── smoke.js             # Node 冒烟测试（模拟 __lxinternal 原生层）
```

## 已整理的内容

每个源都导出桌面版同款方法（方法面已在冒烟测试中逐一校验）：

| 源 | 说明 | 主要能力 |
|---|---|---|
| kw 酷我 | 完整 | musicSearch/tipSearch/hotSearch/leaderboard/songList/album/lyric/pic/comment + wbdCrypto 签名 |
| kg 酷狗 | 完整 | musicSearch/hotSearch/leaderboard/songList/singer/album/lyric/pic/comment + infSign H5 签名 |
| mg 咪咕 | 完整 | musicSearch/hotSearch/leaderboard/songList/lyric(含 mrc TEA 解密)/pic/comment |
| wy 网易 | 完整 | musicSearch/tipSearch/hotSearch/leaderboard/songList/singer/lyric/pic/comment + weapi/eapi/linuxapi |
| tx QQ | 完整 | musicSearch/tipSearch/hotSearch/leaderboard/songList/singer/lyric/pic/comment + zzcSign |

公共层：`formatPlayTime / formatPlayTime2 / sizeFormate / dateFormat / dateFormat2 / formatPlayCount /
decodeName / toMD5 / getRandom / isUrl`，以及 krc 歌词解码（`common/lyricUtils/kg.js`）。

## 适配点（桌面 → pen）

| 桌面实现 | 移植处理 |
|---|---|
| `needle`（renderer/utils/request.js） | `port/http.js` 的 `httpFetch`：返回 `{ promise, cancelHttp }`，响应映射为 `{ statusCode, headers, body(自动 JSON 解析), raw }`，底层走 `__lxinternal.request`（libcurl） |
| `node:crypto` | `port/crypto.js`：md5/sha1（纯 JS）、AES-128-ECB/CBC 加解密（解密为纯 JS 实现，PKCS7）、RSA PKCS1 v1.5 走原生、`RSA_NO_PADDING` 用 BigInt 模幂（wy weapi 需要） |
| `Buffer` | `port/buffer.js`：Uint8Array 子类，支持 from/alloc/concat/toString(utf8/base64/hex/utf16le/binary) 等 |
| `zlib` | `port/zlib.js`：回调/Promise 双形态，走原生 `zlib_inflate/deflate`（windowBits=15+32，兼容 zlib/gzip） |
| `@common/ipcNames`、`@common/rendererIpc`（主进程解码） | `port/stubs.js`：占位并抛错（见 TODO） |
| `../api-source`（播放 URL） | 占位抛错——播放 URL 走音源脚本，不经过 musicSdk |
| `dns` | 去掉：libcurl 自行解析域名 |
| `navigator/self`（infSign 加载期引用） | 打包前导注入空垫片 |
| `RegExp.$1`（V8 遗留特性，QuickJS 不支持） | build PATCHES：kw 歌词解析、mg 时长字段改用 exec 捕获组 |
| 原生返回 `ArrayBuffer`（`str_to_bytes`/`b64_to_bytes` 等） | Buffer 垫片 `Buf.from`、crypto `toBytes`、http 的 binary 响应识别统一适配 ArrayBuffer |
| `zlib.deflate` | penmusic 修复为 zlib 格式（windowBits=15），与 `inflate`(15+32) 对称，原实现生成 raw 流自己解不了 |

## 构建与验证

```shell
node tools/build.js   # 重新生成 dist/lx-sdk.js（64 个模块，约 340KB）
node tools/smoke.js   # Node 模拟原生层：方法面 / 加密 / Buffer / httpFetch / kw+kg 搜索端到端
```

产物加载方式：penmusic 在 `lx-shim.js` 之后 `eval_file("dist/lx-sdk.js")`，随后
`globalThis.__lxSdk.kw.musicSearch.search(...)` 等即可用；`__lxSdk.internal` 暴露
`crypto/http/zlib/buffer/stubs` 供 runner 侧直接调用。

## 尚未解决 / 需要额外实现

1. **酷我歌词（桌面实现）**：`kw/lyric.js` 的 `decodeLyric` 走主进程 IPC
   （inflate + `yeelion` XOR + **GB18030 解码**）。当前插件用移动端 JSON 歌词接口规避；
   若改用桌面实现，需提供 GB18030 → UTF-8 解码（原生 iconv 或 JS 码表）。
2. **QQ 歌词（qrc）**：`tx/lyric.js` 依赖桌面自带的专有 `qrc_decode.node` 二进制，
   **词典笔不可用**，需要移植社区 JS 版 QRC 解码算法（已知有开源实现）或暂时跳过 QQ 歌词。
3. **`kg/temp`、`mg/temp`**（新版接口实验代码）未纳入；需要时可单独评估。
4. **接口时效性**：各平台公开接口的 URL/签名参数可能变化，与桌面版同生命周期风险。
5. **性能**：AES 解密、RSA、SHA1 为纯 JS 实现，在笔上单次请求量级很小（可接受）；
   若批量下载场景吃紧，可给 penmusic 补 `aes_decrypt` / `sha1` 原生函数。

## 许可

musicSdk 代码来自 lx-music-desktop（Apache-2.0，含项目补充协议），其逻辑上游为
lx-music-mobile（MIT）。移植/分发请保留对应许可声明。
