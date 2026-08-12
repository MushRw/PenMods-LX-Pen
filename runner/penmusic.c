/*
 * penmusic - LX Music custom-source runner for Youdao dict pen (YDP02X)
 *
 * Runs lx-music custom source scripts (globalThis.lx event interface),
 * provides built-in multi-platform search (kw/kg/mg/wy), and controls
 * mpv over JSON IPC for audio playback.
 *
 * License: GPL-3.0 (see LICENSE). Some JS adapter logic is derived from
 * lx-music-mobile (MIT, (c) lyswhut/lx-music-mobile).
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdarg.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <time.h>
#include <sys/time.h>
#include <sys/stat.h>

#ifdef _WIN32
/* Windows compat (used only for local syntax checks; target is Linux) */
#include <winsock2.h>
#include <windows.h>
#include <winhttp.h>
#include <process.h>
#include <zlib.h>
#include <io.h>
#define dlopen(name, flags) ((void *)LoadLibraryA(name))
#define dlsym(handle, name) ((void *)GetProcAddress((HMODULE)(handle), (name)))
#define dlerror() ("")
#define RTLD_LAZY 0
#define RTLD_GLOBAL 0
#define DBG(...) do { fprintf(stderr, __VA_ARGS__); fflush(stderr); } while (0)
#else
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <dlfcn.h>
#endif

#include "quickjs.h"

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

typedef struct Dstr {
    char  *buf;
    size_t len;
    size_t cap;
} Dstr;

static void dstr_init(Dstr *d) { d->buf = NULL; d->len = 0; d->cap = 0; }

static void dstr_free(Dstr *d) { free(d->buf); d->buf = NULL; d->len = d->cap = 0; }

static void dstr_ensure(Dstr *d, size_t extra) {
    if (d->len + extra + 1 > d->cap) {
        size_t nc = d->cap ? d->cap * 2 : 256;
        while (nc < d->len + extra + 1) nc *= 2;
        d->buf = realloc(d->buf, nc);
        if (!d->buf) { fprintf(stderr, "[penmusic] OOM\n"); exit(2); }
        d->cap = nc;
    }
}

static void dstr_append(Dstr *d, const char *s, size_t n) {
    dstr_ensure(d, n);
    memcpy(d->buf + d->len, s, n);
    d->len += n;
    d->buf[d->len] = 0;
}

static void dstr_appendz(Dstr *d, const char *s) { dstr_append(d, s, strlen(s)); }

static void dstr_appendc(Dstr *d, char c) { dstr_append(d, &c, 1); }

static void dstr_printf(Dstr *d, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) { va_end(ap2); return; }
    dstr_ensure(d, (size_t)n);
    vsnprintf(d->buf + d->len, d->cap - d->len, fmt, ap2);
    va_end(ap2);
    d->len += (size_t)n;
}

static int64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* base64 */
static const char b64tab[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void b64_encode(const uint8_t *in, size_t len, Dstr *out) {
    size_t i;
    for (i = 0; i + 2 < len; i += 3) {
        uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8) | in[i + 2];
        dstr_appendc(out, b64tab[(v >> 18) & 63]);
        dstr_appendc(out, b64tab[(v >> 12) & 63]);
        dstr_appendc(out, b64tab[(v >> 6) & 63]);
        dstr_appendc(out, b64tab[v & 63]);
    }
    if (i < len) {
        uint32_t v = (uint32_t)in[i] << 16;
        int rem = (int)(len - i);
        if (rem == 2) v |= (uint32_t)in[i + 1] << 8;
        dstr_appendc(out, b64tab[(v >> 18) & 63]);
        dstr_appendc(out, b64tab[(v >> 12) & 63]);
        dstr_appendc(out, rem == 2 ? b64tab[(v >> 6) & 63] : '=');
        dstr_appendc(out, '=');
    }
}

static int b64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static char *xstrdup(const char *s) {
    if (!s) return NULL;
    size_t n = strlen(s);
    char *p = malloc(n + 1);
    if (p) memcpy(p, s, n + 1);
    return p;
}

static size_t b64_decode(const char *in, size_t len, uint8_t *out) {
    size_t o = 0, i = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (; i < len; i++) {
        char c = in[i];
        if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
        int v = b64_value(c);
        if (v < 0) continue;
        acc = (acc << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (uint8_t)((acc >> bits) & 0xff);
        }
    }
    return o;
}

/* ------------------------------------------------------------------ */
/* global state                                                        */
/* ------------------------------------------------------------------ */

static JSContext *g_ctx = NULL;
static JSRuntime *g_rt = NULL;

static int g_inited = 0;
static int g_quit = 0;
static int64_t g_start_ms = 0;

/* io */
static int g_fd_in = -1;
static int g_fd_out = -1;
static Dstr g_inbuf;
static Dstr g_outbuf;

/* ------------------------------------------------------------------ */
/* output (RPC -> QML)                                                 */
/* ------------------------------------------------------------------ */

static void out_enqueue(const char *json) {
    dstr_appendz(&g_outbuf, json);
    dstr_appendc(&g_outbuf, '\n');
}

static void out_flush(void) {
    if (g_fd_out < 0 || g_outbuf.len == 0) return;
    ssize_t w = write(g_fd_out, g_outbuf.buf, g_outbuf.len);
    if (w > 0) {
        memmove(g_outbuf.buf, g_outbuf.buf + w, g_outbuf.len - (size_t)w);
        g_outbuf.len -= (size_t)w;
        if (g_outbuf.len) g_outbuf.buf[g_outbuf.len] = 0;
    } else if (w < 0 && errno != EAGAIN && errno != EINTR && errno != EPIPE) {
        /* keep buffered */
    }
}

static void logline(const char *level, const char *text) {
    fprintf(stderr, "[penmusic] %s: %s\n", level, text);
    Dstr d;
    dstr_init(&d);
    dstr_printf(&d, "{\"event\":\"log\",\"level\":\"%s\",\"text\":\"", level);
    for (const char *p = text; *p; p++) {
        if (*p == '"' || *p == '\\') dstr_appendc(&d, '\\');
        else if ((unsigned char)*p >= 0x20) dstr_appendc(&d, *p);
        else dstr_printf(&d, "\\u%04x", (unsigned)(uint8_t)*p);
    }
    dstr_appendz(&d, "\"}");
    out_enqueue(d.buf);
    dstr_free(&d);
}

/* ------------------------------------------------------------------ */
/* dlopen'd native libraries                                           */
/* ------------------------------------------------------------------ */

/* libcurl */
typedef void CURL;
typedef void CURLM;
typedef struct curl_slist { char *data; struct curl_slist *next; } curl_slist;
typedef struct CURLMsg {
    int msg;                 /* CURLMSG_DONE == 1 */
    CURL *easy_handle;
    union { void *whatever; int result; } data;
} CURLMsg;

typedef struct CURLMsg *(*curl_multi_info_read_fn)(CURLM *, int *);

typedef size_t (*curl_write_fn)(char *, size_t, size_t, void *);

struct CurlApi {
    void *h;
    CURL *(*easy_init)(void);
    int (*easy_setopt)(CURL *, int, ...);
    CURLM *(*multi_init)(void);
    int (*multi_add_handle)(CURLM *, CURL *);
    int (*multi_remove_handle)(CURLM *, CURL *);
    int (*multi_perform)(CURLM *, int *);
    curl_multi_info_read_fn multi_info_read;
    void (*multi_cleanup)(CURLM *);
    void (*easy_cleanup)(CURL *);
    curl_slist *(*slist_append)(curl_slist *, const char *);
    void (*slist_free_all)(curl_slist *);
    int (*easy_getinfo)(CURL *, int, ...);
    const char *(*easy_strerror)(int);
};

static struct CurlApi C;
static CURLM *g_multi = NULL;

/* libmbedcrypto */
struct MbedApi {
    void *h;
    void (*md5)(const unsigned char *, size_t, unsigned char[16]);
    void (*aes_init)(void *);
    void (*aes_free)(void *);
    int (*aes_setkey_enc)(void *, const unsigned char *, unsigned int);
    int (*aes_crypt_cbc)(void *, int, size_t, unsigned char *, const unsigned char *, unsigned char *);
    int (*aes_crypt_ecb)(void *, int, const unsigned char *, unsigned char *);
    void (*pk_init)(void *);
    void (*pk_free)(void *);
    int (*pk_parse_public_key)(void *, const unsigned char *, size_t);
    int (*pk_encrypt)(void *, const unsigned char *, size_t, unsigned char *, size_t *, size_t,
                      int (*)(void *, unsigned char *, size_t), void *);
};

static struct MbedApi M;

/* libz */
#ifndef _WIN32
/* Windows 直接链接 zlib.h 的 z_stream */
typedef struct z_stream_s {
    const uint8_t *next_in;
    unsigned int avail_in;
    unsigned long total_in;
    uint8_t *next_out;
    unsigned int avail_out;
    unsigned long total_out;
    const char *msg;
    void *state;
    void *zalloc;
    void *zfree;
    void *opaque;
    int data_type;
    unsigned long adler;
    unsigned long reserved;
} z_stream;
#endif

struct ZApi {
    void *h;
    const char *(*zlibVersion)(void);
    int (*inflateInit2_)(z_stream *, int, const char *, int);
    int (*inflate)(z_stream *, int);
    int (*inflateEnd)(z_stream *);
    int (*deflateInit2_)(z_stream *, int, int, int, int, int, const char *, int);
    int (*deflate)(z_stream *, int);
    int (*deflateEnd)(z_stream *);
};

static struct ZApi Z;

static void *dl_sym_check(void *h, const char *name, const char *lib);

/* libc iconv（GB18030 -> UTF-8 等，dlopen libc.so.6） */
typedef void *(*IconvOpenFn)(const char *, const char *);
typedef size_t (*IconvFn)(void *, char **, size_t *, char **, size_t *);
typedef int (*IconvCloseFn)(void *);

struct IconvApi {
    void *h;
    IconvOpenFn open;
    IconvFn convert;
    IconvCloseFn close;
};

static struct IconvApi IC;

static int load_iconv(void) {
#ifdef _WIN32
    fprintf(stderr, "[penmusic] iconv unavailable on win32\n");
    return -1;
#else
    IC.h = dlopen("libc.so.6", RTLD_LAZY | RTLD_GLOBAL);
    if (!IC.h) {
        fprintf(stderr, "[penmusic] libc.so.6 not found, iconv disabled\n");
        return -1;
    }
    IC.open = (IconvOpenFn)dl_sym_check(IC.h, "iconv_open", "libc");
    IC.convert = (IconvFn)dl_sym_check(IC.h, "iconv", "libc");
    IC.close = (IconvCloseFn)dl_sym_check(IC.h, "iconv_close", "libc");
    if (!IC.open || !IC.convert || !IC.close) return -1;
    return 0;
#endif
}

static void *dl_sym_check(void *h, const char *name, const char *lib) {
    dlerror();
    void *p = dlsym(h, name);
    const char *e = dlerror();
    if (e) {
        fprintf(stderr, "[penmusic] missing symbol %s in %s: %s\n", name, lib, e);
        return NULL;
    }
    return p;
}

static int load_curl(void) {
    const char *names[] = { "libcurl.so.4", "libcurl.so", NULL };
    for (int i = 0; names[i]; i++) {
        void *h = dlopen(names[i], RTLD_LAZY | RTLD_GLOBAL);
        if (!h) continue;
        C.h = h;
        break;
    }
    if (!C.h) { fprintf(stderr, "[penmusic] libcurl not found, HTTP disabled\n"); return -1; }
    void **p = (void **)&C; /* p[0]=h, 函数指针从 p[1] 开始 */
    const char *syms[] = { "curl_easy_init", "curl_easy_setopt", "curl_multi_init",
                           "curl_multi_add_handle", "curl_multi_remove_handle",
                           "curl_multi_perform", "curl_multi_info_read", "curl_multi_cleanup",
                           "curl_easy_cleanup", "curl_slist_append", "curl_slist_free_all",
                           "curl_easy_getinfo", "curl_easy_strerror" };
    for (size_t i = 0; i < sizeof(syms) / sizeof(syms[0]); i++) {
        void *fn = dl_sym_check(C.h, syms[i], "libcurl");
        if (!fn) return -1;
        p[i + 1] = fn;
    }
    g_multi = C.multi_init();
    return g_multi ? 0 : -1;
}

#ifdef _WIN32
/* 开发版：Windows BCrypt(CNG) 提供 md5 / AES-128-ECB/CBC（RSA 留空，weapi 仅真机用） */
static BCRYPT_ALG_HANDLE g_bc_md5 = NULL;
static BCRYPT_ALG_HANDLE g_bc_aes = NULL;
static BCRYPT_KEY_HANDLE g_bc_aes_key = NULL;
static UCHAR g_bc_aes_keybuf[16];

