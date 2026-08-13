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

static const char* kRunnerInFifo = "/tmp/lxpen_in";
static const char* kMusicLockFile = "/tmp/audio_wakelocks/MUSIC.lock";
static const char* kCacheDir = "/tmp/lxpen_cache";
static const int kCacheMaxFiles = 10;

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
    }

    Q_INVOKABLE void setQueue(const QVariantList& songs, int index) {
        m_queue = QJsonArray::fromVariantList(songs);
        m_index = index;
    }
    Q_INVOKABLE void setQuality(const QString& q) { m_quality = q; }

    Q_INVOKABLE void playIndex(int idx) {
        if (idx < 0 || idx >= m_queue.size()) {
            emit playError(QStringLiteral("队列为空或索引越界"));
            return;
        }
        cancelPlay();
        m_index = idx;
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
        if (!mpm) return;
        if (g_hook_api && g_hook_api->querySymbol) {
            VoidFn pause = (VoidFn)g_hook_api->querySymbol(kOnClickedPause);
            SetPlayStateFn setState = (SetPlayStateFn)g_hook_api->querySymbol(kSetPlayState);
            if (pause) pause(mpm);
            if (setState) {
                int32_t stopped = 2; /* PlayState::STOPPED */
                setState(mpm, &stopped);
            }
        }
        cancelPlay();
    }

    void handleSongEnded() {
        /* 手动停止（切歌/停止）时宿主也会发 onSoundEnd，此时非 PLAYING，忽略以免误触发连播 */
        void* mpm = resolveTInstance(kYMediaPlayerManagerT);
        int state = -1;
        if (mpm && g_hook_api && g_hook_api->querySymbol) {
            typedef int (*PlayStateFn)(void*);
            PlayStateFn getState = (PlayStateFn)g_hook_api->querySymbol("_ZNK19YMediaPlayerManager9playStateEv");
            if (getState) state = getState(mpm);
            if (getState && state != 0) return;
        }
        qint64 sinceStart = QDateTime::currentMSecsSinceEpoch() - m_playStartedAt;
        soLog("songEnded state=" + QString::number(state) + " sinceStart=" + QString::number(sinceStart) + "ms");
        /* 播放开始 8 秒内的 onSoundEnd 视为误触发（宿主初始化/打断），忽略以免误切歌 */
        if (m_playStartedAt > 0 && sinceStart < 8000) return;
        emit songEnded();
    }

    bool isActive() const { return m_queue.size() > 0; }

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
        QFile rf(m_cacheRespPath);
        if (rf.exists() && rf.open(QIODevice::ReadOnly)) {
            const QByteArray data = rf.readAll();
            rf.close();
            QFile::remove(m_cacheRespPath);
            m_cacheBusy = false;
            m_cacheTimer->stop();
            QJsonParseError err;
            const QJsonDocument doc = QJsonDocument::fromJson(data, &err);
            const bool ok = (err.error == QJsonParseError::NoError && doc.isObject() && doc.object().value("ok").toBool());
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
        emit songStarted(m_index);
    }

    void cancelPlay() {
        m_step = Step::Idle;
        m_waitResp = false;
        m_timer->stop();
        if (!m_respPath.isEmpty()) QFile::remove(m_respPath);
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

    void soLog(const QString& msg) {
        QFile f(QStringLiteral("/tmp/lxpen_so.log"));
        if (f.open(QIODevice::Append | QIODevice::WriteOnly)) {
            f.write(("[lxpen] " + msg + "\n").toUtf8());
            f.close();
        }
    }

    bool doPlay(const QString& src, const QString& title, const QString& lrcPath, bool isUrl) {
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
};

static LxPenPlayer* g_player = nullptr;
static OnSoundEndFn g_origOnSoundEnd = nullptr;
static void* onSoundEndDetour(void* self, uint32_t seq) {
    if (g_origOnSoundEnd) g_origOnSoundEnd(self, seq);
    if (g_player) g_player->handleSongEnded();
    return self;
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
        delete g_player;
        g_player = nullptr;
    }
}

} // extern "C"

#include "moc_lxpen_player.cpp"
