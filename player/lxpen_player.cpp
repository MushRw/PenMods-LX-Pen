// SPDX-License-Identifier: GPL-3.0-only
/*
 * LX Pen 宿主播放器接管组件。
 * 播放队列与自动连播在 SO 内维护（不随 QML 页面销毁）。
 * 播放流程为异步状态机（QTimer 轮询 runner 响应文件），不阻塞 app 主线程：
 *   musicUrl -> lyric -> 下载到本地文件 -> playFile；下载失败退回在线直连。
 */
#include "PluginSDK.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QCryptographicHash>
#include <QObject>
#include <QQmlContext>
#include <QQmlEngine>
#include <QString>
#include <QTimer>
#include <QVariantList>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

PluginHookAPI* g_hook_api = NULL;

/* ---------------- 宿主结构体（布局照抄 PenMods MusicPlayer） ---------------- */

enum class LrcState { BILINGUAL, ORIGINAL, TRANS, HIDE };
enum class DownloadState { NOT, SUCCEED, ING, FAILURE, CANCEL, PAUSE };

struct YMediaEntity {
    char unk[10];
    QString mMediaId;
    QString mOwnerId;
    QString mTitle;
    int mDuration;
    DownloadState mDownloadState;
    QString mUrl;
    QString mLocalFile;
    QString mLrcFile;
    LrcState mLrcState;
    bool mSrcAudioVisible;
};

struct YColumnMediaEntity : public YMediaEntity {
    int mId;
    QString mColumnId;
    int mProgress;
    bool mIsDir;
};

static_assert(sizeof(YColumnMediaEntity) == 0x68, "YColumnMediaEntity layout mismatch");

/* ---------------- 宿主符号 ---------------- */

typedef void* (*InstanceFn)(void);
typedef void* (*VoidFn)(void*);
typedef void* (*SetBoolFn)(void*, bool);
typedef void* (*SetQStringFn)(void*, const QString*);
typedef void* (*PlayAudioFn)(void*, YColumnMediaEntity*, bool);
typedef void* (*SetPlayStateFn)(void*, const void*);
typedef void (*EntityCtorFn)(YColumnMediaEntity*, void*);
typedef void* (*OnSoundEndFn)(void*, uint32_t);

static void* resolveInstance(const char* sym) {
    if (!g_hook_api || !g_hook_api->querySymbol) return nullptr;
    InstanceFn fn = (InstanceFn)g_hook_api->querySymbol(sym);
    return fn ? fn() : nullptr;
}

static void* resolveTInstance(const char* sym) {
    if (!g_hook_api || !g_hook_api->querySymbol) return nullptr;
    void** t = (void**)g_hook_api->querySymbol(sym);
    return t ? *t : nullptr;
}

static const char* kYGlobalInstance = "_ZN10YSingletonI7YGlobalE8instanceEv";
static const char* kYMediaManagerInstance = "_ZN10YSingletonI13YMediaManagerE8instanceEv";
static const char* kYMediaPlayerManagerT = "_ZN10YSingletonI19YMediaPlayerManagerE1tE";

static const char* kPlayAudio = "_ZN13YMediaManager9playAudioERK18YColumnMediaEntityb";
static const char* kShowAudioPlayer = "_ZN7YGlobal15showAudioPlayerEv";
static const char* kOnClickedPlay = "_ZN19YMediaPlayerManager13onClickedPlayEv";
static const char* kOnClickedPause = "_ZN19YMediaPlayerManager13onClickedPauseEv";
static const char* kSetHasLrc = "_ZN19YMediaPlayerManager9setHasLrcEb";
static const char* kSetAudioPlayingColomnId = "_ZN7YGlobal23setAudioPlayingColomnIdERK7QString";
static const char* kWipeData = "_ZN19YMediaPlayerManager8wipeDataEv";
static const char* kSetPlayState = "_ZN19YMediaPlayerManager12setPlayStateERKN12YEnumWrapper10Play_StateE";
static const char* kEntityCtor = "_ZN18YColumnMediaEntityC2EP7QObject";
static const char* kOnSoundEnd = "_ZN19YMediaPlayerManager10onSoundEndEj";
static const char* kOnClickedNext = "_ZN19YMediaPlayerManager13onClickedNextEb";
static const char* kOnClickedPrev = "_ZN19YMediaPlayerManager13onClickedPrevEb";

static const char* kRunnerInFifo = "/tmp/lxpen_in";
static const char* kMusicLockFile = "/tmp/audio_wakelocks/MUSIC.lock";
static const char* kCacheDir = "/tmp/lxpen_cache";
static const int kCacheMaxFiles = 10;