static void bc_md5(const unsigned char *in, size_t len, unsigned char out[16]) {
    BCRYPT_HASH_HANDLE h = NULL;
    if (g_bc_md5 && BCryptCreateHash(g_bc_md5, &h, NULL, 0, NULL, 0, 0) == 0) {
        BCryptHashData(h, (PUCHAR)in, (ULONG)len, 0);
        BCryptFinishHash(h, out, 16, 0);
        BCryptDestroyHash(h);
    }
}

static void bc_aes_init(void *ctx) { (void)ctx; }
static void bc_aes_free(void *ctx) { (void)ctx; }

static int bc_aes_setkey_enc(void *ctx, const unsigned char *key, unsigned int bits) {
    (void)ctx;
    if (bits != 128) return -1;
    memcpy(g_bc_aes_keybuf, key, 16);
    if (g_bc_aes_key) { BCryptDestroyKey(g_bc_aes_key); g_bc_aes_key = NULL; }
    return BCryptGenerateSymmetricKey(g_bc_aes, &g_bc_aes_key, NULL, 0,
                                      g_bc_aes_keybuf, 16, 0) == 0 ? 0 : -1;
}

static int bc_aes_ecb(void *ctx, int mode, const unsigned char *input, unsigned char *output) {
    (void)ctx; (void)mode; /* js_aes_encrypt 已做 PKCS7 填充，这里按 16 字节单块加密 */
    ULONG done = 0;
    return BCryptEncrypt(g_bc_aes_key, (PUCHAR)input, 16, NULL, NULL, 0,
                         output, 16, &done, 0) == 0 ? 0 : -1;
}

static int bc_aes_cbc(void *ctx, int mode, size_t length, unsigned char *iv,
                      const unsigned char *input, unsigned char *output) {
    (void)ctx; (void)mode;
    ULONG done = 0;
    return BCryptEncrypt(g_bc_aes_key, (PUCHAR)input, (ULONG)length, NULL,
                         iv, 16, output, (ULONG)length, &done, 0) == 0 ? 0 : -1;
}
#endif

static int load_mbed(void) {
#ifdef _WIN32
    if (BCryptOpenAlgorithmProvider(&g_bc_md5, BCRYPT_MD5_ALGORITHM, NULL, 0) != 0) {
        fprintf(stderr, "[penmusic] BCrypt MD5 init failed\n");
        return -1;
    }
    if (BCryptOpenAlgorithmProvider(&g_bc_aes, BCRYPT_AES_ALGORITHM, NULL, 0) != 0) {
        fprintf(stderr, "[penmusic] BCrypt AES init failed\n");
        return -1;
    }
    M.h = (void *)1;
    M.md5 = (void (*)(const unsigned char *, size_t, unsigned char[16]))bc_md5;
    M.aes_init = bc_aes_init;
    M.aes_free = bc_aes_free;
    M.aes_setkey_enc = bc_aes_setkey_enc;
    M.aes_crypt_cbc = bc_aes_cbc;
    M.aes_crypt_ecb = bc_aes_ecb;
    M.pk_init = NULL;
    M.pk_free = NULL;
    M.pk_parse_public_key = NULL;
    M.pk_encrypt = NULL;
    return 0;
#else
    const char *names[] = { "libmbedcrypto.so.1", "libmbedcrypto.so.0", "libmbedcrypto.so", NULL };
    for (int i = 0; names[i]; i++) {
        void *h = dlopen(names[i], RTLD_LAZY | RTLD_GLOBAL);
        if (!h) continue;
        M.h = h;
        break;
    }
    if (!M.h) { fprintf(stderr, "[penmusic] libmbedcrypto not found, crypto disabled\n"); return -1; }
    void **p = (void **)&M; /* p[0]=h */
    /* YDP02X 的 mbedtls 2.7 只导出 _ret 后缀 API */
    const char *syms[] = { "mbedtls_md5_ret", "mbedtls_aes_init", "mbedtls_aes_free",
                           "mbedtls_aes_setkey_enc", "mbedtls_aes_crypt_cbc", "mbedtls_aes_crypt_ecb",
                           "mbedtls_pk_init", "mbedtls_pk_free", "mbedtls_pk_parse_public_key",
                           "mbedtls_pk_encrypt" };
    for (size_t i = 0; i < sizeof(syms) / sizeof(syms[0]); i++) {
        void *fn = dl_sym_check(M.h, syms[i], "libmbedcrypto");
        if (!fn) return -1;
        p[i + 1] = fn;
    }
    return 0;
#endif
}

static int load_zlib(void) {
#ifdef _WIN32
    Z.h = (void *)1;
    Z.zlibVersion = zlibVersion;
    Z.inflateInit2_ = inflateInit2_;
    Z.inflate = inflate;
    Z.inflateEnd = inflateEnd;
    Z.deflateInit2_ = deflateInit2_;
    Z.deflate = deflate;
    Z.deflateEnd = deflateEnd;
    return 0;
#else
    const char *names[] = { "libz.so.1", "libz.so", NULL };
    for (int i = 0; names[i]; i++) {
        void *h = dlopen(names[i], RTLD_LAZY | RTLD_GLOBAL);
        if (!h) continue;
        Z.h = h;
        break;
    }
    if (!Z.h) { fprintf(stderr, "[penmusic] libz not found, zlib disabled\n"); return -1; }
    void **p = (void **)&Z; /* p[0]=h */
    const char *syms[] = { "zlibVersion", "inflateInit2_", "inflate", "inflateEnd",
                           "deflateInit2_", "deflate", "deflateEnd" };
    for (size_t i = 0; i < sizeof(syms) / sizeof(syms[0]); i++) {
        void *fn = dl_sym_check(Z.h, syms[i], "libz");
        if (!fn) return -1;
        p[i + 1] = fn;
    }
    return 0;
#endif
}

/* mbedtls struct layouts (mbedtls 2.x) */
typedef struct { int nr; uint32_t *rk; uint32_t buf[68]; } MbedAesCtx;
typedef struct { const void *pk_info; void *pk_ctx; } MbedPkCtx;

#define MBED_AES_ENCRYPT 1
#define MBED_RSA_PKCS_V15 1

static int urandom_rng(void *opaque, unsigned char *out, size_t len) {
    (void)opaque;
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) return -1;
    size_t r = fread(out, 1, len, f);
    fclose(f);
    return r == len ? 0 : -1;
}

/* ------------------------------------------------------------------ */
/* QuickJS helpers                                                     */
/* ------------------------------------------------------------------ */

static JSValue js_str(JSContext *ctx, const char *s) { return JS_NewString(ctx, s); }

static JSValue js_bytes_val(JSContext *ctx, const uint8_t *buf, size_t len) {
    return JS_NewArrayBufferCopy(ctx, buf, len);
}

static int js_bytes(JSContext *ctx, JSValueConst v, const uint8_t **pbuf, size_t *plen) {
    if (JS_IsString(v)) {
        const char *s = JS_ToCStringLen(ctx, plen, v);
        if (!s) return -1;
        *pbuf = (const uint8_t *)s;
        return 0;
    }
    size_t n = 0;
    uint8_t *b = JS_GetArrayBuffer(ctx, &n, v);
    if (b) { *pbuf = b; *plen = n; return 0; }
    /* typed array（含 Buffer 垫片的 Uint8Array 子类）支持：读 .buffer/.byteOffset/.byteLength */
    JSValue bufv = JS_GetPropertyStr(ctx, v, "buffer");
    if (JS_IsObject(bufv)) {
        size_t off = 0, len = 0;
        JSValue offv = JS_GetPropertyStr(ctx, v, "byteOffset");
        JSValue lenv = JS_GetPropertyStr(ctx, v, "byteLength");
        if (JS_IsNumber(offv)) { uint32_t u = 0; JS_ToUint32(ctx, &u, offv); off = u; }
        if (JS_IsNumber(lenv)) { uint32_t u = 0; JS_ToUint32(ctx, &u, lenv); len = u; }
        uint8_t *bb = JS_GetArrayBuffer(ctx, &n, bufv);
        if (bb) {
            *pbuf = bb + off;
            *plen = len;
            JS_FreeValue(ctx, lenv);
            JS_FreeValue(ctx, offv);
            JS_FreeValue(ctx, bufv);
            return 0;
        }
        JS_FreeValue(ctx, lenv);
        JS_FreeValue(ctx, offv);
    }
    JS_FreeValue(ctx, bufv);
    return -1;
}

static void js_call_global(JSContext *ctx, const char *name, int argc, JSValueConst *argv) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, name);
    if (JS_IsFunction(ctx, fn)) {
        JSValue ret = JS_Call(ctx, fn, g, argc, argv);
        if (JS_IsException(ret)) {
            JSValue ex = JS_GetException(ctx);
            const char *s = JS_ToCString(ctx, ex);
            logline("error", s ? s : "unknown JS error");
            if (s) JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, ex);
        }
        JS_FreeValue(ctx, ret);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, g);
}

static void js_call_global_str(JSContext *ctx, const char *name, const char *arg) {
    JSValue v = js_str(ctx, arg);
    JSValueConst a = v;
    js_call_global(ctx, name, 1, &a);
    JS_FreeValue(ctx, v);
}

static void rejection_tracker(JSContext *ctx, JSValueConst promise, JSValueConst reason,
                              bool is_handled, void *opaque) {
    (void)promise; (void)opaque;
    if (!is_handled) {
        const char *s = JS_ToCString(ctx, reason);
        logline("error", s ? s : "unhandled promise rejection");
        if (s) JS_FreeCString(ctx, s);
    }
}

/* ------------------------------------------------------------------ */
/* timers                                                              */
/* ------------------------------------------------------------------ */

typedef struct Timer { int id; int64_t deadline; int active; } Timer;
static Timer g_timers[512];
static int g_timer_count = 0;

static void timer_add(int id, int64_t ms) {
    if (g_timer_count >= (int)(sizeof(g_timers) / sizeof(g_timers[0]))) return;
    g_timers[g_timer_count].id = id;
    g_timers[g_timer_count].deadline = now_ms() + ms;
    g_timers[g_timer_count].active = 1;
    g_timer_count++;
}

static void timer_clear(int id) {
    for (int i = 0; i < g_timer_count; i++)
        if (g_timers[i].active && g_timers[i].id == id) g_timers[i].active = 0;
}

static void timers_fire(void) {
    int64_t now = now_ms();
    for (int i = 0; i < g_timer_count; i++) {
        if (!g_timers[i].active) continue;
        if (now >= g_timers[i].deadline) {
            int id = g_timers[i].id;
            g_timers[i].active = 0;
            JSValue v = JS_NewInt32(g_ctx, id);
            JSValueConst a = v;
            js_call_global(g_ctx, "__lx_timer_fire", 1, &a);
            JS_FreeValue(g_ctx, v);
        }
    }
}

static int64_t next_timer_deadline(void) {
    int64_t best = -1;
    for (int i = 0; i < g_timer_count; i++) {
        if (!g_timers[i].active) continue;
        if (best < 0 || g_timers[i].deadline < best) best = g_timers[i].deadline;
    }
    return best;
}

/* ------------------------------------------------------------------ */
/* HTTP via curl_multi                                                 */
/* ------------------------------------------------------------------ */

/* curl option values (public stable ABI) */
#define CURLOPT_WRITEDATA 10001
#define CURLOPT_URL 10002
#define CURLOPT_POSTFIELDS 10015
#define CURLOPT_HTTPHEADER 10023
#define CURLOPT_HEADERDATA 10029
#define CURLOPT_CUSTOMREQUEST 10036
#define CURLOPT_FOLLOWLOCATION 52
#define CURLOPT_POSTFIELDSIZE 60
#define CURLOPT_SSL_VERIFYPEER 64
#define CURLOPT_SSL_VERIFYHOST 81
#define CURLOPT_USERAGENT 10018
#define CURLOPT_MAXREDIRS 68
#define CURLOPT_NOSIGNAL 99
#define CURLOPT_WRITEFUNCTION 20011
#define CURLOPT_HEADERFUNCTION 20079
#define CURLOPT_TIMEOUT_MS 155
#define CURLOPT_CAINFO 10065
#define CURLOPT_ACCEPT_ENCODING 10102
#define CURLINFO_RESPONSE_CODE 0x200002
#define CURLMSG_DONE 1

typedef struct HttpReq {
    int id;
    CURL *easy;
    curl_slist *headers;
    int binary;
    Dstr body;
    Dstr raw_headers;
    int status;
    int canceled;
    struct HttpReq *next;
} HttpReq;

