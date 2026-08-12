// SPDX-License-Identifier: GPL-3.0-only
/*
 * LX Pen 宿主播放器接管组件。
 * 把音源 URL（在线直连）或本地文件交给宿主 YMediaManager::playAudio 播放，
 * 宿主播放器自动提供播放页 / 悬浮窗 / 后台播放；hook onSoundEnd 驱动 QML 自动连播。
 */
#include "PluginSDK.h"

#include <QObject>
#include <QQmlEngine>
#include <QQmlContext>
#include <QString>
#include <QStringList>

#include <cstdint>
#include <cstdio>
#include <cstring>

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

/* ---------------- 播放器对象 ---------------- */

class LxPenPlayer : public QObject {
    Q_OBJECT
public:
    explicit LxPenPlayer(QObject* parent = nullptr) : QObject(parent) {}

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

signals:
    void songEnded();

private:
    bool doPlay(const QString& src, const QString& title, const QString& lrcPath, bool isUrl) {
        if (!g_hook_api || !g_hook_api->querySymbol) {
            fprintf(stderr, "[lxpen] hook api missing\n");
            return false;
        }
        void* yglobal = resolveInstance(kYGlobalInstance);
        void* ymedia = resolveInstance(kYMediaManagerInstance);
        void* mpm = resolveTInstance(kYMediaPlayerManagerT);
        if (!yglobal || !ymedia || !mpm) {
            fprintf(stderr, "[lxpen] host instances missing (g=%p m=%p p=%p)\n", yglobal, ymedia, mpm);
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
        if (setHasLrc) setHasLrc(mpm, !lrcPath.isEmpty());
        if (onClickedPlay) onClickedPlay(mpm);

        entity->~YColumnMediaEntity();
        return true;
    }
};

static LxPenPlayer* g_player = nullptr;
static OnSoundEndFn g_origOnSoundEnd = nullptr;

static void* onSoundEndDetour(void* self, uint32_t seq) {
    if (g_origOnSoundEnd) g_origOnSoundEnd(self, seq);
    if (g_player) {
        QMetaObject::invokeMethod(g_player, "songEnded", Qt::QueuedConnection);
    }
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