/* 读取宿主 YMediaPlayerManager 当前音频会话序号（对齐 MusicPlayer 的判断：
 * self+0x20 指向内部对象，其 +0x64 处为当前会话 seq）。 */
static uint32_t currentAudioSeq(void* self) {
    if (!self) return 0;
    uintptr_t inner = *(uintptr_t*)((char*)self + 32);
    if (!inner) return 0;
    return *(uint32_t*)(inner + 100);
}

/* 词典笔音频守护进程通过 /tmp/audio_wakelocks/<源>.lock 判断音频输出占用：
 * MusicPlayer 播放前创建 MUSIC.lock（acquire），否则播放几秒会被守护进程打断。
 * 插件播放时也要持有同一把锁。 */
static void holdMusicLock() {
    QDir().mkpath(QStringLiteral("/tmp/audio_wakelocks"));
    QFile f(QString::fromLatin1(kMusicLockFile));
    if (f.open(QIODevice::WriteOnly | QIODevice::Truncate)) f.close();
}
static void releaseMusicLock() {
    QFile::remove(QString::fromLatin1(kMusicLockFile));
}

/* ---------------- 播放器对象 ---------------- */

class LxPenPlayer : public QObject {
    Q_OBJECT
public:
    explicit LxPenPlayer(QObject* parent = nullptr) : QObject(parent) {
        m_timer = new QTimer(this);
        m_timer->setInterval(50);
        connect(m_timer, &QTimer::timeout, this, &LxPenPlayer::onTick);
        m_cacheTimer = new QTimer(this);
        m_cacheTimer->setInterval(300);
        connect(m_cacheTimer, &QTimer::timeout, this, &LxPenPlayer::onCacheTick);
        /* 空闲监控：宿主已停止且插件页面关闭时，回收后台 runner（2s 轮询） */
        m_idleTimer = new QTimer(this);
        m_idleTimer->setInterval(2000);
        connect(m_idleTimer, &QTimer::timeout, this, &LxPenPlayer::onIdleTick);
        m_idleTimer->start();
    }

    Q_INVOKABLE void setQueue(const QVariantList& songs, int index) {
        m_queue = QJsonArray::fromVariantList(songs);
        m_index = index;
    }
    Q_INVOKABLE void setQuality(const QString& q) { m_quality = q; }

    /* QML 页面生命周期：打开时 true，关闭时 false（配合空闲监控回收 runner） */
    Q_INVOKABLE void setUiOpen(bool open) {
        m_uiOpen = open;
        soLog("uiOpen=" + QString::number(open ? 1 : 0));
    }

    /* 宿主是否处于播放/暂停：QML 退出时据此决定是否回收 runner */
    Q_INVOKABLE bool isHostActive() {
        return isPlaying() || isPaused();
    }

    /* 清空队列：播放本地下载文件前调用，避免旧的搜索队列干扰下一首/连播 */
    Q_INVOKABLE void clearQueue() {
        m_queue = QJsonArray();
        m_index = -1;
        m_playStartedAt = 0;
        m_ourSeq = 0;
        m_advanceHandled = false;
        m_playAfterCache = false;
    }

    /* 重开页面后恢复播放上下文：宿主仍在播上一首，恢复队列/接管/会话号，
     * 让宿主上一首/下一首与自动连播在重开后继续可用。 */
    Q_INVOKABLE void resumeQueue(const QVariantList& songs, int index) {
        m_queue = QJsonArray::fromVariantList(songs);
        if (index < 0 || index >= m_queue.size()) { m_index = -1; return; }
        m_index = index;
        m_takeover = true;
        m_advanceHandled = false;
        m_playStartedAt = QDateTime::currentMSecsSinceEpoch();
        void* mpm = resolveTInstance(kYMediaPlayerManagerT);
        m_ourSeq = mpm ? currentAudioSeq(mpm) : 0;
        soLog("resumeQueue idx=" + QString::number(index) + " ourSeq=" + QString::number(m_ourSeq));
    }