static HttpReq *g_reqs = NULL;

static size_t curl_write_cb(char *ptr, size_t size, size_t nmemb, void *ud) {
    HttpReq *r = (HttpReq *)ud;
    dstr_append(&r->body, ptr, size * nmemb);
    return size * nmemb;
}

static size_t curl_header_cb(char *ptr, size_t size, size_t nmemb, void *ud) {
    HttpReq *r = (HttpReq *)ud;
    dstr_append(&r->raw_headers, ptr, size * nmemb);
    return size * nmemb;
}

static HttpReq *req_find(int id) {
    for (HttpReq *r = g_reqs; r; r = r->next)
        if (r->id == id) return r;
    return NULL;
}

static void req_done(HttpReq *r, int curl_ok, int curl_code, const char *force_err) {
    JSContext *ctx = g_ctx;
    /* Windows dev 后端（WinHTTP）没有 curl，C 函数指针为空，必须保护 */
    if (r->status == 0 && curl_ok && C.h) C.easy_getinfo(r->easy, CURLINFO_RESPONSE_CODE, &r->status);

    /* build resp JS object */
    JSValue resp = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, resp, "status", JS_NewInt32(ctx, r->status));

    JSValue hdrs = JS_NewObject(ctx);
    /* parse raw headers: last value wins */
    char *buf = malloc(r->raw_headers.len + 1);
    if (!buf) buf = (char *)"";
    else {
        memcpy(buf, r->raw_headers.buf ? r->raw_headers.buf : "", r->raw_headers.len);
        buf[r->raw_headers.len] = 0;
    }
    char *save = NULL;
    char *line = strtok_r(buf, "\n", &save);
    while (line) {
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\r' || line[n - 1] == '\n')) line[--n] = 0;
        char *colon = strchr(line, ':');
        if (colon && colon != line) {
            *colon = 0;
            char *k = line;
            char *v = colon + 1;
            while (*v == ' ') v++;
            JS_SetPropertyStr(ctx, hdrs, k, js_str(ctx, v));
            *colon = ':';
        }
        line = strtok_r(NULL, "\n", &save);
    }
    JS_SetPropertyStr(ctx, resp, "headers", hdrs);
    if (buf != (char *)"") free(buf);

    if (r->binary) {
        Dstr b64;
        dstr_init(&b64);
        b64_encode((const uint8_t *)(r->body.buf ? r->body.buf : ""), r->body.len, &b64);
        JS_SetPropertyStr(ctx, resp, "body", js_str(ctx, b64.buf ? b64.buf : ""));
        dstr_free(&b64);
    } else {
        JS_SetPropertyStr(ctx, resp, "body", js_str(ctx, r->body.buf ? r->body.buf : ""));
    }

    JSValue errv = JS_NULL;
    if (force_err) {
        char ebuf[512];
        snprintf(ebuf, sizeof ebuf, "{\"message\":\"%s\"}", force_err);
        errv = js_str(ctx, ebuf);
    } else if (!curl_ok) {
        const char *es = C.h ? C.easy_strerror(curl_code) : "request failed";
        char ebuf[256];
        snprintf(ebuf, sizeof ebuf, "{\"message\":\"%s\"}", es ? es : "curl error");
        errv = js_str(ctx, ebuf);
    }

    char idbuf[32];
    snprintf(idbuf, sizeof idbuf, "%d", r->id);
    JSValue idv = js_str(ctx, idbuf);
    JSValue errarg = errv;
    /* lx-shim 的 __lx_request_done 期望 respJson 是 JSON 字符串（原 PenMods-Music 传对象导致 bad response） */
    JSValue respJson = JS_JSONStringify(ctx, resp, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(respJson)) {
        respJson = js_str(ctx, "{}");
    }
    JSValueConst args[3] = { idv, errarg, respJson };
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__lx_request_done");
    if (JS_IsFunction(ctx, fn)) {
        JSValue ret = JS_Call(ctx, fn, g, 3, args);
        if (JS_IsException(ret)) {
            JSValue ex = JS_GetException(ctx);
            const char *s = JS_ToCString(ctx, ex);
            logline("error", s ? s : "request_done error");
            if (s) JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, ex);
        }
        JS_FreeValue(ctx, ret);
    }
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, g);
    JS_FreeValue(ctx, idv);
    JS_FreeValue(ctx, errv);
    JS_FreeValue(ctx, resp);
    JS_FreeValue(ctx, respJson);
}

static void req_cleanup(HttpReq *r) {
    if (g_multi && r->easy) C.multi_remove_handle(g_multi, r->easy);
    if (r->headers) C.slist_free_all(r->headers);
    if (r->easy) C.easy_cleanup(r->easy);
    dstr_free(&r->body);
    dstr_free(&r->raw_headers);
}

#ifdef _WIN32
static void winhttp_poll(void);
#endif

static void http_poll(void) {
#ifdef _WIN32
    winhttp_poll();
#endif
    if (!g_multi) return;
    int still = 0;
    C.multi_perform(g_multi, &still);
    int msgs = 0;
    CURLMsg *m;
    while ((m = C.multi_info_read(g_multi, &msgs)) != NULL) {
        if (m->msg == CURLMSG_DONE) {
            CURL *easy = m->easy_handle;
            int code = m->data.result;
            HttpReq *r = NULL;
            for (HttpReq **pp = &g_reqs; *pp; pp = &(*pp)->next) {
                if ((*pp)->easy == easy) { r = *pp; *pp = r->next; break; }
            }
            if (r) {
                req_done(r, code == 0, code, NULL);
                req_cleanup(r);
                free(r);
            } else {
                if (C.easy_cleanup) C.easy_cleanup(easy);
            }
        }
    }
}

static void http_cancel(int id) {
    HttpReq *r = req_find(id);
    if (!r) return;
    r->canceled = 1;
    for (HttpReq **pp = &g_reqs; *pp; pp = &(*pp)->next) {
        if ((*pp)->id == id) { *pp = r->next; break; }
    }
    req_done(r, 0, 0, "request canceled");
    req_cleanup(r);
    free(r);
}

#ifdef _WIN32
static void winhttp_poll(void);
#endif

/* ------------------------------------------------------------------ */
/* Windows dev backend: WinHTTP worker threads + stdin reader          */
/* ------------------------------------------------------------------ */

#ifdef _WIN32
static void rpc_line(const char *line);

typedef struct WinReq {
    int id;
    int binary;
    int status;
    int has_err;
    char errbuf[256];
    Dstr body;
    Dstr raw_headers;
    struct WinReq *next;
} WinReq;

typedef struct WinReqArgs {
    int id;
    int binary;
    int timeout;
    char *url;
    char *method;
    char *body;
    char **headers;
    int hcount;
} WinReqArgs;

static CRITICAL_SECTION g_win_lock;
static WinReq *g_win_reqs = NULL;
static volatile int g_win_ready = 0;

typedef struct StdinLine { char *text; struct StdinLine *next; } StdinLine;
static StdinLine *g_stdin_head = NULL;
static StdinLine *g_stdin_tail = NULL;

static unsigned __stdcall win_stdin_thread(void *arg) {
    (void)arg;
    /* 不用 CRT stdio（fgets），用裸 _read 自行切行。
     * 注：此前 g_ctx 被清零的根因是 JS_ExecutePendingJob(&g_ctx)，与读取方式无关。 */
    Dstr acc;
    dstr_init(&acc);
    char buf[4096];
    for (;;) {
        int n = _read(0, buf, sizeof buf);
        if (n <= 0) break;
        dstr_append(&acc, buf, (size_t)n);
        char *p = acc.buf ? acc.buf : "";
        while (p && *p) {
            char *nl = strchr(p, '\n');
            if (!nl) break;
            *nl = 0;
            char *line = p;
            p = nl + 1;
            size_t len = strlen(line);
            while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
            if (!len) continue;
            char *copy = malloc(len + 1);
            if (!copy) continue;
            memcpy(copy, line, len + 1);
            StdinLine *sl = malloc(sizeof *sl);
            if (!sl) { free(copy); continue; }
            sl->text = copy;
            sl->next = NULL;
            EnterCriticalSection(&g_win_lock);
            if (g_stdin_tail) g_stdin_tail->next = sl;
            else g_stdin_head = sl;
            g_stdin_tail = sl;
            LeaveCriticalSection(&g_win_lock);
        }
        size_t rem = p && *p ? strlen(p) : 0;
        if (rem > 0 && acc.buf) {
            memmove(acc.buf, p, rem + 1);
            acc.len = rem;
        } else {
            acc.len = 0;
            if (acc.buf) acc.buf[0] = 0;
        }
    }
    dstr_free(&acc);
    return 0;
}

/*
 * 旧实现（fgets 版）保留引用以说明：跨线程 CRT stdio 会破坏进程状态（g_ctx 被清零）。
 */
#if 0
static unsigned __stdcall win_stdin_thread_fgets(void *arg) {
    (void)arg;
    char line[8192];
    while (fgets(line, sizeof line, stdin)) {
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
        if (!n) continue;
        char *copy = malloc(n + 1);
        if (!copy) continue;
        memcpy(copy, line, n + 1);
        StdinLine *sl = malloc(sizeof *sl);
        if (!sl) { free(copy); continue; }
        sl->text = copy;
        sl->next = NULL;
        EnterCriticalSection(&g_win_lock);
        if (g_stdin_tail) g_stdin_tail->next = sl;
        else g_stdin_head = sl;
        g_stdin_tail = sl;
        LeaveCriticalSection(&g_win_lock);
    }
    return 0;
}
#endif

static void win_stdin_drain(void) {
    StdinLine *sl;
    EnterCriticalSection(&g_win_lock);
    sl = g_stdin_head;
    g_stdin_head = g_stdin_tail = NULL;
    LeaveCriticalSection(&g_win_lock);
    while (sl) {
        StdinLine *next = sl->next;
        rpc_line(sl->text);
        free(sl->text);
        free(sl);
        sl = next;
    }
}

static void win_req_done(WinReq *wr) {
    HttpReq shell;
    memset(&shell, 0, sizeof shell);
    shell.id = wr->id;
    shell.binary = wr->binary;
    shell.status = wr->status;
    shell.body = wr->body;          /* 转移所有权 */
    shell.raw_headers = wr->raw_headers;
    req_done(&shell, 1, 0, wr->has_err ? wr->errbuf : NULL);
    dstr_free(&shell.body);
    dstr_free(&shell.raw_headers);
    free(wr);
}

static void winhttp_poll(void) {
    if (!g_win_ready) return;
    WinReq *wr;
    EnterCriticalSection(&g_win_lock);
    wr = g_win_reqs;
    g_win_reqs = NULL;
    LeaveCriticalSection(&g_win_lock);
    while (wr) {
        WinReq *next = wr->next;
        win_req_done(wr);
        wr = next;
    }
}

static int winhttp_inflate_gzip(Dstr *out, const uint8_t *in, size_t inlen) {
    z_stream zs;
    memset(&zs, 0, sizeof zs);
    if (inflateInit2(&zs, 15 + 32) != Z_OK) return -1;
    zs.next_in = (Bytef *)in;
    zs.avail_in = (uInt)inlen;
    unsigned char chunk[16384];
    int ret = Z_OK;
    do {
        zs.next_out = chunk;
        zs.avail_out = sizeof chunk;
        ret = inflate(&zs, Z_NO_FLUSH);
        size_t produced = sizeof chunk - zs.avail_out;
        dstr_append(out, (const char *)chunk, produced);
    } while (ret == Z_OK && zs.avail_out == 0);
    inflateEnd(&zs);
    return ret == Z_STREAM_END || ret == Z_OK ? 0 : -1;
}

