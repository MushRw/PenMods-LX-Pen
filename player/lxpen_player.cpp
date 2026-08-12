// SPDX-License-Identifier: GPL-3.0-only
/*
 * LX Pen 宿主播放器接管组件。
 * 把音源 URL（在线直连）或本地文件交给宿主 YMediaManager::playAudio 播放，
 * 宿主播放器自动提供播放页 / 悬浮窗 / 后台播放。
 * 播放队列与自动连播在 SO 内维护（不随 QML 页面销毁），
 * 需要播放链接时通过 runner 的 FIFO RPC 现取（musicUrl / lyric / download）。
 */
#include "PluginSDK.h"

#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QCryptographicHash>
#include <QObject>
#include <QQmlContext>
#include <QQmlEngine>
#include <QString>
#include <QThread>
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

/* ---------------- 播放器对象 ---------------- */

class LxPenPlayer : public QObject {
    Q_OBJECT
public:
    explicit LxPenPlayer(QObject* parent = nullptr) : QObject(parent) {}

    Q_INVOKABLE void setQueue(const QVariantList& songs, int index, bool autoNext) {
        m_queue = QJsonArray::fromVariantList(songs);
        m_index = index;
        m_autoNext = autoNext;
    }

    Q_INVOKABLE void setAutoNext(bool on) { m_autoNext = on; }
    Q_INVOKABLE void setQuality(const QString& q) { m_quality = q; }

    Q_INVOKABLE void playIndex(int idx) {
        soLog("playIndex idx=" + QString::number(idx) + " queue=" + QString::number(m_queue.size()));
        if (idx < 0 || idx >= m_queue.size()) {
            emit playError(QStringLiteral("队列为空或索引越界"));
            return;
        }
        m_index = idx;
        const QJsonObject song = m_queue.at(idx).toObject();
        const QString title = song.value(QStringLiteral("name")).toString() + QStringLiteral(" - ") +
                              song.value(QStringLiteral("singer")).toString();
        const QString source = song.value(QStringLiteral("source")).toString();
        if (source.isEmpty()) {
            emit playError(QStringLiteral("缺少音源标识"));
            return;
        }

        /* 1. 取播放链接 */
        QJsonObject mcmd;
        mcmd.insert(QStringLiteral("cmd"), QStringLiteral("script"));
        mcmd.insert(QStringLiteral("source"), source);
        mcmd.insert(QStringLiteral("action"), QStringLiteral("musicUrl"));
        QJsonObject info;
        info.insert(QStringLiteral("type"), m_quality.isEmpty() ? QStringLiteral("128k") : m_quality);
        info.insert(QStringLiteral("musicInfo"), song);
        mcmd.insert(QStringLiteral("info"), info);
        const QJsonObject mresp = rpc(mcmd, 20000);
        if (!mresp.value(QStringLiteral("ok")).toBool()) {
            soLog("musicUrl rpc failed: " + mresp.value(QStringLiteral("error")).toString());
            emit playError(QStringLiteral("获取播放链接失败: ") + mresp.value(QStringLiteral("error")).toString());
            return;
        }
        const QString url = mresp.value(QStringLiteral("data")).toString();
        soLog("musicUrl ok: " + url.left(60));

        /* 2. 取歌词（失败不影响播放） */
        QString lrcPath;
        QJsonObject lcmd;
        lcmd.insert(QStringLiteral("cmd"), QStringLiteral("lyric"));
        lcmd.insert(QStringLiteral("source"), source);
        lcmd.insert(QStringLiteral("info"), song);
        const QJsonObject lresp = rpc(lcmd, 15000);
        if (lresp.value(QStringLiteral("ok")).toBool()) {
            lrcPath = lresp.value(QStringLiteral("data")).toObject().value(QStringLiteral("path")).toString();
        }
        soLog("lrc path: " + lrcPath);

        /* 3. 主路径：下载到本地文件再播放（宿主对本地文件的 playAudio 切歌可靠；
              在线直连 mUrl 首次可播，但切歌不换流，仅作下载失败后备） */
        const QString safeId = QString::fromLatin1(QCryptographicHash::hash(
            song.value(QStringLiteral("songmid")).toString().toUtf8(), QCryptographicHash::Md5).toHex());
        const QString path = QStringLiteral("/tmp/lxpen_%1.mp3").arg(safeId);
        QJsonObject dcmd;
        dcmd.insert(QStringLiteral("cmd"), QStringLiteral("download"));
        dcmd.insert(QStringLiteral("url"), url);
        dcmd.insert(QStringLiteral("path"), path);
        const QJsonObject dresp = rpc(dcmd, 30000);
        if (dresp.value(QStringLiteral("ok")).toBool()) {
            doPlay(path, title, lrcPath, false);
            soLog("file play started: " + path);
            emit songStarted(m_index);
            return;
        }
        soLog("download failed, try online: " + dresp.value(QStringLiteral("error")).toString());
        if (doPlay(url, title, lrcPath, true)) {
            waitForPlaying(5000);
            soLog("online fallback attempted");
            emit songStarted(m_index);
            return;
        }
        emit playError(QStringLiteral("播放失败: ") + dresp.value(QStringLiteral("error")).toString());
    }