    Q_INVOKABLE void playIndex(int idx) {
        if (idx < 0 || idx >= m_queue.size()) {
            emit playError(QStringLiteral("队列为空或索引越界"));
            return;
        }
        cancelPlay();
        m_index = idx;
        /* 切换中：任何 onSoundEnd 一律忽略，直到新歌真正开播（finishPlay 重置） */
        m_playStartedAt = 0;
        m_advanceHandled = false;
        m_ourSeq = 0;
        m_playAfterCache = false;
        m_currentSong = m_queue.at(idx).toObject();
        m_currentTitle = m_currentSong.value(QStringLiteral("name")).toString() + QStringLiteral(" - ") +
                         m_currentSong.value(QStringLiteral("singer")).toString();
        m_currentSource = m_currentSong.value(QStringLiteral("source")).toString();
        m_currentLrc = QString();
        m_currentUrl = QString();
        m_currentPath = QString();
        if (m_currentSource.isEmpty()) {
            emit playError(QStringLiteral("缺少音源标识"));
            return;
        }
        startStep(Step::GetUrl);
    }

    Q_INVOKABLE bool playUrl(const QString& url, const QString& title, const QString& lrcPath = QString()) {
        return doPlay(url, title, lrcPath, true);
    }

    Q_INVOKABLE bool playFile(const QString& path, const QString& title, const QString& lrcPath = QString()) {
        return doPlay(path, title, lrcPath, false);
    }

    Q_INVOKABLE void stop() {
        releaseMusicLock();
        m_playAfterCache = false;
        void* mpm = resolveTInstance(kYMediaPlayerManagerT);
        if (mpm && g_hook_api && g_hook_api->querySymbol) {
            VoidFn pause = (VoidFn)g_hook_api->querySymbol(kOnClickedPause);
            SetPlayStateFn setState = (SetPlayStateFn)g_hook_api->querySymbol(kSetPlayState);
            if (pause) pause(mpm);
            if (setState) {
                int32_t stopped = 2; /* PlayState::STOPPED */
                setState(mpm, &stopped);
            }
        }
        cancelPlay();
        /* 显式停止：彻底解除接管，避免宿主播放器后续按钮/结束事件被插件劫持 */
        m_takeover = false;
        m_queue = QJsonArray();
        m_index = -1;
        m_playStartedAt = 0;
        m_ourSeq = 0;
        m_advanceHandled = false;
    }

    void handleSongEnded(uint32_t seq, uint32_t curEntry, int stateEntry) {
        qint64 sinceStart = m_playStartedAt > 0 ? QDateTime::currentMSecsSinceEpoch() - m_playStartedAt : -1;
        soLog("songEnded seq=" + QString::number(seq) + " cur=" + QString::number(curEntry) +
              " state=" + QString::number(stateEntry) + " sinceStart=" + QString::number(sinceStart) +
              "ms takeover=" + QString::number(m_takeover ? 1 : 0) + " ourSeq=" + QString::number(m_ourSeq));
        if (!m_takeover || m_playStartedAt <= 0) return; /* 未接管/切换中/未开播，忽略 */
        if (stateEntry != 0) return;      /* 非 PLAYING：手动停止/暂停触发，不连播 */
        /* 结束事件必须属于本插件启动的会话：seq==m_ourSeq。
         * 注意宿主可能已在事件前推进当前会话号（实测真结束为 seq==m_ourSeq、cur==m_ourSeq+1），
         * 因此只校验 seq，不要求 cur==seq。旧会话残留事件 seq<cur 会被此校验拦下。 */
        if (seq != m_ourSeq) return;
        /* 播放开始 8 秒内的 onSoundEnd 视为误触发（宿主初始化/打断），忽略以免误切歌 */
        if (sinceStart < 8000) return;
        if (m_queue.size() == 0 || m_index < 0) return;
        /* 宿主自身 onSoundEnd 已通过 onClickedNext 推进过队列，避免二次推进 */
        if (m_advanceHandled) { m_advanceHandled = false; return; }
        int next = m_index + 1;
        if (next >= m_queue.size()) next = 0;
        soLog("auto next idx=" + QString::number(next));
        playIndex(next);
        emit songEnded();
    }

    /* 空闲监控：宿主已停止播放且插件页面已关闭 → 让 runner 退出并释放资源。
     * 播放中/暂停中一律保留 runner（后台续播/悬浮球需要它解析后续 musicUrl）。 */
    void onIdleTick() {
        if (m_uiOpen || !m_takeover) return;
        if (isPlaying() || isPaused()) return;
        soLog("idle: host stopped & ui closed -> quit runner");
        requestRunnerQuit();
    }

    /* 回收后台 runner 并释放资源（页面销毁/空闲监控共用） */
    void requestRunnerQuit() {
        QJsonObject cmd;
        cmd.insert(QStringLiteral("cmd"), QStringLiteral("quit"));
        writeRpc(cmd);
        releaseMusicLock();
        m_takeover = false;
        m_queue = QJsonArray();
        m_index = -1;
        m_playStartedAt = 0;
        m_ourSeq = 0;
        m_advanceHandled = false;
        cancelPlay();
    }