static unsigned __stdcall winhttp_worker(void *arg) {
    WinReqArgs *a = (WinReqArgs *)arg;
    WinReq *wr = calloc(1, sizeof *wr);
    if (!wr) goto cleanup_args;
    wr->id = a->id;
    wr->binary = a->binary;
    dstr_init(&wr->body);
    dstr_init(&wr->raw_headers);

    int urlWLen = MultiByteToWideChar(CP_UTF8, 0, a->url, -1, NULL, 0);
    wchar_t *urlW = urlWLen > 0 ? malloc((size_t)urlWLen * sizeof(wchar_t)) : NULL;
    if (!urlW) { wr->has_err = 1; snprintf(wr->errbuf, sizeof wr->errbuf, "oom url"); goto push; }
    MultiByteToWideChar(CP_UTF8, 0, a->url, -1, urlW, urlWLen);

    URL_COMPONENTS uc;
    memset(&uc, 0, sizeof uc);
    uc.dwStructSize = sizeof uc;
    uc.dwSchemeLength = (DWORD)-1;
    uc.dwHostNameLength = (DWORD)-1;
    uc.dwUrlPathLength = (DWORD)-1;
    uc.dwExtraInfoLength = (DWORD)-1;
    if (!WinHttpCrackUrl(urlW, 0, 0, &uc)) {
        wr->has_err = 1; snprintf(wr->errbuf, sizeof wr->errbuf, "bad url");
        free(urlW);
        goto push;
    }

    wchar_t host[256];
    int hlen = uc.dwHostNameLength < 255 ? (int)uc.dwHostNameLength : 255;
    memcpy(host, uc.lpszHostName, (size_t)hlen * sizeof(wchar_t));
    host[hlen] = 0;

    Dstr path;
    dstr_init(&path);
    if (uc.lpszUrlPath && uc.dwUrlPathLength) {
        int plen = MultiByteToWideChar(CP_UTF8, 0, "", 0, NULL, 0); /* noop */
        (void)plen;
        wchar_t *p = malloc(((size_t)uc.dwUrlPathLength + 1) * sizeof(wchar_t));
        if (p) {
            memcpy(p, uc.lpszUrlPath, (size_t)uc.dwUrlPathLength * sizeof(wchar_t));
            p[uc.dwUrlPathLength] = 0;
            int need = WideCharToMultiByte(CP_UTF8, 0, p, -1, NULL, 0, NULL, NULL);
            char *pb = malloc((size_t)need);
            if (pb) {
                WideCharToMultiByte(CP_UTF8, 0, p, -1, pb, need, NULL, NULL);
                dstr_appendz(&path, pb);
                free(pb);
            }
            free(p);
        }
    }
    if (uc.lpszExtraInfo && uc.dwExtraInfoLength) {
        wchar_t *e = malloc(((size_t)uc.dwExtraInfoLength + 1) * sizeof(wchar_t));
        if (e) {
            memcpy(e, uc.lpszExtraInfo, (size_t)uc.dwExtraInfoLength * sizeof(wchar_t));
            e[uc.dwExtraInfoLength] = 0;
            int need = WideCharToMultiByte(CP_UTF8, 0, e, -1, NULL, 0, NULL, NULL);
            char *eb = malloc((size_t)need);
            if (eb) {
                WideCharToMultiByte(CP_UTF8, 0, e, -1, eb, need, NULL, NULL);
                if (eb[0] != '?') dstr_appendc(&path, '?');
                dstr_appendz(&path, eb);
                free(eb);
            }
            free(e);
        }
    }
    if (!path.len) dstr_appendz(&path, "/");

    wchar_t methodW[16];
    MultiByteToWideChar(CP_UTF8, 0, a->method ? a->method : "GET", -1, methodW, 16);

    HINTERNET hSession = WinHttpOpen(L"penmusic/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                     WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) {
        wr->has_err = 1; snprintf(wr->errbuf, sizeof wr->errbuf, "winhttp open failed");
        free(urlW);
        dstr_free(&path);
        goto push;
    }
    HINTERNET hConnect = WinHttpConnect(hSession, host, uc.nPort, 0);
    if (!hConnect) {
        wr->has_err = 1; snprintf(wr->errbuf, sizeof wr->errbuf, "winhttp connect failed");
        WinHttpCloseHandle(hSession);
        free(urlW);
        dstr_free(&path);
        goto push;
    }
    wchar_t *pathW = NULL;
    {
        int need = MultiByteToWideChar(CP_UTF8, 0, path.buf ? path.buf : "/", -1, NULL, 0);
        pathW = malloc((size_t)need * sizeof(wchar_t));
        if (pathW) MultiByteToWideChar(CP_UTF8, 0, path.buf ? path.buf : "/", -1, pathW, need);
    }
    HINTERNET hReq = pathW
        ? WinHttpOpenRequest(hConnect, methodW, pathW, NULL, WINHTTP_NO_REFERER,
                             WINHTTP_DEFAULT_ACCEPT_TYPES,
                             uc.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0)
        : NULL;
    free(pathW);
    dstr_free(&path);
    free(urlW);
    if (!hReq) {
        wr->has_err = 1; snprintf(wr->errbuf, sizeof wr->errbuf, "winhttp openrequest failed");
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        goto push;
    }

    DWORD policy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(hReq, WINHTTP_OPTION_REDIRECT_POLICY, &policy, sizeof(policy));
    WinHttpSetTimeouts(hReq, 10000, 30000, (int)a->timeout, (int)a->timeout);

    wchar_t hdrsW[4096];
    hdrsW[0] = 0;
    for (int i = 0; i < a->hcount && wcslen(hdrsW) < 3000; i++) {
        wchar_t tmp[1024];
        MultiByteToWideChar(CP_UTF8, 0, a->headers[i], -1, tmp, 1024);
        wcscat_s(hdrsW, 4096, tmp);
        wcscat_s(hdrsW, 4096, L"\r\n");
    }

    BOOL sent = WinHttpSendRequest(hReq, hdrsW[0] ? hdrsW : WINHTTP_NO_ADDITIONAL_HEADERS, -1L,
                                   a->body ? (LPVOID)a->body : WINHTTP_NO_REQUEST_DATA,
                                   a->body ? (DWORD)strlen(a->body) : 0,
                                   a->body ? (DWORD)strlen(a->body) : 0, 0);
    if (!sent || !WinHttpReceiveResponse(hReq, NULL)) {
        wr->has_err = 1;
        snprintf(wr->errbuf, sizeof wr->errbuf, "winhttp send failed (%lu)", GetLastError());
        WinHttpCloseHandle(hReq);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        goto push;
    }

    /* 从原始响应头解析状态码（WinHTTP 数值查询在此环境返回 122） */
    DWORD hlen2 = 0;
    WinHttpQueryHeaders(hReq, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                        NULL, &hlen2, WINHTTP_NO_HEADER_INDEX);
    if (hlen2 > 0) {
        wchar_t *rawW = malloc(hlen2 + 2);
        if (rawW) {
            DWORD got = hlen2;
            if (WinHttpQueryHeaders(hReq, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                                    rawW, &got, WINHTTP_NO_HEADER_INDEX)) {
                int need = WideCharToMultiByte(CP_UTF8, 0, rawW, (int)got, NULL, 0, NULL, NULL);
                char *raw = malloc((size_t)need + 1);
                if (raw) {
                    WideCharToMultiByte(CP_UTF8, 0, rawW, (int)got, raw, need, NULL, NULL);
                    raw[need] = 0;
                    dstr_append(&wr->raw_headers, raw, strlen(raw));
                    free(raw);
                }
            }
            free(rawW);
        }
    }

    /* 从原始响应头解析状态码（WinHTTP 数值查询在此环境返回 122） */
    wr->status = 0;
    if (wr->raw_headers.len > 0 && wr->raw_headers.buf) {
        const char *line = wr->raw_headers.buf;
        const char *sp = strchr(line, ' ');
        if (sp) {
            int code = atoi(sp + 1);
            if (code > 0) wr->status = code;
        }
    }

    Dstr rawBody;
    dstr_init(&rawBody);
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(hReq, &avail) || avail == 0) break;
        char buf[16384];
        DWORD read = 0;
        if (!WinHttpReadData(hReq, buf, avail < sizeof buf ? avail : sizeof buf, &read)) break;
        if (read == 0) break;
        dstr_append(&rawBody, buf, read);
    }
    if (rawBody.len >= 4) {
        const unsigned char *bb = (const unsigned char *)rawBody.buf;
    }

    /* gzip 解压（WinHTTP 不自动解压） */
    wchar_t encW[64];
    DWORD encLen = sizeof encW;
    BOOL hasEnc = WinHttpQueryHeaders(hReq, WINHTTP_QUERY_CONTENT_ENCODING,
                                      WINHTTP_HEADER_NAME_BY_INDEX, encW, &encLen, WINHTTP_NO_HEADER_INDEX);
    int isGzip = 0;
    if (hasEnc) {
        if (wcsstr(encW, L"gzip")) isGzip = 1;
    }
    if (isGzip) {
        if (winhttp_inflate_gzip(&wr->body, (const uint8_t *)(rawBody.buf ? rawBody.buf : ""), rawBody.len) != 0) {
            wr->has_err = 1;
            snprintf(wr->errbuf, sizeof wr->errbuf, "gzip inflate failed");
        }
    } else {
        wr->body = rawBody;
        rawBody.buf = NULL;
        rawBody.len = 0;
    }
    dstr_free(&rawBody);

    WinHttpCloseHandle(hReq);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);

push:
    EnterCriticalSection(&g_win_lock);
    wr->next = g_win_reqs;
    g_win_reqs = wr;
    LeaveCriticalSection(&g_win_lock);

cleanup_args:
    free(a->url);
    free(a->method);
    free(a->body);
    for (int i = 0; i < a->hcount; i++) free(a->headers[i]);
    free(a->headers);
    free(a);
    return 0;
}

static int winhttp_start(int id, const char *url, const char *method, const char *body,
                         int binary, int timeout, char **headers, int hcount) {
    WinReqArgs *a = calloc(1, sizeof *a);
    if (!a) return -1;
    a->id = id;
    a->binary = binary;
    a->timeout = timeout > 0 ? timeout : 30000;
    a->url = xstrdup(url);
    a->method = xstrdup(method && *method ? method : "GET");
    if (body) a->body = xstrdup(body);
    a->headers = malloc(sizeof(char *) * (size_t)(hcount > 0 ? hcount : 1));
    if (!a->url || !a->method || !a->headers) {
        free(a->url); free(a->method); free(a->body); free(a->headers); free(a);
        return -1;
    }
    for (int i = 0; i < hcount; i++) a->headers[i] = xstrdup(headers[i]);
    a->hcount = hcount;
    uintptr_t th = _beginthreadex(NULL, 0, winhttp_worker, a, 0, NULL);
    if (!th) {
        free(a->url); free(a->method); free(a->body);
        for (int i = 0; i < hcount; i++) free(a->headers[i]);
        free(a->headers); free(a);
        return -1;
    }
    CloseHandle((HANDLE)th);
    return 0;
}
#endif

/* ------------------------------------------------------------------ */
/* mpv control                                                         */
/* ------------------------------------------------------------------ */

static int g_mpv_fd = -1;
static int g_mpv_connected = 0;
static char *g_mpv_sock = NULL;
static char *g_mpv_bin = NULL;
static int g_mpv_seq = 1000;
static int64_t g_mpv_next_poll = 0;
static double g_mpv_time = -1;
static double g_mpv_duration = -1;
static int g_mpv_pause = -1;
static int g_mpv_pending = 0;
static int g_mpv_end_event = 0;

static void mpv_spawn(void) {
    if (!g_mpv_bin || !g_mpv_sock) return;
    char cmd[2048];
    snprintf(cmd, sizeof cmd,
             "nohup '%s' --idle=yes --no-video --force-window=no --audio-display=no "
             "--input-ipc-server='%s' --volume=80 --cache=yes "
             "> /tmp/penmusic_mpv.log 2>&1 &",
             g_mpv_bin, g_mpv_sock);
    int r = system(cmd);
    (void)r;
}

static int mpv_connect(void) {
    if (g_mpv_connected) return 0;
#ifdef _WIN32
    (void)0;
#else
    for (int i = 0; i < 40 && !g_quit; i++) {
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) { usleep(100000); continue; }
        struct sockaddr_un addr;
        memset(&addr, 0, sizeof addr);
        addr.sun_family = AF_UNIX;
        snprintf(addr.sun_path, sizeof addr.sun_path, "%s", g_mpv_sock);
        if (connect(fd, (struct sockaddr *)&addr, sizeof addr) == 0) {
            g_mpv_fd = fd;
            g_mpv_connected = 1;
            g_mpv_next_poll = now_ms() + 500;
            return 0;
        }
        close(fd);
        usleep(100000);
    }
#endif
    logline("warn", "mpv IPC connect failed");
    return -1;
}

static void json_escape_into(Dstr *d, const char *s) {
    for (const char *p = s; *p; p++) {
        unsigned char c = (unsigned char)*p;
        switch (c) {
            case '"': dstr_appendz(d, "\\\""); break;
            case '\\': dstr_appendz(d, "\\\\"); break;
            case '\n': dstr_appendz(d, "\\n"); break;
            case '\r': dstr_appendz(d, "\\r"); break;
            case '\t': dstr_appendz(d, "\\t"); break;
            default:
                if (c < 0x20) dstr_printf(d, "\\u%04x", c);
                else dstr_appendc(d, (char)c);
        }
    }
}

