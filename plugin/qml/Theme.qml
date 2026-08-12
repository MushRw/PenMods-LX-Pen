pragma Singleton
import QtQuick 2.12

/* LX Pen 深色主题，色值对齐词典笔 YColors */
QtObject {
    readonly property color bg:       "#1A1B1F"
    readonly property color bgAlt:    "#2D2E33"
    readonly property color card:     "#2D2E33"
    readonly property color cardHi:   "#3D3E44"
    readonly property color line:     "#515259"
    readonly property color text:     "#FFFFFF"
    readonly property color textSub:  "#909199"
    readonly property color accent:   "#2D73DC"
    readonly property color accentBorder: "#509DEB"
    readonly property color accentPressed: "#1F5FB8"
    readonly property color danger:   "#F03043"
    readonly property color success:  "#13B876"
    readonly property color orange:   "#FF8B20"

    readonly property int pxTiny:   9
    readonly property int pxSmall:  11
    readonly property int pxNormal: 13
    readonly property int pxTitle:  15
    readonly property int pxBig:    18

    readonly property int titleBarHeight: 30
    readonly property int radius: 10
    readonly property int radiusSmall: 5
    readonly property int sidebarWidth: 52
}