    /* 手动/宿主"下一首"：经宿主播放器 onClickedNext 同一路径推进队列。
     * 3 秒内视为宿主初始化误触发（实测误判约 0.8~1.9s），忽略以免连环跳歌。 */
    void handleNext() {
        if (m_queue.size() == 0) return;
        if (m_playStartedAt > 0 && QDateTime::currentMSecsSinceEpoch() - m_playStartedAt < 3000) {
            soLog("next ignored (within 3s of play start)");
            return;
        }
        int next = m_index + 1;
        if (next >= m_queue.size()) next = 0;
        m_advanceHandled = true;
        playIndex(next);
    }

    void handlePrev() {
        if (m_queue.size() == 0) return;
        int prev = m_index - 1;
        if (prev < 0) prev = m_queue.size() - 1;
        m_advanceHandled = true;
        playIndex(prev);
    }

    bool isActive() const { return m_queue.size() > 0; }
    bool isTakeover() const { return m_takeover; }

signals:
    void songEnded();
    void songStarted(int index);
    void playError(const QString& message);

private:
    enum class Step { Idle, GetUrl, GetLyric, Download, PlayFile, Online, WaitPlaying, CheckCache };

    void startStep(Step s) {
        m_step = s;
        m_waitResp = false;
        m_timer->start();
    }

    void sendRpcStep(const QJsonObject& cmd, int timeoutMs) {
        m_respId = ++m_rpcSeq;
        m_respPath = QStringLiteral("/tmp/lxpen_so_resp_%1.json").arg(m_respId);
        QFile::remove(m_respPath);
        QJsonObject c = cmd;
        c.insert(QStringLiteral("id"), m_respId);
        c.insert(QStringLiteral("respPath"), m_respPath);
        if (!writeRpc(c)) return;
        soLog("rpc sent id=" + QString::number(m_respId) + " step=" + QString::number((int)m_step));
        m_waitResp = true;
        m_deadline = QDateTime::currentMSecsSinceEpoch() + timeoutMs;
        m_timer->start();
    }

    bool writeRpc(const QJsonObject& obj) {
        const QByteArray payload = QJsonDocument(obj).toJson(QJsonDocument::Compact) + '\n';
        int fd = ::open(kRunnerInFifo, O_WRONLY | O_NONBLOCK);
        if (fd < 0) {
            soLog("fifo open failed errno=" + QString::number(errno));
            return false;
        }
        const ssize_t w = ::write(fd, payload.constData(), payload.size());
        ::close(fd);
        return w == (ssize_t)payload.size();
    }

    /* ---- 歌曲缓存（在线直连播放的同时后台下载，LRU 保持 10 首） ---- */
    QString cachePathFor() {
        const QString safeId = QString::fromLatin1(QCryptographicHash::hash(
            m_currentSong.value(QStringLiteral("songmid")).toString().toUtf8(), QCryptographicHash::Md5).toHex());
        return QString::fromLatin1(kCacheDir) + QStringLiteral("/lxpen_") + safeId + QStringLiteral(".mp3");
    }

    static bool cacheHit(const QString& path) {
        QFileInfo fi(path);
        return fi.exists() && fi.size() > 102400; /* >100KB 视为有效缓存 */
    }

    void startCacheDownload() {
        if (m_cacheBusy || m_currentUrl.isEmpty()) return;
        m_cachePath = cachePathFor();
        if (cacheHit(m_cachePath)) return;
        QDir().mkpath(QString::fromLatin1(kCacheDir));
        m_cacheBusy = true;
        m_cacheStartAt = QDateTime::currentMSecsSinceEpoch();
        m_cacheRespPath = QStringLiteral("/tmp/lxpen_cache_resp.json");
        QFile::remove(m_cacheRespPath);
        QJsonObject cmd;
        cmd.insert(QStringLiteral("cmd"), QStringLiteral("download"));
        cmd.insert(QStringLiteral("url"), m_currentUrl);
        cmd.insert(QStringLiteral("path"), m_cachePath);
        m_cacheSeq++;
        cmd.insert(QStringLiteral("id"), m_cacheSeq);
        cmd.insert(QStringLiteral("respPath"), m_cacheRespPath);
        if (writeRpc(cmd)) {
            soLog("cache download start: " + m_cachePath.left(50));
            m_cacheTimer->start(300);
        } else {
            m_cacheBusy = false;
        }
    }