static void mpv_send_raw(const char *line) {
    if (g_mpv_fd < 0) return;
    Dstr d;
    dstr_init(&d);
    dstr_appendz(&d, line);
    dstr_appendc(&d, '\n');
    ssize_t w = write(g_mpv_fd, d.buf, d.len);
    (void)w;
    dstr_free(&d);
}

static void mpv_cmd_str(const char *cmd, const char *arg) {
    Dstr d;
    dstr_init(&d);
    dstr_printf(&d, "{\"command\":[\"%s\",\"", cmd);
    json_escape_into(&d, arg);
    dstr_appendz(&d, "\"]}");
    mpv_send_raw(d.buf);
    dstr_free(&d);
}

static void mpv_cmd_str2(const char *cmd, const char *arg1, const char *arg2) {
    Dstr d;
    dstr_init(&d);
    dstr_printf(&d, "{\"command\":[\"%s\",\"", cmd);
    json_escape_into(&d, arg1);
    dstr_appendz(&d, "\",\"");
    json_escape_into(&d, arg2);
    dstr_appendz(&d, "\"]}");
    mpv_send_raw(d.buf);
    dstr_free(&d);
}

static void mpv_set_prop_bool(const char *prop, int value) {
    Dstr d;
    dstr_init(&d);
    dstr_printf(&d, "{\"command\":[\"set_property\",\"%s\",%s]}", prop, value ? "true" : "false");
    mpv_send_raw(d.buf);
    dstr_free(&d);
}

static void mpv_set_prop_num(const char *prop, double value) {
    Dstr d;
    dstr_init(&d);
    dstr_printf(&d, "{\"command\":[\"set_property\",\"%s\",%g]}", prop, value);
    mpv_send_raw(d.buf);
    dstr_free(&d);
}

static void mpv_get_prop(const char *prop, int rid) {
    Dstr d;
    dstr_init(&d);
    dstr_printf(&d, "{\"command\":[\"get_property\",\"%s\"],\"request_id\":%d}", prop, rid);
    mpv_send_raw(d.buf);
    dstr_free(&d);
}

static void mpv_emit_status(const char *state) {
    Dstr d;
    dstr_init(&d);
    dstr_printf(&d,
                "{\"event\":\"status\",\"state\":\"%s\",\"timePos\":%g,\"duration\":%g,\"paused\":%s}",
                state,
                g_mpv_time >= 0 ? g_mpv_time : -1.0,
                g_mpv_duration >= 0 ? g_mpv_duration : -1.0,
                g_mpv_pause > 0 ? "true" : (g_mpv_pause == 0 ? "false" : "null"));
    out_enqueue(d.buf);
    dstr_free(&d);
}

static void mpv_poll_props(void) {
    if (!g_mpv_connected) return;
    int64_t now = now_ms();
    if (now < g_mpv_next_poll) return;
    if (g_mpv_pending) {
        /* no replies yet; resend after 3s */
        g_mpv_next_poll = now + 3000;
        return;
    }
    g_mpv_next_poll = now + 1000;
    g_mpv_pending = 1;
    g_mpv_time = -1;
    g_mpv_duration = -1;
    g_mpv_pause = -1;
    mpv_get_prop("time-pos", 9001);
    mpv_get_prop("duration", 9002);
    mpv_get_prop("pause", 9003);
}

static void mpv_handle_line(const char *line) {
    if (!g_ctx) return;
    JSValue v = JS_ParseJSON(g_ctx, line, strlen(line), "<mpv>");
    if (JS_IsException(v)) {
        JSValue ex = JS_GetException(g_ctx);
        JS_FreeValue(g_ctx, ex);
        return;
    }
    JSValue rid_v = JS_GetPropertyStr(g_ctx, v, "request_id");
    if (JS_IsNumber(rid_v)) {
        int32_t rid = 0;
        JS_ToInt32(g_ctx, &rid, rid_v);
        JSValue data = JS_GetPropertyStr(g_ctx, v, "data");
        if (rid == 9001) {
            if (!JS_IsNull(data) && !JS_IsUndefined(data)) {
                double d = 0;
                JS_ToFloat64(g_ctx, &d, data);
                g_mpv_time = d;
            }
            g_mpv_pending--;
        } else if (rid == 9002) {
            if (!JS_IsNull(data) && !JS_IsUndefined(data)) {
                double d = 0;
                JS_ToFloat64(g_ctx, &d, data);
                g_mpv_duration = d;
            }
            g_mpv_pending--;
        } else if (rid == 9003) {
            if (JS_IsBool(data)) g_mpv_pause = JS_ToBool(g_ctx, data) ? 1 : 0;
            g_mpv_pending--;
        }
        if (g_mpv_pending < 0) g_mpv_pending = 0;
        if (g_mpv_pending == 0) {
            const char *state = "idle";
            if (g_mpv_pause == 0) state = "playing";
            else if (g_mpv_pause == 1 && g_mpv_time >= 0) state = "paused";
            mpv_emit_status(state);
        }
        JS_FreeValue(g_ctx, data);
    }
    JSValue ev = JS_GetPropertyStr(g_ctx, v, "event");
    if (JS_IsString(ev)) {
        const char *ename = JS_ToCString(g_ctx, ev);
        if (ename) {
            if (strcmp(ename, "end-file") == 0) {
                /* 只有自然播完/停止才触发 ended；替换曲目（loadfile）不应跳曲 */
                JSValue reason = JS_GetPropertyStr(g_ctx, v, "reason");
                const char *r = JS_IsString(reason) ? JS_ToCString(g_ctx, reason) : NULL;
                int do_end = r && (strcmp(r, "eof") == 0 || strcmp(r, "stop") == 0);
                if (r) JS_FreeCString(g_ctx, r);
                JS_FreeValue(g_ctx, reason);
                if (do_end) {
                    g_mpv_time = -1;
                    g_mpv_duration = -1;
                    g_mpv_pause = 1;
                    mpv_emit_status("ended");
                }
            } else if (strcmp(ename, "start-file") == 0) {
                g_mpv_pause = 0;
                mpv_emit_status("playing");
            }
            JS_FreeCString(g_ctx, ename);
        }
    }
    JS_FreeValue(g_ctx, ev);
    JS_FreeValue(g_ctx, rid_v);
    JS_FreeValue(g_ctx, v);
}

static void mpv_read(void) {
    char buf[4096];
    static Dstr acc;
    static int acc_init = 0;
    if (!acc_init) { dstr_init(&acc); acc_init = 1; }
    ssize_t n = read(g_mpv_fd, buf, sizeof buf - 1);
    if (n <= 0) {
        if (n == 0 || errno != EAGAIN) {
            close(g_mpv_fd);
            g_mpv_fd = -1;
            g_mpv_connected = 0;
            logline("warn", "mpv IPC disconnected");
        }
        return;
    }
    buf[n] = 0;
    dstr_append(&acc, buf, (size_t)n);
    char *p = acc.buf;
    while (p && *p) {
        char *nl = strchr(p, '\n');
        if (!nl) break;
        *nl = 0;
        if (*p) mpv_handle_line(p);
        p = nl + 1;
    }
    if (p && *p) {
        size_t rem = strlen(p);
        memmove(acc.buf, p, rem + 1);
        acc.len = rem;
    } else {
        acc.len = 0;
        if (acc.buf) acc.buf[0] = 0;
    }
}

static void mpv_quit(void) {
    if (g_mpv_connected) {
        mpv_send_raw("{\"command\":[\"quit\"]}");
        usleep(100000);
    }
    if (g_mpv_fd >= 0) { close(g_mpv_fd); g_mpv_fd = -1; }
    g_mpv_connected = 0;
}

/* ------------------------------------------------------------------ */
/* RPC input                                                           */
/* ------------------------------------------------------------------ */

static void handle_rpc_line(const char *line);

static void rpc_line(const char *line) {
    handle_rpc_line(line);
}

static void input_read(void) {
    char buf[4096];
    ssize_t n = read(g_fd_in, buf, sizeof buf - 1);
    if (n <= 0) {
        if (n < 0 && (errno == EAGAIN || errno == EINTR)) return;
        return;
    }
    buf[n] = 0;
    dstr_append(&g_inbuf, buf, (size_t)n);
    char *p = g_inbuf.buf;
    while (p && *p) {
        char *nl = strchr(p, '\n');
        if (!nl) break;
        *nl = 0;
        if (*p) rpc_line(p);
        p = nl + 1;
    }
    if (p && *p) {
        size_t rem = strlen(p);
        memmove(g_inbuf.buf, p, rem + 1);
        g_inbuf.len = rem;
    } else {
        g_inbuf.len = 0;
        if (g_inbuf.buf) g_inbuf.buf[0] = 0;
    }
}

/* ------------------------------------------------------------------ */
/* JS native functions                                                 */
/* ------------------------------------------------------------------ */

static JSValue js_set_timeout(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t id = 0, ms = 0;
    if (argc > 0) JS_ToInt32(ctx, &id, argv[0]);
    if (argc > 1) JS_ToInt32(ctx, &ms, argv[1]);
    if (ms < 0) ms = 0;
    timer_add(id, ms);
    return JS_UNDEFINED;
}

static JSValue js_clear_timeout(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t id = 0;
    if (argc > 0) JS_ToInt32(ctx, &id, argv[0]);
    timer_clear(id);
    return JS_UNDEFINED;
}

static JSValue js_request_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t id = 0;
    JS_ToInt32(ctx, &id, argv[0]);
    const char *url = JS_ToCString(ctx, argv[1]);
    if (!url) return JS_EXCEPTION;

    const char *method = "GET";
    const char *body = NULL;
    int timeout = 30000;
    int binary = 0;
    char *hdr[64];
    int hcount = 0;

    /* lx-shim 传的是 JSON 字符串（JSON.stringify(opts)），先解析成对象
     * （原 PenMods-Music 直接 IsObject 判断，导致所有 POST/请求体丢失） */
    JSValue opts = argv[2];
    JSValue optsParsed = JS_UNDEFINED;
    if (JS_IsString(opts)) {
        const char *optsJson = JS_ToCString(ctx, opts);
        if (optsJson) {
            optsParsed = JS_ParseJSON(ctx, optsJson, strlen(optsJson), "<opts>");
            JS_FreeCString(ctx, optsJson);
            if (!JS_IsException(optsParsed)) opts = optsParsed;
        }
    }
    if (JS_IsObject(opts)) {
        JSValue v = JS_GetPropertyStr(ctx, opts, "method");
        if (JS_IsString(v)) {
            const char *m = JS_ToCString(ctx, v);
            if (m && m[0]) method = m;
            if (m) JS_FreeCString(ctx, m);
        }
        JS_FreeValue(ctx, v);
        v = JS_GetPropertyStr(ctx, opts, "timeout");
        if (JS_IsNumber(v)) {
            int32_t t = 0;
            JS_ToInt32(ctx, &t, v);
            if (t > 0) timeout = t;
        }
        JS_FreeValue(ctx, v);
        v = JS_GetPropertyStr(ctx, opts, "binary");
        binary = JS_ToBool(ctx, v);
        JS_FreeValue(ctx, v);
        v = JS_GetPropertyStr(ctx, opts, "body");
        if (JS_IsString(v)) body = JS_ToCString(ctx, v);
        JS_FreeValue(ctx, v);
        v = JS_GetPropertyStr(ctx, opts, "headers");
        if (JS_IsArray(v)) {
            JSValue lenv = JS_GetPropertyStr(ctx, v, "length");
            int32_t len = 0;
            JS_ToInt32(ctx, &len, lenv);
            JS_FreeValue(ctx, lenv);
            for (int32_t i = 0; i < len; i++) {
                JSValue hv = JS_GetPropertyUint32(ctx, v, (uint32_t)i);
                const char *hs = JS_ToCString(ctx, hv);
                if (hs && hcount < 64) {
                    hdr[hcount++] = xstrdup(hs);
                    JS_FreeCString(ctx, hs);
                }
                JS_FreeValue(ctx, hv);
            }
        }
        JS_FreeValue(ctx, v);
    }

    if (!JS_IsUndefined(optsParsed)) JS_FreeValue(ctx, optsParsed);

#ifdef _WIN32
    if (!g_multi) {
        int rc = winhttp_start(id, url, method, body, binary, timeout, hdr, hcount);
        for (int i = 0; i < hcount; i++) free(hdr[i]);
        JS_FreeCString(ctx, url);
        if (body) JS_FreeCString(ctx, body);
        return rc == 0 ? JS_UNDEFINED : JS_ThrowTypeError(ctx, "winhttp start failed");
    }
