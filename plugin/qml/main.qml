import QtQuick 2.12
import QtQuick.LocalStorage 2.12
import "pages"
import "components"
import "."

Rectangle {
    id: root
    width: 320
    height: 170
    color: Theme.bg

    signal backButtonClicked()

    /* ---------- 运行时常量 ---------- */
    readonly property string pluginDir: "/userdisk/PenMods/plugins/lx-pen"
    readonly property string inFifo:    "/tmp/lxpen_in"
    readonly property string outFile:   "/tmp/lxpen_out.log"
    readonly property string mpvSock:   "/tmp/lxpen.sock"

    /* ---------- 状态 ---------- */
    property string page: "home"        // home | player | settings
    property string platform: "kw"
    property string keyword: ""
    property var searchResult: []
    property bool searching: false
    property var searchHistory: []

    property var currentSong: null
    property var queue: []
    property int queueIndex: -1
    property bool playing: false
    property bool paused: true
    property double timePos: 0
    property double duration: 0
    property int volume: 80
    property string coverPath: ""
    property var lyricData: null

    property string mpvPath: "/userdisk/mpv/mpv"
    property string quality: "320k"
    property var scriptList: []
    property string selectedScript: "lx-source.js"
    property var scriptSources: ({})
    property bool scriptReady: false
    property string scriptError: ""
    property var logLines: []

    property bool runnerStarting: false
    property bool destroying: false
    property int readOffset: 0
    property string pendingOut: ""
    property int pingFail: 0

    function srcName(s) {
        if (s === "kw") return "酷我"
        if (s === "kg") return "酷狗"
        if (s === "mg") return "咪咕"
        if (s === "wy") return "网易"
        if (s === "tx") return "QQ"
        return s
    }

    function fmtTime(sec) {
        if (sec === undefined || sec === null || isNaN(sec) || sec < 0) return "00:00"
        var m = Math.floor(sec / 60)
        var s = Math.floor(sec % 60)
        return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s
    }

    /* ---------- base64 ---------- */
    function utf8Bytes(str) {
        var out = []
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i)
            if (c < 0x80) out.push(c)
            else if (c < 0x800) {
                out.push(0xC0 | (c >> 6))
                out.push(0x80 | (c & 63))
            } else {
                out.push(0xE0 | (c >> 12))
                out.push(0x80 | ((c >> 6) & 63))
                out.push(0x80 | (c & 63))
            }
        }
        return out
    }

    function b64Encode(str) {
        var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        var bytes = utf8Bytes(str)
        var out = ""
        for (var i = 0; i < bytes.length; i += 3) {
            var b0 = bytes[i]
            var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
            var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
            var v = (b0 << 16) | (b1 << 8) | b2
            out += chars.charAt((v >> 18) & 63) + chars.charAt((v >> 12) & 63)
            out += i + 1 < bytes.length ? chars.charAt((v >> 6) & 63) : "="
            out += i + 2 < bytes.length ? chars.charAt(v & 63) : "="
        }
        return out
    }

    /* ---------- 持久化 ---------- */
    function loadSettings() {
        try {
            var db = LocalStorage.openDatabaseSync("lxpen", "1.0", "LX Pen", 100000)
            db.transaction(function(tx) {
                tx.executeSql("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")
                var rs = tx.executeSql("SELECT value FROM kv WHERE key='platform'")
                if (rs.rows.length) platform = rs.rows.item(0).value
                rs = tx.executeSql("SELECT value FROM kv WHERE key='quality'")
                if (rs.rows.length) {
                    quality = rs.rows.item(0).value
                    if (quality === "128k") quality = "320k"
                }
                rs = tx.executeSql("SELECT value FROM kv WHERE key='mpv'")
                if (rs.rows.length) mpvPath = rs.rows.item(0).value
                rs = tx.executeSql("SELECT value FROM kv WHERE key='script'")
                if (rs.rows.length) selectedScript = rs.rows.item(0).value
                rs = tx.executeSql("SELECT value FROM kv WHERE key='history'")
                if (rs.rows.length) {
                    try { searchHistory = JSON.parse(rs.rows.item(0).value) || [] } catch (e) { searchHistory = [] }
                }
            })
        } catch (e) { console.warn("loadSettings", e) }
    }

    function saveSettings() {
        try {
            var db = LocalStorage.openDatabaseSync("lxpen", "1.0", "LX Pen", 100000)
            db.transaction(function(tx) {
                tx.executeSql("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")
                tx.executeSql("INSERT OR REPLACE INTO kv VALUES('platform',?)", [platform])
                tx.executeSql("INSERT OR REPLACE INTO kv VALUES('quality',?)", [quality])
                tx.executeSql("INSERT OR REPLACE INTO kv VALUES('mpv',?)", [mpvPath])
                tx.executeSql("INSERT OR REPLACE INTO kv VALUES('script',?)", [selectedScript])
                tx.executeSql("INSERT OR REPLACE INTO kv VALUES('history',?)", [JSON.stringify(searchHistory)])
            })
        } catch (e) { console.warn("saveSettings", e) }
    }

    /* ---------- RPC ---------- */
    property var pending: ({})
    property int rpcSeq: 0

    function pushLog(level, text) {
        logLines.push("[" + level + "] " + text)
        if (logLines.length > 30) logLines.shift()
    }

    /* 临时调试：记录 UI 点击，便于远程确认触摸事件是否送达 */
    function touchDebug(tag) {
        shell.exec("echo '" + tag + "' >> /tmp/lxpen_touch.log")
    }

    function rpcSend(cmdObj, cb, timeoutMs) {
        if (destroying) return
        if (runnerStarting) {
            if (cb) cb({ ok: false, error: "starting" })
            return
        }
        var id = ++rpcSeq
        cmdObj.id = id
        var timer = Qt.createQmlObject("import QtQuick 2.12; Timer { interval: 1; repeat: false }", root)
        timer.interval = timeoutMs === undefined ? 30000 : timeoutMs
        timer.triggered.connect(function() {
            var e = pending["" + id]
            if (e) {
                delete pending["" + id]
                if (e.cb) e.cb({ ok: false, error: "timeout" })
            }
            timer.destroy()
        })
        pending["" + id] = { cb: cb, timer: timer }
        timer.start()
        var b64 = b64Encode(JSON.stringify(cmdObj))
        // 同步写入（带 1s 超时，避免 runner 不在时阻塞 UI），base64 解码后的 JSON 与结尾换行都写入 FIFO
        shell.exec("timeout 1 sh -c \"echo '" + b64 + "' | base64 -d > " + inFifo + "; echo > " + inFifo + "\"")
    }

    function onLine(line) {
        line = line.replace(/\r/g, "")
        if (!line) return
        var msg
        try { msg = JSON.parse(line) } catch (e) { return }
        if (msg.id !== undefined && msg.id !== null) {
            var e = pending["" + msg.id]
            if (e) {
                delete pending["" + msg.id]
                if (e.timer) e.timer.destroy()
                if (e.cb) e.cb(msg)
            }
            return
        }
        if (msg.event === "inited") {
            scriptSources = (msg.data && msg.data.sources) || {}
            scriptReady = true
            scriptError = ""
            pushLog("info", "音源脚本就绪: " + Object.keys(scriptSources).join(","))
            toast.show("音源就绪", 1500)
        } else if (msg.event === "initFailed") {
            scriptReady = false
            scriptError = msg.error || "脚本初始化失败"
            pushLog("error", scriptError)
            toast.show(scriptError, 4000)
        } else if (msg.event === "status") {
            applyStatus(msg)
        } else if (msg.event === "log") {
            pushLog(msg.level || "log", msg.text || "")
        }
    }

    function byteLen(s) {
        if (!s) return 0
        var esc = encodeURIComponent(s)
        var pct = 0
        for (var i = 0; i < esc.length; i++) {
            if (esc.charAt(i) === "%") pct++
        }
        return esc.length - pct * 2
    }

    /* 轮询 runner 输出文件（不用长驻 cat 进程，避免宿主 execAsync 超时强杀导致闪退） */
    function pollOut() {
        if (destroying || !root.visible) return
        // 用 execWithResult 拿未 trim 的原始 stdout，保证末尾换行与字节偏移精确（shell.exec 会 trim，导致最后一行被误判为半行而错位）
        var res = shell.execWithResult("tail -c +" + (readOffset + 1) + " '" + outFile + "' 2>/dev/null; true")
        if (!res || !res.stdout) {
            // 文件可能被 runner 重启重建：若文件大小小于偏移则重置
            var sz = shell.exec("wc -c < '" + outFile + "' 2>/dev/null; true")
            var n = parseInt(sz, 10)
            if (!isNaN(n) && n < readOffset) {
                readOffset = 0
                pendingOut = ""
            }
            return
        }
        var data = res.stdout
        if (data.length === 0) return
        readOffset += byteLen(data)
        if (pendingOut.length > 0) {
            data = pendingOut + data
            pendingOut = ""
        }
        var lines = data.split("\n")
        pendingOut = lines.pop()
        for (var i = 0; i < lines.length; i++) onLine(lines[i])
    }

    function applyStatus(st) {
        if (st.state === "playing") {
            playing = true
            paused = false
        } else if (st.state === "paused") {
            paused = true
        } else if (st.state === "stopped" || st.state === "ended") {
            playing = false
            paused = true
        }
        if (st.timePos !== undefined && st.timePos !== null) timePos = st.timePos
        if (st.duration !== undefined && st.duration !== null && st.duration >= 0) duration = st.duration
        updateLyricPosition()
    }

    function startFreshRunner() {
        // 音源脚本不存在时回退默认（防止旧设置引用已删脚本导致 runner 起不来）
        if (scriptList.length > 0) {
            var ok = false
            for (var k = 0; k < scriptList.length; k++) {
                if (scriptList[k].file === selectedScript) { ok = true; break }
            }
            if (!ok) {
                selectedScript = "lx-source.js"
                saveSettings()
            }
        }
        // 全新启动（先确保无残留 runner）；注意 busybox pkill/pgrep 不支持 -x，
        // 且不能用 -f（会匹配到执行命令的 shell 自身导致自杀），用普通 pkill 按进程名匹配
        // 词典笔缺 gconv 模块，先铺 GB18030 到 /tmp/gconv 并设 GCONV_PATH（否则 kw 歌词 iconv 失败）
        shell.exec("mkdir -p /tmp/gconv; cp -f '" + pluginDir + "/gconv/GB18030.so' '" + pluginDir + "/gconv/GBK.so' '" + pluginDir + "/gconv/gconv-modules' /tmp/gconv/ 2>/dev/null; true")
        shell.exec("pkill -9 penmusic 2>/dev/null; sleep 1; rm -f " + inFifo + " " + outFile + " " + mpvSock + "; mkfifo " + inFifo + "; touch " + outFile + "; true")
        var script = String(selectedScript).replace(/[^A-Za-z0-9_.-]/g, "")
        var cmd = "GCONV_PATH=/tmp/gconv nohup " + pluginDir + "/bin/penmusic --script '" + pluginDir + "/scripts/" + script +
                  "' --js-dir '" + pluginDir + "/js' --in " + inFifo + " --out " + outFile +
                  " > /tmp/lxpen.log 2>&1 &"
        shell.startDetached(cmd)
        readOffset = 0
        pendingOut = ""
    }

    function startRunner() {
        if (runnerStarting) return
        runnerStarting = true
        scriptReady = false
        readOffset = 0
        pendingOut = ""
        // 后台播放：若已有 runner 在跑（关页面不杀），直接重连，从输出文件尾部开始读；
        // 重连 ping 失败（runner 僵死）则强杀后全新启动
        var alive = shell.exec("pgrep penmusic >/dev/null 2>&1 && echo 1 || echo 0").trim()
        if (alive === "1") {
            var sz = shell.exec("wc -c < '" + outFile + "' 2>/dev/null; true").trim()
            var n = parseInt(sz, 10)
            readOffset = (isNaN(n) || n < 0) ? 0 : n
            rpcSend({ cmd: "ping" }, function(res) {
                if (res.ok) {
                    scriptReady = true
                    scriptError = ""
                    pushLog("info", "已重连后台 runner")
                } else {
                    pushLog("warn", "重连后台 runner 失败，全新启动")
                    startFreshRunner()
                }
            }, 3000)
        } else {
            startFreshRunner()
        }
        pollTimer.start()
        watchdog.restart()
        runnerStarting = false
    }

    function stopRunner() {
        if (!destroying) rpcSend({ cmd: "quit" }, null, 2000)
        // 显式停止：杀 runner 与 mpv（mpv 包装脚本退出后唤醒锁由 AudioDaemon 自动释放）
        shell.exec("pkill -9 penmusic 2>/dev/null; pkill -9 mpv 2>/dev/null; true")
        scriptReady = false
    }

    function restartRunner() {
        stopRunner()
        Qt.callLater(startRunner)
    }

    function pingRunner() {
        if (!scriptReady && !scriptError) return
        rpcSend({ cmd: "ping" }, function(res) {
            if (!res.ok) pingFail++
            else pingFail = 0
            if (pingFail >= 3) {
                pingFail = 0
                pushLog("warn", "runner 无响应，重启")
                restartRunner()
            }
        }, 5000)
    }

    /* ---------- 搜索 / 播放 ---------- */
    function doSearch() {
        if (!keyword) return
        searching = true
        rpcSend({ cmd: "search", platform: platform, keyword: keyword, page: 1 }, function(res) {
            searching = false
            if (res.ok) {
                addHistory(keyword)
                searchResult = res.data.list
                queue = res.data.list
                queueIndex = -1
            } else {
                toast.show(res.error, 3000)
            }
        })
    }

    function addHistory(kw) {
        kw = String(kw || "").trim()
        if (!kw) return
        var list = searchHistory.slice()
        var idx = list.indexOf(kw)
        if (idx >= 0) list.splice(idx, 1)
        list.unshift(kw)
        if (list.length > 15) list.length = 15
        searchHistory = list
        saveSettings()
    }

    function clearHistory() {
        searchHistory = []
        saveSettings()
    }

    function searchKeyword(kw) {
        if (!kw) return
        keyword = kw
        doSearch()
    }

    function playSong(song, idx) {
        if (!song) return
        currentSong = song
        // 列表点击传入 delegate 的 index（modelData 与 queue 元素引用不一致，indexOf 不可靠）
        if (idx !== undefined && idx >= 0 && idx < queue.length) queueIndex = idx
        else queueIndex = queue.indexOf(song)
        shell.exec("echo 'playSong type=" + (typeof lxpenPlayer) + " idx=" + queueIndex +
                   " has=" + (lxpenPlayer && typeof lxpenPlayer.playIndex) + "' >> /tmp/lxpen_touch.log")
        // 播放/队列/连播全部交给 SO（lxpenPlayer），它不随本页面销毁，回主页后仍能自动连播
        if (typeof lxpenPlayer !== "undefined" && lxpenPlayer && lxpenPlayer.setQueue && lxpenPlayer.playIndex) {
            try {
                lxpenPlayer.setQueue(queue, queueIndex)
                lxpenPlayer.setQuality(quality)
                lxpenPlayer.playIndex(queueIndex)
            } catch (e) {
                shell.exec("echo 'playExc " + e + "' >> /tmp/lxpen_touch.log")
                toast.show("播放调用失败", 3000)
            }
        } else {
            toast.show("播放组件不可用", 3000)
        }
    }

    function playNext() {
        if (queue.length === 0) return
        var idx = queueIndex + 1
        if (idx >= queue.length) idx = 0
        playSong(queue[idx], idx)
    }

    function playPrev() {
        if (queue.length === 0) return
        var idx = queueIndex - 1
        if (idx < 0) idx = queue.length - 1
        playSong(queue[idx], idx)
    }

    function togglePlay() {
        rpcSend({ cmd: paused ? "resume" : "pause" }, null, 3000)
        paused = !paused
    }

    function seekTo(sec) {
        timePos = sec
        rpcSend({ cmd: "seek", seconds: sec }, null, 3000)
    }

    /* ---------- LRC 解析 ---------- */
    function parseLrc(info) {
        var list = []
        if (!info || !info.lyric) return list
        var lines = info.lyric.split(/\r\n|\r|\n/)
        var trans = {}
        if (info.tlyric) {
            var tLines = info.tlyric.split(/\r\n|\r|\n/)
            for (var ti = 0; ti < tLines.length; ti++) {
                var m = tLines[ti].match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)/)
                if (m) trans[lrcKey(m[1], m[2])] = m[4]
            }
        }
        for (var i = 0; i < lines.length; i++) {
            var mm = lines[i].match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)/)
            if (!mm || !mm[4]) continue
            var sec = parseInt(mm[1]) * 60 + parseInt(mm[2]) + (mm[3] ? parseInt(mm[3].length === 1 ? mm[3] + "00" : (mm[3].length === 2 ? mm[3] + "0" : mm[3])) / 1000 : 0)
            list.push({
                time: sec,
                text: mm[4],
                trans: trans[lrcKey(mm[1], mm[2])] || "",
                active: false
            })
        }
        list.sort(function(a, b) { return a.time - b.time })
        return list
    }

    function lrcKey(m, s) {
        return (parseInt(m) < 10 ? "0" : "") + parseInt(m) + ":" + (parseInt(s) < 10 ? "0" : "") + parseInt(s)
    }

    function updateLyricPosition() {
        if (!lyricData || lyricData.length === 0) return
        var idx = 0
        for (var i = 0; i < lyricData.length; i++) {
            lyricData[i].active = false
            if (lyricData[i].time <= timePos + 0.3) idx = i
        }
        lyricData[idx].active = true
        lyricData = lyricData
        if (page === "player" && typeof playerPage !== "undefined") {
            playerPage.positionLyric(idx)
        }
    }

    /* ---------- 脚本扫描 ---------- */
    function scanScripts() {
        var out = shell.exec("ls -1 '" + pluginDir + "/scripts/'*.js 2>/dev/null; true")
        var list = []
        if (out) {
            var names = out.split("\n")
            for (var i = 0; i < names.length; i++) {
                var n = names[i].trim()
                if (!n) continue
                var base = n.replace(/^.*\//, "")
                if (!/\.js$/.test(base)) continue
                var head = shell.exec("head -c 800 '" + pluginDir + "/scripts/" + base + "'")
                var name = ""
                var ver = ""
                var m = head.match(/@name\s+([^\n*]+)/)
                if (m) name = m[1].trim()
                m = head.match(/@version\s+([^\n*]+)/)
                if (m) ver = m[1].trim()
                list.push({ file: base, name: name || base, version: ver })
            }
        }
        scriptList = list
    }

    /* ---------- 页面 ---------- */
    HomePage {
        id: homePage
        visible: root.page === "home"
    }

    SettingsPage {
        visible: root.page === "settings"
    }

    Toast {
        id: toast
        parent: root
    }

    VirtualKeyboardInput {
        id: keyboard
        parent: root
        onAccepted: {
            keyword = content.trim()
            doSearch()
        }
    }

    Timer {
        id: watchdog
        interval: 10000
        repeat: true
        onTriggered: pingRunner()
    }

    Timer {
        id: pollTimer
        interval: 400
        repeat: true
        onTriggered: root.pollOut()
    }

    Connections {
        target: (typeof lxpenPlayer !== "undefined") ? lxpenPlayer : null
        ignoreUnknownSignals: true
        function onSongEnded() {
            // 自动连播由 SO 处理（回主页后仍有效）；这里仅保持 UI 状态一致
        }
        function onSongStarted(idx) {
            if (root.queue.length > 0 && idx >= 0 && idx < root.queue.length) {
                root.currentSong = root.queue[idx]
                root.queueIndex = idx
            }
        }
        function onPlayError(msg) {
            root.toast.show(msg, 3000)
        }
    }

    Component.onCompleted: {
        loadSettings()
        scanScripts()
        // 设置的音源脚本不存在时回退默认（防止旧设置/被删脚本导致 runner 用错音源）
        var scriptFound = false
        var scriptNames = []
        for (var si = 0; si < scriptList.length; si++) {
            scriptNames.push(scriptList[si].file)
            if (scriptList[si].file === selectedScript) { scriptFound = true; break }
        }
        shell.exec("echo 'scripts=" + scriptNames.join(",") + " selected=" + selectedScript + " found=" + scriptFound + "' >> /tmp/lxpen_qml.log")
        if (!scriptFound) {
            selectedScript = "lx-source.js"
            saveSettings()
            pushLog("warn", "音源脚本不存在，已重置为默认")
        }
        startRunner()
        // 把自动连播设置同步给常驻 SO（回主页后连播逻辑由 SO 承担）
    }

    Component.onDestruction: {
        destroying = true
        pollTimer.stop()
        // 不杀 runner/mpv：后台继续播放；再次打开时 startRunner 会重连
    }
}