    Q_INVOKABLE bool playUrl(const QString& url, const QString& title, const QString& lrcPath = QString()) {
        return doPlay(url, title, lrcPath, true);
    }

    Q_INVOKABLE bool playFile(const QString& path, const QString& title, const QString& lrcPath = QString()) {
        return doPlay(path, title, lrcPath, false);
    }

    Q_INVOKABLE void stop() {
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
    }

    /* 供 onSoundEnd hook 调用：通知 UI + 自动连播 */
    void handleSongEnded() {
        /* 手动停止（切歌/停止）时宿主也会发 onSoundEnd，但此时非 PLAYING，忽略以免误触发连播 */
        void* mpm = resolveTInstance(kYMediaPlayerManagerT);
        if (mpm && g_hook_api && g_hook_api->querySymbol) {
            typedef int (*PlayStateFn)(void*);
            PlayStateFn getState = (PlayStateFn)g_hook_api->querySymbol("_ZNK19YMediaPlayerManager9playStateEv");
            if (getState && getState(mpm) != 0) return;
        }
        emit songEnded();
        if (m_autoNext && m_queue.size() > 0) {
            int next = m_index + 1;
            if (next >= m_queue.size()) next = 0;
            playIndex(next);
        }
    }

    /* 宿主播放器页面的上一首/下一首：路由到我们的队列 */
    void handleNext() {
        if (m_queue.size() == 0) return;
        int next = m_index + 1;
        if (next >= m_queue.size()) next = 0;
        playIndex(next);
    }

    void handlePrev() {
        if (m_queue.size() == 0) return;
        int prev = m_index - 1;
        if (prev < 0) prev = m_queue.size() - 1;
        playIndex(prev);
    }

    bool isActive() const { return m_queue.size() > 0; }

signals:
    void songEnded();
    void songStarted(int index);
    void playError(const QString& message);

private:
    /* runner FIFO JSON-RPC：写命令到 /tmp/lxpen_in，从独立响应文件读回 */
    QJsonObject rpc(const QJsonObject& cmd, int timeoutMs) {
        const int id = ++m_rpcSeq;
        const QString respPath = QStringLiteral("/tmp/lxpen_so_resp_%1.json").arg(id);
        QFile::remove(respPath);
        QJsonObject c = cmd;
        c.insert(QStringLiteral("id"), id);
        c.insert(QStringLiteral("respPath"), respPath);
        const QByteArray payload = QJsonDocument(c).toJson(QJsonDocument::Compact) + '\n';

        /* 用 POSIX 非阻塞写 FIFO：无读者时立即失败而非阻塞主线程 */
        int fd = ::open(kRunnerInFifo, O_WRONLY | O_NONBLOCK);
        if (fd < 0) {
            soLog(QStringLiteral("fifo open failed: errno=") + QString::number(errno));
            QFile::remove(respPath);
            return QJsonObject{{QStringLiteral("ok"), false},
                               {QStringLiteral("error"), QStringLiteral("runner fifo unavailable")}};
        }
        const ssize_t w = ::write(fd, payload.constData(), payload.size());
        ::close(fd);
        if (w != (ssize_t)payload.size()) {
            soLog(QStringLiteral("fifo write failed: wrote=") + QString::number((int)w) +
                  QStringLiteral(" errno=") + QString::number(errno));
            QFile::remove(respPath);
            return QJsonObject{{QStringLiteral("ok"), false},
                               {QStringLiteral("error"), QStringLiteral("runner fifo write failed")}};
        }
        soLog(QStringLiteral("rpc sent id=") + QString::number(id) + QStringLiteral(" cmd=") + cmd.value(QStringLiteral("cmd")).toString());

        const int stepMs = 40;
        int waited = 0;
        while (waited < timeoutMs) {
            QThread::msleep(stepMs);
            waited += stepMs;
            QFile rf(respPath);
            if (rf.exists() && rf.open(QIODevice::ReadOnly)) {
                const QByteArray data = rf.readAll();
                rf.close();
                QFile::remove(respPath);
                QJsonParseError err;
                const QJsonDocument doc = QJsonDocument::fromJson(data, &err);
                if (err.error == QJsonParseError::NoError && doc.isObject()) {
                    soLog(QStringLiteral("rpc resp id=") + QString::number(id) + QStringLiteral(" ok=") +
                          doc.object().value(QStringLiteral("ok")).toBool());
                    return doc.object();
                }
                break;
            }
        }
        QFile::remove(respPath);
        soLog(QStringLiteral("rpc timeout id=") + QString::number(id));
        return QJsonObject{{QStringLiteral("ok"), false},
                           {QStringLiteral("error"), QStringLiteral("rpc timeout")}};
    }