#else
    if (!g_multi) {
        for (int i = 0; i < hcount; i++) free(hdr[i]);
        JS_FreeCString(ctx, url);
        if (body) JS_FreeCString(ctx, body);
        return JS_ThrowTypeError(ctx, "HTTP unavailable (libcurl missing)");
    }
#endif

    HttpReq *r = calloc(1, sizeof *r);
    if (!r) {
        for (int i = 0; i < hcount; i++) free(hdr[i]);
        JS_FreeCString(ctx, url);
        if (body) JS_FreeCString(ctx, body);
        return JS_ThrowTypeError(ctx, "OOM");
    }
    r->id = id;
    r->binary = binary;
    dstr_init(&r->body);
    dstr_init(&r->raw_headers);
    r->easy = C.easy_init();
    if (!r->easy) {
        for (int i = 0; i < hcount; i++) free(hdr[i]);
        free(r);
        JS_FreeCString(ctx, url);
        if (body) JS_FreeCString(ctx, body);
        return JS_ThrowTypeError(ctx, "curl init failed");
    }

    C.easy_setopt(r->easy, CURLOPT_URL, url);
    C.easy_setopt(r->easy, CURLOPT_WRITEFUNCTION, curl_write_cb);
    C.easy_setopt(r->easy, CURLOPT_WRITEDATA, r);
    C.easy_setopt(r->easy, CURLOPT_HEADERFUNCTION, curl_header_cb);
    C.easy_setopt(r->easy, CURLOPT_HEADERDATA, r);
    C.easy_setopt(r->easy, CURLOPT_FOLLOWLOCATION, 1L);
    C.easy_setopt(r->easy, CURLOPT_MAXREDIRS, 5L);
    C.easy_setopt(r->easy, CURLOPT_NOSIGNAL, 1L);
    C.easy_setopt(r->easy, CURLOPT_TIMEOUT_MS, (long)timeout);
    C.easy_setopt(r->easy, CURLOPT_ACCEPT_ENCODING, "");
    if (access("/etc/ssl/certs/ca-certificates.crt", R_OK) == 0) {
        C.easy_setopt(r->easy, CURLOPT_SSL_VERIFYPEER, 1L);
        C.easy_setopt(r->easy, CURLOPT_SSL_VERIFYHOST, 2L);
        C.easy_setopt(r->easy, CURLOPT_CAINFO, "/etc/ssl/certs/ca-certificates.crt");
    } else {
        /* 笔上无 CA bundle 时放宽校验（设备端场景） */
        C.easy_setopt(r->easy, CURLOPT_SSL_VERIFYPEER, 0L);
        C.easy_setopt(r->easy, CURLOPT_SSL_VERIFYHOST, 0L);
    }
    if (strcmp(method, "GET") != 0) {
        C.easy_setopt(r->easy, CURLOPT_CUSTOMREQUEST, method);
        if (body) {
            C.easy_setopt(r->easy, CURLOPT_POSTFIELDS, body);
            C.easy_setopt(r->easy, CURLOPT_POSTFIELDSIZE, (long)strlen(body));
        }
    }
    for (int i = 0; i < hcount; i++) {
        r->headers = C.slist_append(r->headers, hdr[i]);
        free(hdr[i]);
    }
    if (r->headers) C.easy_setopt(r->easy, CURLOPT_HTTPHEADER, r->headers);

    r->next = g_reqs;
    g_reqs = r;
    C.multi_add_handle(g_multi, r->easy);

    if (body && strcmp(method, "GET") == 0) {
        /* shim always supplies method for bodies; nothing to do */
    }
    JS_FreeCString(ctx, url);
    if (body) JS_FreeCString(ctx, body);
    return JS_UNDEFINED;
}

static JSValue js_request_cancel(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t id = 0;
    if (argc > 0) JS_ToInt32(ctx, &id, argv[0]);
    http_cancel(id);
    return JS_UNDEFINED;
}

static JSValue js_md5(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (!M.h) return JS_ThrowTypeError(ctx, "md5 unavailable (libmbedcrypto missing)");
    const uint8_t *p = NULL;
    size_t n = 0;
    if (js_bytes(ctx, argv[0], &p, &n) < 0) return JS_ThrowTypeError(ctx, "md5: bad input");
    unsigned char out[16];
    M.md5(p, n, out);
    char hex[33];
    for (int i = 0; i < 16; i++) snprintf(hex + i * 2, 3, "%02x", out[i]);
    return js_str(ctx, hex);
}

static JSValue js_aes_encrypt(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (!M.h) return JS_ThrowTypeError(ctx, "aes unavailable (libmbedcrypto missing)");
    const uint8_t *inp = NULL, *key = NULL, *iv = NULL;
    size_t inlen = 0, keylen = 0, ivlen = 0;
    if (js_bytes(ctx, argv[0], &inp, &inlen) < 0) return JS_ThrowTypeError(ctx, "aes: bad input");
    if (argc < 3) return JS_ThrowTypeError(ctx, "aes: missing key");
    if (js_bytes(ctx, argv[2], &key, &keylen) < 0) return JS_ThrowTypeError(ctx, "aes: bad key");
    if (argc > 3 && !JS_IsUndefined(argv[3])) {
        if (js_bytes(ctx, argv[3], &iv, &ivlen) < 0) return JS_ThrowTypeError(ctx, "aes: bad iv");
    }
    const char *mode = "cbc";
    if (argc > 1 && JS_IsString(argv[1])) {
        const char *m = JS_ToCString(ctx, argv[1]);
        if (m) mode = m;
    }
    int is_cbc = strcmp(mode, "ecb") != 0;
    if (keylen != 16) return JS_ThrowTypeError(ctx, "aes: key must be 16 bytes");
    if (is_cbc && ivlen != 16) return JS_ThrowTypeError(ctx, "aes: iv must be 16 bytes");

    /* PKCS7 pad */
    size_t pad = 16 - (inlen % 16);
    size_t outlen = inlen + pad;
    uint8_t *out = malloc(outlen);
    if (!out) return JS_ThrowTypeError(ctx, "OOM");
    memcpy(out, inp, inlen);
    memset(out + inlen, (int)pad, pad);

    MbedAesCtx ac;
    memset(&ac, 0, sizeof ac);
    M.aes_init(&ac);
    if (M.aes_setkey_enc(&ac, key, 128) != 0) {
        free(out);
        M.aes_free(&ac);
        return JS_ThrowTypeError(ctx, "aes setkey failed");
    }
    if (is_cbc) {
        unsigned char ivbuf[16];
        memcpy(ivbuf, iv, 16);
        if (M.aes_crypt_cbc(&ac, MBED_AES_ENCRYPT, outlen, ivbuf, out, out) != 0) {
            free(out);
            M.aes_free(&ac);
            return JS_ThrowTypeError(ctx, "aes cbc failed");
        }
    } else {
        for (size_t i = 0; i < outlen; i += 16) {
            if (M.aes_crypt_ecb(&ac, MBED_AES_ENCRYPT, out + i, out + i) != 0) {
                free(out);
                M.aes_free(&ac);
                return JS_ThrowTypeError(ctx, "aes ecb failed");
            }
        }
    }
    M.aes_free(&ac);
    JSValue ret = js_bytes_val(ctx, out, outlen);
    free(out);
    return ret;
}

static JSValue js_rsa_encrypt(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    if (!M.h || !M.pk_init) return JS_ThrowTypeError(ctx, "rsa unavailable (libmbedcrypto missing)");
    const uint8_t *inp = NULL;
    size_t inlen = 0;
    if (js_bytes(ctx, argv[0], &inp, &inlen) < 0) return JS_ThrowTypeError(ctx, "rsa: bad input");
    const char *pem = JS_ToCString(ctx, argc > 1 ? argv[1] : JS_UNDEFINED);
    if (!pem) return JS_ThrowTypeError(ctx, "rsa: bad key");
    if (inlen > 117) { JS_FreeCString(ctx, pem); return JS_ThrowTypeError(ctx, "rsa: input too long"); }
    MbedPkCtx pk;
    memset(&pk, 0, sizeof pk);
    M.pk_init(&pk);
    int pr = M.pk_parse_public_key(&pk, (const unsigned char *)pem, strlen(pem));
    if (pr != 0) {
        M.pk_free(&pk);
        JS_FreeCString(ctx, pem);
        return JS_ThrowTypeError(ctx, "rsa: parse public key failed");
    }
    uint8_t out[256];
    size_t olen = 0;
    int er = M.pk_encrypt(&pk, inp, inlen, out, &olen, sizeof out, urandom_rng, NULL);
    M.pk_free(&pk);
    JS_FreeCString(ctx, pem);
    if (er != 0) return JS_ThrowTypeError(ctx, "rsa encrypt failed");
    return js_bytes_val(ctx, out, olen);
}

static JSValue js_random_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t n = 16;
    if (argc > 0) JS_ToInt32(ctx, &n, argv[0]);
    if (n < 0 || n > (1 << 20)) n = 16;
    uint8_t *buf = malloc((size_t)n);
    if (!buf) return JS_ThrowTypeError(ctx, "OOM");
    FILE *f = fopen("/dev/urandom", "rb");
    size_t got = f ? fread(buf, 1, (size_t)n, f) : 0;
    if (f) fclose(f);
    if (got != (size_t)n) {
        /* fallback to clock entropy */
        for (int i = 0; i < n; i++) buf[i] = (uint8_t)(rand() & 0xff);
    }
    JSValue ret = js_bytes_val(ctx, buf, (size_t)n);
    free(buf);
    return ret;
}

static JSValue zlib_do(JSContext *ctx, JSValueConst input, int do_inflate) {
    if (!Z.h) return JS_ThrowTypeError(ctx, "zlib unavailable (libz missing)");
    const uint8_t *inp = NULL;
    size_t inlen = 0;
    if (js_bytes(ctx, input, &inp, &inlen) < 0) return JS_ThrowTypeError(ctx, "zlib: bad input");

    z_stream zs;
    memset(&zs, 0, sizeof zs);
    zs.next_in = inp;
    zs.avail_in = (unsigned int)inlen;

    /* inflate: 15+32 自动识别 zlib/gzip；deflate: 15 生成 zlib 格式（与 Node zlib.deflate 一致，
     * 原 PenMods-Music 用 -15 生成 raw 流，自己 inflate 反而解不了） */
    int windowBits = do_inflate ? (15 + 32) : 15;
    int init = do_inflate
        ? Z.inflateInit2_(&zs, windowBits, "1.2.11", (int)sizeof zs)
        : Z.deflateInit2_(&zs, 6, 8, windowBits, 8, 0, "1.2.11", (int)sizeof zs);
    if (init != 0) return JS_ThrowTypeError(ctx, "zlib init failed");

    Dstr out;
    dstr_init(&out);
    uint8_t chunk[16384];
    int ret = 0;
    do {
        zs.next_out = chunk;
        zs.avail_out = sizeof chunk;
        ret = do_inflate ? Z.inflate(&zs, 0) : Z.deflate(&zs, 0);
        size_t produced = sizeof chunk - zs.avail_out;
        dstr_append(&out, (const char *)chunk, produced);
    } while (ret == 0 && zs.avail_out == 0);

    if (do_inflate) Z.inflateEnd(&zs); else Z.deflateEnd(&zs);
    if (ret != 1 && !(do_inflate && ret == 1)) {
        if (ret != 1 && ret != 0) {
            dstr_free(&out);
            return JS_ThrowTypeError(ctx, "zlib failed");
        }
    }
    JSValue rv = js_bytes_val(ctx, (const uint8_t *)(out.buf ? out.buf : ""), out.len);
    dstr_free(&out);
    return rv;
}

static JSValue js_zlib_inflate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    return zlib_do(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, 1);
}

static JSValue js_zlib_deflate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    return zlib_do(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, 0);
}