    void onCacheTick() {
        if (!m_cacheBusy) { m_cacheTimer->stop(); return; }
        if (QDateTime::currentMSecsSinceEpoch() > m_cacheStartAt + 90000) {
            soLog("cache download timeout");
            m_cacheBusy = false;
            m_cacheTimer->stop();
            return;
        }
        QFile rf(m_cacheRespPath);
        if (rf.exists() && rf.open(QIODevice::ReadOnly)) {
            const QByteArray data = rf.readAll();
            rf.close();
            QFile::remove(m_cacheRespPath);
            QJsonParseError err;
            const QJsonDocument doc = QJsonDocument::fromJson(data, &err);
            const QJsonObject obj = (err.error == QJsonParseError::NoError && doc.isObject()) ? doc.object() : QJsonObject();
            if (obj.value(QStringLiteral("id")).toInt() != m_cacheSeq) {
                /* 切歌后旧下载的响应才到达：忽略，继续等当前下载 */
                soLog("cache resp id mismatch, ignore");
                return;
            }
            m_cacheBusy = false;
            m_cacheTimer->stop();
            const bool ok = obj.value(QStringLiteral("ok")).toBool();
            soLog(ok ? "cache download ok: " + m_cachePath : "cache download failed");
            if (ok) pruneCache();
            if (ok && m_playAfterCache) {
                m_playAfterCache = false;
                m_currentPath = m_cachePath;
                m_step = Step::Idle;
                startStep(Step::PlayFile);
            }
        }
    }

    void pruneCache() {
        QDir dir(QString::fromLatin1(kCacheDir));
        QFileInfoList files = dir.entryInfoList(QStringList() << QStringLiteral("*.mp3"), QDir::Files, QDir::Time);
        while (files.size() > kCacheMaxFiles) {
            QFile::remove(files.last().absoluteFilePath());
            soLog("cache prune: " + files.last().fileName());
            files.removeLast();
        }
    }

    QJsonObject pollResp() {
        QFile rf(m_respPath);
        if (rf.exists() && rf.open(QIODevice::ReadOnly)) {
            const QByteArray data = rf.readAll();
            rf.close();
            QFile::remove(m_respPath);
            QJsonParseError err;
            const QJsonDocument doc = QJsonDocument::fromJson(data, &err);
            if (err.error == QJsonParseError::NoError && doc.isObject()) return doc.object();
        }
        return QJsonObject();
    }

    void failStep(const QString& msg) {
        soLog("fail: " + msg);
        m_step = Step::Idle;
        m_waitResp = false;
        m_timer->stop();
        emit playError(msg);
    }

    void finishPlay() {
        m_step = Step::Idle;
        m_waitResp = false;
        m_timer->stop();
        m_playStartedAt = QDateTime::currentMSecsSinceEpoch();
        m_advanceHandled = false;
        /* 宿主已确认开播：刷新会话号，确保"真结束"事件能被识别为本插件的会话 */
        void* mpm = resolveTInstance(kYMediaPlayerManagerT);
        if (mpm) m_ourSeq = currentAudioSeq(mpm);
        emit songStarted(m_index);
    }

    void cancelPlay() {
        m_step = Step::Idle;
        m_waitResp = false;
        m_timer->stop();
        if (!m_respPath.isEmpty()) QFile::remove(m_respPath);
        /* 复位缓存下载：避免切换/停止后缓存单飞卡死或串读旧响应 */
        m_cacheTimer->stop();
        m_cacheBusy = false;
        m_playAfterCache = false;
        if (!m_cacheRespPath.isEmpty()) QFile::remove(m_cacheRespPath);
    }

