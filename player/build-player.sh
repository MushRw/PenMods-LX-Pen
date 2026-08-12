#!/bin/sh
# 交叉编译 lxpen_player.so（aarch64，glibc 2.27，动态链设备 Qt5）
# 依赖：aarch64-linux-gnu-g++（6.5.0）与 aarch64 Qt 5.15.2（QTDIR）
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
QTDIR="${QTDIR:-$DIR/../.qt-aarch64}"
CC="${CC:-aarch64-linux-gnu-g++}"
MOC="$QTDIR/bin/moc"

if [ ! -x "$MOC" ]; then
    echo "moc not found at $MOC (set QTDIR to the aarch64 Qt 5.15.2 root)" >&2
    exit 1
fi

"$MOC" "$DIR/lxpen_player.cpp" -o "$DIR/moc_lxpen_player.cpp"

"$CC" -std=c++11 -fPIC -shared -O2 \
    -I"$QTDIR/include" \
    -I"$QTDIR/include/QtCore" \
    -I"$QTDIR/include/QtQml" \
    -I"$QTDIR/include/QtGui" \
    "$DIR/lxpen_player.cpp" "$DIR/moc_lxpen_player.cpp" \
    -L"$QTDIR/lib" \
    -lQt5Core -lQt5Qml -lQt5Gui -lQt5Network \
    -o "$DIR/../plugin/liblxpen_player.so"

strip "$DIR/../plugin/liblxpen_player.so" 2>/dev/null || true
echo "built: plugin/liblxpen_player.so"