static JSValue js_iconv_convert(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
#ifdef _WIN32
    /* 开发版用系统 GBK(CP936) 解码（真机走 glibc iconv GB18030） */
    const uint8_t *inp = NULL;
    size_t inlen = 0;
    if (js_bytes(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &inp, &inlen) < 0)
        return JS_ThrowTypeError(ctx, "iconv: bad input");
    int wlen = MultiByteToWideChar(936, 0, (const char *)inp, (int)inlen, NULL, 0);
    if (wlen <= 0) return JS_ThrowTypeError(ctx, "iconv: gbk decode failed");
    wchar_t *wb = malloc((size_t)wlen * sizeof(wchar_t));
    if (!wb) return JS_ThrowTypeError(ctx, "OOM");
    MultiByteToWideChar(936, 0, (const char *)inp, (int)inlen, wb, wlen);
    int ulen = WideCharToMultiByte(CP_UTF8, 0, wb, wlen, NULL, 0, NULL, NULL);
    char *ub = ulen > 0 ? malloc((size_t)ulen) : NULL;
    if (!ub) { free(wb); return JS_ThrowTypeError(ctx, "OOM"); }
    WideCharToMultiByte(CP_UTF8, 0, wb, wlen, ub, ulen, NULL, NULL);
    free(wb);
    JSValue ret = JS_NewStringLen(ctx, ub, (size_t)ulen);
    free(ub);
    return ret;
#else
    const uint8_t *inp = NULL;
    size_t inlen = 0;
    if (js_bytes(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &inp, &inlen) < 0)
        return JS_ThrowTypeError(ctx, "iconv: bad input");

    const char *from = "GB18030";
    const char *to = "UTF-8";
    const char *from_cs = NULL;
    const char *to_cs = NULL;
    if (argc > 1 && JS_IsString(argv[1])) {
        from_cs = JS_ToCString(ctx, argv[1]);
        if (from_cs) from = from_cs;
    }
    if (argc > 2 && JS_IsString(argv[2])) {
        to_cs = JS_ToCString(ctx, argv[2]);
        if (to_cs) to = to_cs;
    }

    if (!IC.open || !IC.convert || !IC.close) {
        if (from_cs) JS_FreeCString(ctx, from_cs);
        if (to_cs) JS_FreeCString(ctx, to_cs);
        return JS_ThrowTypeError(ctx, "iconv unavailable");
    }

    void *cd = IC.open(to, from);
    if (!cd || cd == (void *)-1) {
        if (from_cs) JS_FreeCString(ctx, from_cs);
        if (to_cs) JS_FreeCString(ctx, to_cs);
        return JS_ThrowTypeError(ctx, "iconv_open failed");
    }

    size_t outcap = inlen * 2 + 64;
    if (outcap < 64) outcap = 64;
    char *outbuf = malloc(outcap);
    if (!outbuf) {
        IC.close(cd);
        if (from_cs) JS_FreeCString(ctx, from_cs);
        if (to_cs) JS_FreeCString(ctx, to_cs);
        return JS_ThrowTypeError(ctx, "OOM");
    }

    char *inp_p = (char *)(uintptr_t)inp;
    size_t in_left = inlen;
    JSValue ret;
    for (;;) {
        char *out_p = outbuf;
        size_t out_left = outcap;
        size_t r = IC.convert(cd, &inp_p, &in_left, &out_p, &out_left);
        size_t produced = (size_t)(out_p - outbuf);
        if (r == (size_t)-1) {
            if (errno == E2BIG) {
                outcap *= 2;
                char *nb = realloc(outbuf, outcap);
                if (!nb) {
                    free(outbuf);
                    IC.close(cd);
                    if (from_cs) JS_FreeCString(ctx, from_cs);
                    if (to_cs) JS_FreeCString(ctx, to_cs);
                    return JS_ThrowTypeError(ctx, "OOM");
                }
                outbuf = nb;
                continue;
            }
            int saved = errno;
            free(outbuf);
            IC.close(cd);
            if (from_cs) JS_FreeCString(ctx, from_cs);
            if (to_cs) JS_FreeCString(ctx, to_cs);
            return JS_ThrowTypeError(ctx, "iconv failed: %s", strerror(saved));
        }
        ret = JS_NewStringLen(ctx, outbuf, produced);
        break;
    }
    free(outbuf);
    IC.close(cd);
    if (from_cs) JS_FreeCString(ctx, from_cs);
    if (to_cs) JS_FreeCString(ctx, to_cs);
    return ret;
#endif
}

static JSValue js_str_to_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    const char *s = JS_ToCString(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!s) return JS_ThrowTypeError(ctx, "str_to_bytes: bad input");
    JSValue ret = js_bytes_val(ctx, (const uint8_t *)s, strlen(s));
    JS_FreeCString(ctx, s);
    return ret;
}

static JSValue js_bytes_to_str(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    const uint8_t *p = NULL;
    size_t n = 0;
    if (js_bytes(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &p, &n) < 0)
        return JS_ThrowTypeError(ctx, "bytes_to_str: bad input");
    return JS_NewStringLen(ctx, (const char *)p, n);
}

static JSValue js_str_to_b64(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    const char *s = JS_ToCString(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!s) return JS_ThrowTypeError(ctx, "str_to_b64: bad input");
    Dstr d;
    dstr_init(&d);
    b64_encode((const uint8_t *)s, strlen(s), &d);
    JSValue ret = js_str(ctx, d.buf ? d.buf : "");
    dstr_free(&d);
    JS_FreeCString(ctx, s);
    return ret;
}

static JSValue js_b64_to_str(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    const char *s = JS_ToCString(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!s) return JS_ThrowTypeError(ctx, "b64_to_str: bad input");
    size_t inlen = strlen(s);
    uint8_t *tmp = malloc(inlen);
    if (!tmp) { JS_FreeCString(ctx, s); return JS_ThrowTypeError(ctx, "OOM"); }
    size_t olen = b64_decode(s, inlen, tmp);
    JSValue ret = JS_NewStringLen(ctx, (const char *)tmp, olen);
    free(tmp);
    JS_FreeCString(ctx, s);
    return ret;
}

static JSValue js_b64_to_bytes(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    const char *s = JS_ToCString(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!s) return JS_ThrowTypeError(ctx, "b64_to_bytes: bad input");
    size_t inlen = strlen(s);
    uint8_t *tmp = malloc(inlen);
    if (!tmp) { JS_FreeCString(ctx, s); return JS_ThrowTypeError(ctx, "OOM"); }
    size_t olen = b64_decode(s, inlen, tmp);
    JSValue ret = js_bytes_val(ctx, tmp, olen);
    free(tmp);
    JS_FreeCString(ctx, s);
    return ret;
}

static JSValue js_bytes_to_b64(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    const uint8_t *p = NULL;
    size_t n = 0;
    if (js_bytes(ctx, argc > 0 ? argv[0] : JS_UNDEFINED, &p, &n) < 0)
        return JS_ThrowTypeError(ctx, "bytes_to_b64: bad input");
    Dstr d;
    dstr_init(&d);
    b64_encode(p, n, &d);
    JSValue ret = js_str(ctx, d.buf ? d.buf : "");
    dstr_free(&d);
    return ret;
}

static JSValue js_send(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    const char *event = JS_ToCString(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    const char *data = JS_ToCString(ctx, argc > 1 ? argv[1] : JS_UNDEFINED);
    if (!event) return JS_UNDEFINED;
    Dstr d;
    dstr_init(&d);
    dstr_printf(&d, "{\"event\":\"%s\",\"data\":%s}", event, data ? data : "null");
    out_enqueue(d.buf);
    dstr_free(&d);
    if (strcmp(event, "inited") == 0) {
        g_inited = 1;
    }
    if (event) JS_FreeCString(ctx, event);
    if (data) JS_FreeCString(ctx, data);
    return JS_UNDEFINED;
}

static JSValue js_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    const char *level = JS_ToCString(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    const char *text = JS_ToCString(ctx, argc > 1 ? argv[1] : JS_UNDEFINED);
    logline(level ? level : "log", text ? text : "");
    if (level) JS_FreeCString(ctx, level);
    if (text) JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

static JSValue js_file_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    const char *path = JS_ToCString(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    const uint8_t *p = NULL;
    size_t n = 0;
    if (!path || js_bytes(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, &p, &n) < 0) {
        if (path) JS_FreeCString(ctx, path);
        return JS_NewBool(ctx, 0);
    }
    int ok = 0;
    FILE *f = fopen(path, "wb");
    if (f) {
        ok = fwrite(p, 1, n, f) == n;
        fclose(f);
    }
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, ok);
}

static JSValue js_file_exists(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    const char *path = JS_ToCString(ctx, argc > 0 ? argv[0] : JS_UNDEFINED);
    if (!path) return JS_NewBool(ctx, 0);
    struct stat st;
    int ok = stat(path, &st) == 0;
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, ok);
}

static JSValue js_rpc_done(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t id = 0;
    if (argc > 0) JS_ToInt32(ctx, &id, argv[0]);
    const char *json = JS_ToCString(ctx, argc > 1 ? argv[1] : JS_UNDEFINED);
    if (json) {
        /* 原 PenMods-Music 的 bug：响应不带 id，QML 的 pending 永远匹配不上 */
        Dstr d;
        dstr_init(&d);
        dstr_printf(&d, "{\"id\":%d,%s", id, json[0] == '{' ? json + 1 : json);
        out_enqueue(d.buf);
        dstr_free(&d);
        JS_FreeCString(ctx, json);
    }
    return JS_UNDEFINED;
}

static void register_natives(JSContext *ctx) {
    JSValue g = JS_GetGlobalObject(ctx);
    struct { const char *name; JSCFunction *fn; int len; } fns[] = {
        { "__lx_native_call__set_timeout", js_set_timeout, 2 },
        { "__lx_native_call__clear_timeout", js_clear_timeout, 1 },
        { "__lx_native_call__request_start", js_request_start, 3 },
        { "__lx_native_call__request_cancel", js_request_cancel, 1 },
        { "__lx_native_call__md5", js_md5, 1 },
        { "__lx_native_call__aes_encrypt", js_aes_encrypt, 4 },
        { "__lx_native_call__rsa_encrypt", js_rsa_encrypt, 2 },
        { "__lx_native_call__random_bytes", js_random_bytes, 1 },
        { "__lx_native_call__zlib_inflate", js_zlib_inflate, 1 },
        { "__lx_native_call__zlib_deflate", js_zlib_deflate, 1 },
        { "__lx_native_call__iconv_convert", js_iconv_convert, 3 },
        { "__lx_native_call__str_to_bytes", js_str_to_bytes, 1 },
        { "__lx_native_call__bytes_to_str", js_bytes_to_str, 1 },
        { "__lx_native_call__str_to_b64", js_str_to_b64, 1 },
        { "__lx_native_call__b64_to_str", js_b64_to_str, 1 },
        { "__lx_native_call__b64_to_bytes", js_b64_to_bytes, 1 },
        { "__lx_native_call__bytes_to_b64", js_bytes_to_b64, 1 },
        { "__lx_native_call__send", js_send, 2 },
        { "__lx_native_call__log", js_log, 2 },
        { "__lx_native_call__file_write", js_file_write, 2 },
        { "__lx_native_call__file_exists", js_file_exists, 1 },
        { "__lx_native_call__rpc_done", js_rpc_done, 2 },
    };
    for (size_t i = 0; i < sizeof(fns) / sizeof(fns[0]); i++)
        JS_SetPropertyStr(ctx, g, fns[i].name, JS_NewCFunction(ctx, fns[i].fn, fns[i].name, fns[i].len));
    JS_FreeValue(ctx, g);
}

/* ------------------------------------------------------------------ */
/* RPC handling (mpv commands)                                         */
/* ------------------------------------------------------------------ */

static void handle_mpv_cmd(const char *cmd, JSValueConst req) {
    if (strcmp(cmd, "play") == 0) {
        JSValue url = JS_GetPropertyStr(g_ctx, req, "url");
        const char *u = JS_ToCString(g_ctx, url);
        if (u) {
            mpv_cmd_str("loadfile", u);
            JS_FreeCString(g_ctx, u);
        }
        JS_FreeValue(g_ctx, url);
        JSValue title = JS_GetPropertyStr(g_ctx, req, "title");
        const char *t = JS_ToCString(g_ctx, title);
        if (t) {
            mpv_cmd_str2("set_property", "media-title", t);
            JS_FreeCString(g_ctx, t);
        }
        JS_FreeValue(g_ctx, title);
    } else if (strcmp(cmd, "pause") == 0) {
        mpv_set_prop_bool("pause", 1);
    } else if (strcmp(cmd, "resume") == 0) {
        mpv_set_prop_bool("pause", 0);
    } else if (strcmp(cmd, "toggle") == 0) {
        mpv_send_raw("{\"command\":[\"cycle\",\"pause\"]}");
    } else if (strcmp(cmd, "stop") == 0) {
        mpv_send_raw("{\"command\":[\"stop\"]}");
    } else if (strcmp(cmd, "seek") == 0) {
        JSValue v = JS_GetPropertyStr(g_ctx, req, "seconds");
        double s = 0;
        JS_ToFloat64(g_ctx, &s, v);
        JS_FreeValue(g_ctx, v);
        mpv_set_prop_num("time-pos", s);
    } else if (strcmp(cmd, "volume") == 0) {
        JSValue v = JS_GetPropertyStr(g_ctx, req, "volume");
        double n = 0;
        JS_ToFloat64(g_ctx, &n, v);
        JS_FreeValue(g_ctx, v);
        mpv_set_prop_num("volume", n);
    }
}