    void onTick() {
        if (m_waitResp) {
            const QJsonObject resp = pollResp();
            if (!resp.isEmpty()) {
                m_waitResp = false;
                onRpcResp(resp);
                return;
            }
            if (QDateTime::currentMSecsSinceEpoch() > m_deadline) {
                soLog("rpc timeout step=" + QString::number((int)m_step));
                if (m_step == Step::GetLyric) {
                    m_currentLrc = QString();
                    startStep(Step::Download);
                } else {
                    failStep(QStringLiteral("请求超时"));
                }
            }
            return;
        }

        switch (m_step) {
        case Step::GetUrl: {
            soLog("step get url idx=" + QString::number(m_index));
            QJsonObject cmd;
            cmd.insert(QStringLiteral("cmd"), QStringLiteral("script"));
            cmd.insert(QStringLiteral("source"), m_currentSource);
            cmd.insert(QStringLiteral("action"), QStringLiteral("musicUrl"));
            QJsonObject info;
            info.insert(QStringLiteral("type"), m_quality.isEmpty() ? QStringLiteral("128k") : m_quality);
            info.insert(QStringLiteral("musicInfo"), m_currentSong);
            cmd.insert(QStringLiteral("info"), info);
            sendRpcStep(cmd, 20000);
            break;
        }
        case Step::GetLyric: {
            QJsonObject cmd;
            cmd.insert(QStringLiteral("cmd"), QStringLiteral("lyric"));
            cmd.insert(QStringLiteral("source"), m_currentSource);
            cmd.insert(QStringLiteral("info"), m_currentSong);
            sendRpcStep(cmd, 15000);
            break;
        }
        case Step::Download: {
            soLog("step download: " + m_currentUrl.left(60));
            const QString safeId = QString::fromLatin1(QCryptographicHash::hash(
                m_currentSong.value(QStringLiteral("songmid")).toString().toUtf8(), QCryptographicHash::Md5).toHex());
            m_currentPath = QStringLiteral("/tmp/lxpen_%1.mp3").arg(safeId);
            QJsonObject cmd;
            cmd.insert(QStringLiteral("cmd"), QStringLiteral("download"));
            cmd.insert(QStringLiteral("url"), m_currentUrl);
            cmd.insert(QStringLiteral("path"), m_currentPath);
            sendRpcStep(cmd, 40000);
            break;
        }
        case Step::PlayFile: {
            soLog("step play file: " + m_currentPath);
            doPlay(m_currentPath, m_currentTitle, m_currentLrc, false);
            finishPlay();
            break;
        }
        case Step::CheckCache: {
            m_currentPath = cachePathFor();
            if (cacheHit(m_currentPath)) {
                soLog("cache hit: " + m_currentPath);
                startStep(Step::PlayFile);
            } else {
                soLog("cache miss -> online play + background cache");
                startStep(Step::Online);
            }
            break;
        }
        case Step::Online: {
            soLog("step online: " + m_currentUrl.left(60));
            if (doPlay(m_currentUrl, m_currentTitle, m_currentLrc, true)) {
                m_waitPlayingUntil = QDateTime::currentMSecsSinceEpoch() + 5000;
                m_step = Step::WaitPlaying;
                m_timer->start();
                /* 在线直连播放的同时后台缓存（不阻塞状态机） */
                startCacheDownload();
            } else {
                failStep(QStringLiteral("在线播放失败"));
            }
            break;
        }
        case Step::WaitPlaying: {
            if (isPlaying()) {
                soLog("host PLAYING (online)");
                finishPlay();
            } else if (QDateTime::currentMSecsSinceEpoch() > m_waitPlayingUntil) {
                soLog("online did not play");
                if (m_cacheBusy) {
                    /* 宿主在线播放不支持：等缓存下载完成后再播本地文件 */
                    soLog("wait cache then play file");
                    m_playAfterCache = true;
                    m_step = Step::Idle;
                    m_timer->stop();
                } else {
                    failStep(QStringLiteral("在线播放失败"));
                }
            }
            break;
        }
        default:
            break;
        }
    }

    void onRpcResp(const QJsonObject& resp) {
        const bool ok = resp.value(QStringLiteral("ok")).toBool();
        const QString err = resp.value(QStringLiteral("error")).toString();
        switch (m_step) {
        case Step::GetUrl:
            if (ok) {
                m_currentUrl = resp.value(QStringLiteral("data")).toString();
                soLog("url ok: " + m_currentUrl.left(60));
                startStep(Step::GetLyric);
            } else {
                failStep(QStringLiteral("获取播放链接失败: ") + err);
            }
            break;
        case Step::GetLyric:
            m_currentLrc = ok ? resp.value(QStringLiteral("data")).toObject().value(QStringLiteral("path")).toString()
                              : QString();
            soLog("lrc: " + m_currentLrc);
            startStep(Step::CheckCache);
            break;
        case Step::Download:
            if (ok) {
                soLog("download ok: " + m_currentPath);
                startStep(Step::PlayFile);
            } else {
                soLog("download failed, online fallback: " + err);
                startStep(Step::Online);
            }
            break;
        default:
            break;
        }
    }

    bool isPlaying() {
        void* mpm = resolveTInstance(kYMediaPlayerManagerT);
        if (!mpm || !g_hook_api || !g_hook_api->querySymbol) return false;
        typedef int (*PlayStateFn)(void*);
        PlayStateFn getState = (PlayStateFn)g_hook_api->querySymbol("_ZNK19YMediaPlayerManager9playStateEv");
        return getState && getState(mpm) == 0; /* PLAYING */
    }

