import QtQuick 2.12
import QtQuick.LocalStorage 2.12
import "pages"
import "components"
import "."

Item {
    id: root
    width: 320
    height: 170

    signal backButtonClicked()

    /* ---------- 运行时常量 ---------- */
    readonly property string pluginDir: "/userdisk/PenMods/plugins/lx-pen"
    readonly property string inFifo:    "/tmp/lxpen_in"
    readonly property string outFifo:   "/tmp/lxpen_out"
    readonly property string mpvSock:   "/tmp/lxpen.sock"

    /* ---------- 状态 ---------- */
    property string page: "home"        // home | player | settings
    property string platform: "kw"
    property string keyword: ""
    property var searchResult: []
    property bool searching: false

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
    property string quality: "128k"
    property bool autoNext: true
    property var scriptList: []
    property string selectedScript: "example-kw-source.js"
    property var scriptSources: ({})
    property bool scriptReady: false
    property string scriptError: ""
    property var logLines: []

    property bool runnerStarting: false

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
                if (rs.rows.length) quality = rs.rows.item(0).value
                rs = tx.executeSql("SELECT value FROM kv WHERE key='mpv'")
                if (rs.rows.length) mpvPath = rs.rows.item(0).value
                rs = tx.executeSql("SELECT value FROM kv WHERE key='autoNext'")
                if (rs.rows.length) autoNext = rs.rows.item(0).value === "1"
                rs = tx.executeSql("SELECT value FROM kv WHERE key='script'")
                if (rs.rows.length) selectedScript = rs.rows.item(0).value
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
                tx.executeSql("INSERT OR REPLACE INTO kv VALUES('autoNext',?)", [autoNext ? "1" : "0"])
                tx.executeSql("INSERT OR REPLACE INTO kv VALUES('script',?)", [selectedScript])
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

    function rpcSend(cmdObj, cb, timeoutMs) {
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
        shell.execAsync("echo '" + b64 + "' | base64 -d; echo > " + inFifo, function() {})
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

    function readLoop() {
        shell.execAsync("cat " + outFifo, function(res) {
            if (res && res.stdout) {
                var lines = res.stdout.split("\n")
                for (var i = 0; i < lines.length; i++) onLine(lines[i])
            }
            if (root.visible) readLoop()
        })
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
            if (st.state === "ended" && autoNext && currentSong) {
                Qt.callLater(playNext)
            }
        }
        if (st.timePos !== undefined && st.timePos !== null) timePos = st.timePos
        if (st.duration !== undefined && st.duration !== null && st.duration >= 0) duration = st.duration
        updateLyricPosition()
    }

    function startRunner() {
        if (runnerStarting) return
        runnerStarting = true
        scriptReady = false
        shell.exec("rm -f " + inFifo + " " + outFifo + " " + mpvSock + "; mkfifo " + inFifo + " " + outFifo + "; true")
        var script = String(selectedScript).replace(/[^A-Za-z0-9_.-]/g, "")
        var cmd = "nohup " + pluginDir + "/bin/penmusic --script '" + pluginDir + "/scripts/" + script +
                  "' --js-dir '" + pluginDir + "/js' --in " + inFifo + " --out " + outFifo +
                  " --mpv " + mpvSock + " --mpv-bin '" + mpvPath + "' > /tmp/lxpen.log 2>&1 &"
        shell.startDetached(cmd)
        readLoop()
        watchdog.restart()
        runnerStarting = false
    }

    function stopRunner() {
        rpcSend({ cmd: "quit" }, null, 2000)
        shell.exec("pkill -f penmusic 2>/dev/null; true")
        scriptReady = false
    }

    function restartRunner() {
        stopRunner()
        Qt.callLater(startRunner)
    }

    function pingRunner() {
        if (!scriptReady && !scriptError) return
        rpcSend({ cmd: "ping" }, function(res) {
            if (!res.ok) {
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
                searchResult = res.data.list
                queue = res.data.list
                queueIndex = -1
            } else {
                toast.show(res.error, 3000)
            }
        })
    }

    function playSong(song) {
        if (!song) return
        currentSong = song
        coverPath = ""
        lyricData = null
        queueIndex = queue.indexOf(song)
        page = "player"
        rpcSend({ cmd: "script", source: song.source, action: "musicUrl", info: { type: quality, musicInfo: song } }, function(res) {
            if (!res.ok) {
                toast.show(res.error, 3000)
                return
            }
            rpcSend({ cmd: "play", url: res.data, title: song.name + " - " + song.singer }, function() {})
            fetchLyric(song)
            fetchCover(song)
        })
    }

    function fetchLyric(song) {
        rpcSend({ cmd: "lyric", source: song.source, info: song }, function(res) {
            if (res.ok) {
                lyricData = parseLrc(res.data)
                updateLyricPosition()
            } else {
                lyricData = []
            }
        })
    }

    function fetchCover(song) {
        var img = song.img
        if (!img) return
        rpcSend({ cmd: "cover", url: img }, function(res) {
            if (res.ok && res.data && res.data.path) coverPath = res.data.path
        })
    }

    function playNext() {
        if (queue.length === 0) return
        var idx = queueIndex + 1
        if (idx >= queue.length) idx = 0
        playSong(queue[idx])
    }

    function playPrev() {
        if (queue.length === 0) return
        var idx = queueIndex - 1
        if (idx < 0) idx = queue.length - 1
        playSong(queue[idx])
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

    PlayerPage {
        id: playerPage
        visible: root.page === "player"
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

    Component.onCompleted: {
        loadSettings()
        scanScripts()
        startRunner()
    }

    Component.onDestruction: {
        stopRunner()
    }
}
