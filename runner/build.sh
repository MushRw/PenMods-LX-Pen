#!/bin/sh
# 交叉编译 penmusic（目标：YDP02X，aarch64 Linux，glibc 2.27）
# 依赖：aarch64-linux-gnu-gcc（与 PenMods CI 相同的 6.5.0 工具链）
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
QJS="$DIR/quickjs"
CC="${CC:-aarch64-linux-gnu-gcc}"

mkdir -p "$DIR/../plugin/bin"

"$CC" -O2 -fno-strict-aliasing -std=c11 -D_GNU_SOURCE -DQUICKJS_NG_BUILD -I"$QJS" \
    -o "$DIR/../plugin/bin/penmusic" \
    "$DIR/penmusic.c" \
    "$QJS/quickjs.c" \
    "$QJS/libregexp.c" \
    "$QJS/libunicode.c" \
    "$QJS/dtoa.c" \
    -lm -ldl -lpthread

strip "$DIR/../plugin/bin/penmusic" 2>/dev/null || true
echo "built: $DIR/../plugin/bin/penmusic"