    bool isPaused() {
        void* mpm = resolveTInstance(kYMediaPlayerManagerT);
        if (!mpm || !g_hook_api || !g_hook_api->querySymbol) return false;
        typedef int (*PlayStateFn)(void*);
        PlayStateFn getState = (PlayStateFn)g_hook_api->querySymbol("_ZNK19YMediaPlayerManager9playStateEv");
        return getState && getState(mpm) == 1; /* PAUSED */
    }

    void soLog(const QString& msg) {
        QFile f(QStringLiteral("/tmp/lxpen_so.log"));
        if (f.open(QIODevice::Append | QIODevice::WriteOnly)) {
            f.write(("[lxpen] " + msg + "\n").toUtf8());
            f.close();
        }
    }

    bool doPlay(const QString& src, const QString& title, const QString& lrcPath, bool isUrl) {
        /* 直接播放（playFile/playUrl）不经过 playIndex：复位计时，避免旧 sinceStart 误触发连播 */
        m_playStartedAt = 0;
        m_advanceHandled = false;
        /* 先持音频守护进程 MUSIC 锁，再触发播放（避免守护进程在播放开始后介入打断） */
        holdMusicLock();
        if (!g_hook_api || !g_hook_api->querySymbol) {
            fprintf(stderr, "[lxpen] hook api missing\n");
            return false;
        }
        void* yglobal = resolveInstance(kYGlobalInstance);
        void* ymedia = resolveInstance(kYMediaManagerInstance);
        void* mpm = resolveTInstance(kYMediaPlayerManagerT);
        if (!yglobal || !ymedia || !mpm) {
            fprintf(stderr, "[lxpen] host instances missing\n");
            return false;
        }

        PlayAudioFn playAudio = (PlayAudioFn)g_hook_api->querySymbol(kPlayAudio);
        VoidFn showAudioPlayer = (VoidFn)g_hook_api->querySymbol(kShowAudioPlayer);
        VoidFn onClickedPlay = (VoidFn)g_hook_api->querySymbol(kOnClickedPlay);
        VoidFn wipe = (VoidFn)g_hook_api->querySymbol(kWipeData);
        SetBoolFn setHasLrc = (SetBoolFn)g_hook_api->querySymbol(kSetHasLrc);
        SetQStringFn setColId = (SetQStringFn)g_hook_api->querySymbol(kSetAudioPlayingColomnId);
        EntityCtorFn ctor = (EntityCtorFn)g_hook_api->querySymbol(kEntityCtor);
        if (!playAudio || !showAudioPlayer || !onClickedPlay || !ctor) {
            fprintf(stderr, "[lxpen] host symbols missing\n");
            return false;
        }

        char mem[sizeof(YColumnMediaEntity)];
        std::memset(mem, 0, sizeof mem);
        YColumnMediaEntity* entity = reinterpret_cast<YColumnMediaEntity*>(mem);
        ctor(entity, nullptr);

        static int mediaId = 0;
        mediaId--;
        entity->mId = mediaId;
        entity->mMediaId = QString::number(mediaId);
        entity->mOwnerId = QStringLiteral("fake_column_hsxjsbw");
        entity->mColumnId = QStringLiteral("fake_column_hsxjsbw");
        entity->mIsDir = false;
        entity->mDownloadState = DownloadState::SUCCEED;
        entity->mTitle = title.isEmpty() ? QStringLiteral("LX Pen") : title;
        if (isUrl) entity->mUrl = src;
        else entity->mLocalFile = src;
        if (!lrcPath.isEmpty()) entity->mLrcFile = lrcPath;

        if (wipe) wipe(mpm);
        if (setColId) {
            QString colId = QStringLiteral("myimport");
            setColId(yglobal, &colId);
        }
        playAudio(ymedia, entity, true);
        showAudioPlayer(yglobal);

        entity->~YColumnMediaEntity();

        /* 对齐 MusicPlayer：仅当宿主未进入 PLAYING 才手动触发播放与 LRC（避免重复触发导致中断） */
        if (!isPlaying()) {
            if (onClickedPlay) onClickedPlay(mpm);
            if (setHasLrc) setHasLrc(mpm, !lrcPath.isEmpty());
        }
        /* 接管播放：next/prev 钩子与连播逻辑自此归属本插件 */
        m_takeover = true;
        m_ourSeq = currentAudioSeq(mpm);
        return true;
    }