static void rpc_respond_ok(int id) {
    Dstr d;
    dstr_init(&d);
    dstr_printf(&d, "{\"id\":%d,\"ok\":true,\"data\":null}", id);
    out_enqueue(d.buf);
    dstr_free(&d);
}

/* cmd 'quit' handled in main loop; other mpv commands answered immediately */
static void handle_rpc_line(const char *line) {
    JSValue v = JS_ParseJSON(g_ctx, line, strlen(line), "<rpc>");
    if (JS_IsException(v)) {
        JSValue ex = JS_GetException(g_ctx);
        JS_FreeValue(g_ctx, ex);
        return;
    }
    JSValue cmdv = JS_GetPropertyStr(g_ctx, v, "cmd");
    if (JS_IsString(cmdv)) {
        const char *cmd = JS_ToCString(g_ctx, cmdv);
        if (cmd) {
            if (strcmp(cmd, "quit") == 0) {
                g_quit = 1;
            } else if (strcmp(cmd, "play") == 0 || strcmp(cmd, "pause") == 0 ||
                       strcmp(cmd, "resume") == 0 || strcmp(cmd, "toggle") == 0 ||
                       strcmp(cmd, "stop") == 0 || strcmp(cmd, "seek") == 0 ||
                       strcmp(cmd, "volume") == 0) {
                JSValue idv = JS_GetPropertyStr(g_ctx, v, "id");
                int32_t id = 0;
                JS_ToInt32(g_ctx, &id, idv);
                JS_FreeValue(g_ctx, idv);
                handle_mpv_cmd(cmd, v);
                rpc_respond_ok(id);
            } else {
                /* search / script / lyric / pic / cover / ping handled by JS */
                js_call_global_str(g_ctx, "__lx_on_rpc", line);
            }
            JS_FreeCString(g_ctx, cmd);
        }
    }
    JS_FreeValue(g_ctx, cmdv);
    JS_FreeValue(g_ctx, v);
}

/* ------------------------------------------------------------------ */
/* script loading                                                      */
/* ------------------------------------------------------------------ */

static int eval_file(JSContext *ctx, const char *path, int wrap_iife) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        logline("error", "cannot open script file");
        return -1;
    }
    Dstr src;
    dstr_init(&src);
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) dstr_append(&src, buf, n);
    fclose(f);

    const char *code = src.buf ? src.buf : "";
    size_t codelen = src.len;
    if (wrap_iife) {
        Dstr w;
        dstr_init(&w);
        dstr_appendz(&w, "(function(){\n");
        dstr_append(&w, code, codelen);
        dstr_appendz(&w, "\n})();");
        dstr_free(&src);
        src = w;
        code = src.buf;
        codelen = src.len;
    }
    JSValue ret = JS_Eval(ctx, code, codelen, path, JS_EVAL_TYPE_GLOBAL);
    dstr_free(&src);
    if (JS_IsException(ret)) {
        JSValue ex = JS_GetException(ctx);
        const char *s = JS_ToCString(ctx, ex);
        fprintf(stderr, "[penmusic] eval failed: %s\n", s ? s : "unknown error");
        Dstr d;
        dstr_init(&d);
        dstr_printf(&d, "{\"event\":\"initFailed\",\"error\":\"");
        const char *msg = s ? s : "script error";
        for (const char *p = msg; *p; p++) {
            if (*p == '"' || *p == '\\') dstr_appendc(&d, '\\');
            dstr_appendc(&d, *p);
        }
        dstr_appendz(&d, "\"}");
        out_enqueue(d.buf);
        dstr_free(&d);
        if (s) JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, ex);
        JS_FreeValue(ctx, ret);
        return -1;
    }
    JS_FreeValue(ctx, ret);
    return 0;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

static void usage(void) {
    fprintf(stderr,
            "penmusic - LX Music source runner for YDP02X\n"
            "usage: penmusic --script <path> [--js-dir <dir>]\n"
            "                 [--in <fifo|->] [--out <fifo|->]\n"
            "                 [--mpv <sock>] [--mpv-bin <path>]\n");
}

#ifdef _WIN32
static LONG WINAPI crash_handler(EXCEPTION_POINTERS *ep) {
    HMODULE base = GetModuleHandle(NULL);
    ULONG_PTR fault = 0;
    if (ep->ExceptionRecord->NumberParameters >= 2)
        fault = ep->ExceptionRecord->ExceptionInformation[1];
    fprintf(stderr, "[crash] code=0x%lx addr=%p base=%p off=%p fault=%p\n",
            ep->ExceptionRecord->ExceptionCode,
            ep->ExceptionRecord->ExceptionAddress,
            (void *)base,
            (void *)((uintptr_t)ep->ExceptionRecord->ExceptionAddress - (uintptr_t)base),
            (void *)fault);
    void *stack[24];
    USHORT frames = RtlCaptureStackBackTrace(0, 24, stack, NULL);
    for (USHORT i = 0; i < frames; i++) {
        fprintf(stderr, "  [%u] %p off=%p\n", i, stack[i],
                (void *)((uintptr_t)stack[i] - (uintptr_t)base));
    }
    fflush(stderr);
    return EXCEPTION_CONTINUE_SEARCH;
}
#endif

int main(int argc, char **argv) {
    const char *script = NULL;
    const char *jsdir = NULL;
    const char *inpath = NULL;
    const char *outpath = NULL;
    g_mpv_sock = NULL;
    g_mpv_bin = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--script") == 0 && i + 1 < argc) script = argv[++i];
        else if (strcmp(argv[i], "--js-dir") == 0 && i + 1 < argc) jsdir = argv[++i];
        else if (strcmp(argv[i], "--in") == 0 && i + 1 < argc) inpath = argv[++i];
        else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) outpath = argv[++i];
        else if (strcmp(argv[i], "--mpv") == 0 && i + 1 < argc) g_mpv_sock = argv[++i];
        else if (strcmp(argv[i], "--mpv-bin") == 0 && i + 1 < argc) g_mpv_bin = argv[++i];
        else if (strcmp(argv[i], "--help") == 0) { usage(); return 0; }
    }
    if (!script) { usage(); return 2; }
    if (!jsdir) jsdir = "js";
    if (!inpath) inpath = "-";
    if (!outpath) outpath = "-";

#ifndef _WIN32
    signal(SIGPIPE, SIG_IGN);
#endif
    srand((unsigned)time(NULL) ^ (unsigned)getpid());
    g_start_ms = now_ms();
    dstr_init(&g_inbuf);
    dstr_init(&g_outbuf);

    /* io */
#ifdef _WIN32
    g_fd_in = 0;
    g_fd_out = 1;
#else
    if (strcmp(inpath, "-") == 0) {
        g_fd_in = 0;
    } else {
        /* O_RDWR：避免写端在无读者时 O_NONBLOCK 打开返回 ENXIO（与 QML 读循环的启动竞态） */
        g_fd_in = open(inpath, O_RDWR | O_NONBLOCK);
        if (g_fd_in < 0) { fprintf(stderr, "[penmusic] cannot open in fifo %s\n", inpath); return 2; }
    }
    if (strcmp(outpath, "-") == 0) {
        g_fd_out = 1;
    } else {
        g_fd_out = open(outpath, O_RDWR | O_NONBLOCK);
        if (g_fd_out < 0) { fprintf(stderr, "[penmusic] cannot open out fifo %s\n", outpath); return 2; }
    }
#endif

    /* native libs */
    load_curl();
    load_mbed();
    load_zlib();
    load_iconv();
#ifdef _WIN32
    InitializeCriticalSection(&g_win_lock);
    g_win_ready = 1;
    SetUnhandledExceptionFilter(crash_handler);
    uintptr_t sth = _beginthreadex(NULL, 0, win_stdin_thread, NULL, 0, NULL);
    if (sth) CloseHandle((HANDLE)sth);
#endif

    /* JS runtime */
    g_rt = JS_NewRuntime();
    if (!g_rt) { fprintf(stderr, "[penmusic] JS_NewRuntime failed\n"); return 2; }
    JS_SetMemoryLimit(g_rt, 64 * 1024 * 1024);
    JS_SetMaxStackSize(g_rt, 1024 * 1024);
    JS_SetHostPromiseRejectionTracker(g_rt, rejection_tracker, NULL);
    g_ctx = JS_NewContext(g_rt);
    if (!g_ctx) { fprintf(stderr, "[penmusic] JS_NewContext failed\n"); return 2; }
    register_natives(g_ctx);

    /* load JS layers */
    char path[1024];
    snprintf(path, sizeof path, "%s/lx-shim.js", jsdir);
    if (eval_file(g_ctx, path, 1) < 0) return 1;
    snprintf(path, sizeof path, "%s/lx-sdk.js", jsdir);
    if (eval_file(g_ctx, path, 1) < 0) return 1;
    snprintf(path, sizeof path, "%s/normalize.js", jsdir);
    if (eval_file(g_ctx, path, 1) < 0) return 1;
    snprintf(path, sizeof path, "%s/runtime.js", jsdir);
    if (eval_file(g_ctx, path, 1) < 0) return 1;

    /* spawn mpv */
    if (g_mpv_sock) {
        mpv_spawn();
        mpv_connect();
    }

    /* user script */
    logline("info", "loading source script");
    if (eval_file(g_ctx, script, 0) < 0) return 1;

    /* main loop */
    int64_t init_deadline = now_ms() + 60000;
    while (!g_quit) {
        out_flush();

        /* select */
        fd_set rfds, wfds;
        FD_ZERO(&rfds);
        FD_ZERO(&wfds);
        int maxfd = -1;
        if (g_fd_in >= 0) { FD_SET(g_fd_in, &rfds); maxfd = g_fd_in; }
        if (g_mpv_fd >= 0) { FD_SET(g_mpv_fd, &rfds); if (g_mpv_fd > maxfd) maxfd = g_mpv_fd; }
        if (g_fd_out >= 0 && g_outbuf.len > 0) { FD_SET(g_fd_out, &wfds); if (g_fd_out > maxfd) maxfd = g_fd_out; }

        int64_t deadline = next_timer_deadline();
        int64_t now = now_ms();
        int timeout_ms = 100;
        if (deadline >= 0) {
            int64_t d = deadline - now;
            if (d < 0) d = 0;
            if (d < timeout_ms) timeout_ms = (int)d;
        }
        if (!g_inited) {
            int64_t remain = init_deadline - now;
            if (remain < 0) remain = 0;
            if (remain < timeout_ms) timeout_ms = (int)remain;
        }
        struct timeval tv;
        tv.tv_sec = timeout_ms / 1000;
        tv.tv_usec = (timeout_ms % 1000) * 1000;
        int sel = select(maxfd + 1, &rfds, g_outbuf.len ? &wfds : NULL, NULL, &tv);
#ifdef _WIN32
        if (sel < 0) Sleep(10); /* Windows select 对非 socket 立即返回 -1，避免忙等 */
#endif
        if (sel > 0) {
            if (g_fd_in >= 0 && FD_ISSET(g_fd_in, &rfds)) input_read();
            if (g_mpv_fd >= 0 && FD_ISSET(g_mpv_fd, &rfds)) mpv_read();
        }

        if (g_outbuf.len) out_flush();
        http_poll();
#ifdef _WIN32
        win_stdin_drain();
#endif
        timers_fire();

        /* run pending JS jobs (promises) */
        /* 注意：JS_ExecutePendingJob 会在任务队列为空时把 *pctx 置 NULL，
         * 不能传 &g_ctx（原 PenMods-Music 的 bug：每次循环都把全局 g_ctx 清零） */
        for (;;) {
            JSContext *job_ctx = g_ctx;
            int r = JS_ExecutePendingJob(g_rt, &job_ctx);
            if (job_ctx) g_ctx = job_ctx;
            if (r < 0) {
                JSValue ex = JS_GetException(g_ctx);
                const char *s = JS_ToCString(g_ctx, ex);
                logline("error", s ? s : "job error");
                if (s) JS_FreeCString(g_ctx, s);
                JS_FreeValue(g_ctx, ex);
                break;
            }
            if (r == 0) break;
        }

        mpv_poll_props();

        if (!g_inited && now_ms() > init_deadline) {
            out_enqueue("{\"event\":\"initFailed\",\"error\":\"script init timeout\"}");
            logline("error", "script init timeout");
            g_quit = 1;
        }
    }

    mpv_quit();
    out_flush();
    JS_FreeContext(g_ctx);
    JS_FreeRuntime(g_rt);
    if (g_fd_in >= 0 && g_fd_in != 0) close(g_fd_in);
    if (g_fd_out >= 0 && g_fd_out != 1) close(g_fd_out);
    return 0;
}