    void soLog(const QString& msg) {
        QFile f(QStringLiteral("/tmp/lxpen_so.log"));
        if (f.open(QIODevice::Append | QIODevice::WriteOnly)) {
            f.write(("[lxpen] " + msg + "\n").toUtf8());
            f.close();
        }
    }

    /* 轮询宿主播放状态，直到进入 PLAYING（PlayState::PLAYING == 0）或超时 */
    bool waitForPlaying(int timeoutMs) {
        void* mpm = resolveTInstance(kYMediaPlayerManagerT);
        if (!mpm || !g_hook_api || !g_hook_api->querySymbol) return false;
        typedef int (*PlayStateFn)(void*);
        PlayStateFn getState = (PlayStateFn)g_hook_api->querySymbol("_ZNK19YMediaPlayerManager9playStateEv");
        if (!getState) return false;
        int waited = 0;
        while (waited < timeoutMs) {
            if (getState(mpm) == 0) return true; /* PLAYING */
            QThread::msleep(100);
            waited += 100;
        }
        return false;
    }

    bool doPlay(const QString& src, const QString& title, const QString& lrcPath, bool isUrl) {
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

        /* 强制停止当前播放，确保宿主能加载并切换新媒体（播放中直接 playAudio 不会换流） */
        SetPlayStateFn setState = (SetPlayStateFn)g_hook_api->querySymbol(kSetPlayState);
        if (setState) {
            int32_t stopped = 2; /* PlayState::STOPPED */
            setState(mpm, &stopped);
        }
        VoidFn pause = (VoidFn)g_hook_api->querySymbol(kOnClickedPause);
        if (pause) pause(mpm);

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
        if (setHasLrc) setHasLrc(mpm, !lrcPath.isEmpty());
        if (onClickedPlay) onClickedPlay(mpm);

        entity->~YColumnMediaEntity();
        return true;
    }

    QJsonArray m_queue;
    int m_index = -1;
    bool m_autoNext = false;
    QString m_quality;
    int m_rpcSeq = 0;
};

static LxPenPlayer* g_player = nullptr;
static OnSoundEndFn g_origOnSoundEnd = nullptr;
static void* (*g_origOnClickedNext)(void*, bool) = nullptr;
static void* (*g_origOnClickedPrev)(void*, bool) = nullptr;

static void* onSoundEndDetour(void* self, uint32_t seq) {
    if (g_origOnSoundEnd) g_origOnSoundEnd(self, seq);
    if (g_player) g_player->handleSongEnded();
    return self;
}

static void* onClickedNextDetour(void* self, bool a2) {
    if (g_player && g_player->isActive()) {
        g_player->handleNext();
        return nullptr;
    }
    if (g_origOnClickedNext) return g_origOnClickedNext(self, a2);
    return nullptr;
}

static void* onClickedPrevDetour(void* self, bool a2) {
    if (g_player && g_player->isActive()) {
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
        delete g_player;
        g_player = nullptr;
    }
}

} // extern "C"

#include "moc_lxpen_player.cpp"