    QJsonArray m_queue;
    int m_index = -1;
    QString m_quality;
    int m_rpcSeq = 0;
    QTimer* m_timer = nullptr;
    Step m_step = Step::Idle;
    bool m_waitResp = false;
    qint64 m_deadline = 0;
    qint64 m_waitPlayingUntil = 0;
    QString m_respPath;
    int m_respId = 0;
    qint64 m_playStartedAt = 0;
    QTimer* m_cacheTimer = nullptr;
    bool m_cacheBusy = false;
    bool m_playAfterCache = false;
    int m_cacheSeq = 0;
    QString m_cachePath;
    QString m_cacheRespPath;
    QJsonObject m_currentSong;
    QString m_currentTitle;
    QString m_currentSource;
    QString m_currentUrl;
    QString m_currentLrc;
    QString m_currentPath;
    bool m_advanceHandled = false;
    bool m_takeover = false;
    bool m_uiOpen = false;
    uint32_t m_ourSeq = 0;
    QTimer* m_idleTimer = nullptr;
    qint64 m_cacheStartAt = 0;
};

static LxPenPlayer* g_player = nullptr;
static OnSoundEndFn g_origOnSoundEnd = nullptr;
static void* (*g_origOnClickedNext)(void*, bool) = nullptr;
static void* (*g_origOnClickedPrev)(void*, bool) = nullptr;

static void* onSoundEndDetour(void* self, uint32_t seq) {
    /* 宿主原函数可能改动会话序号/状态，必须在调用前捕获（对齐 MusicPlayer 的判断时机） */
    const uint32_t curEntry = currentAudioSeq(self);
    int stateEntry = -1;
    void* mpm = resolveTInstance(kYMediaPlayerManagerT);
    if (mpm && g_hook_api && g_hook_api->querySymbol) {
        typedef int (*PlayStateFn)(void*);
        PlayStateFn getState = (PlayStateFn)g_hook_api->querySymbol("_ZNK19YMediaPlayerManager9playStateEv");
        if (getState) stateEntry = getState(mpm);
    }
    if (g_origOnSoundEnd) g_origOnSoundEnd(self, seq);
    if (g_player) g_player->handleSongEnded(seq, curEntry, stateEntry);
    return self;
}

static void* onClickedNextDetour(void* self, bool a2) {
    if (g_player && g_player->isTakeover() && g_player->isActive()) {
        g_player->handleNext();
        return nullptr;
    }
    if (g_origOnClickedNext) return g_origOnClickedNext(self, a2);
    return nullptr;
}

static void* onClickedPrevDetour(void* self, bool a2) {
    if (g_player && g_player->isTakeover() && g_player->isActive()) {
        g_player->handlePrev();
        return nullptr;
    }
    if (g_origOnClickedPrev) return g_origOnClickedPrev(self, a2);
    return nullptr;
}

extern "C" {

void init_plugin() {
    /* 基础初始化：无 */
}

void init_plugin_with_hook_api(PluginHookAPI* api) {
    g_hook_api = api;
    if (!g_player) g_player = new LxPenPlayer();
    if (g_hook_api && g_hook_api->querySymbol && g_hook_api->hookFunction) {
        void* addr = g_hook_api->querySymbol(kOnSoundEnd);
        if (addr) g_hook_api->hookFunction(addr, (void*)onSoundEndDetour, (void**)&g_origOnSoundEnd);
        void* addrNext = g_hook_api->querySymbol(kOnClickedNext);
        if (addrNext) g_hook_api->hookFunction(addrNext, (void*)onClickedNextDetour, (void**)&g_origOnClickedNext);
        void* addrPrev = g_hook_api->querySymbol(kOnClickedPrev);
        if (addrPrev) g_hook_api->hookFunction(addrPrev, (void*)onClickedPrevDetour, (void**)&g_origOnClickedPrev);
    }
}

void attach_engine(void* engine) {
    QQmlEngine* qmlEngine = reinterpret_cast<QQmlEngine*>(engine);
    if (qmlEngine && g_player) {
        qmlEngine->rootContext()->setContextProperty(QStringLiteral("lxpenPlayer"), g_player);
    }
}

void destroy_plugin() {
    if (g_player) {
        /* 页面销毁时若宿主已停止播放：回收 runner 并释放 MUSIC 锁；
         * 宿主仍在播放则保留（后台续播需要 runner 解析后续链接）。 */
        if (!g_player->isHostActive()) {
            g_player->requestRunnerQuit();
        }
        delete g_player;
        g_player = nullptr;
    }
}

} // extern "C"

#include "moc_lxpen_player.cpp"
