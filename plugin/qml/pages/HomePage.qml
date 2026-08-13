import QtQuick 2.12
import ".."
import "../components"

/* 首页：平台切换 + 搜索 + 结果列表；右侧竖排入口（热搜/榜单/歌单占位 + 设置） */
Item {
    id: homePage
    anchors.fill: parent

    /* 临时诊断：记录未被其他控件消费的点击坐标 */
    MouseArea {
        anchors.fill: parent
        z: -10
        onClicked: root.touchDebug("bg:" + Math.round(mouse.x) + "," + Math.round(mouse.y))
    }

    /* 左侧主区 */
    Item {
        anchors.left: parent.left
        anchors.right: sidebar.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom

        /* 标题行 */
        Text {
            anchors.left: parent.left; anchors.leftMargin: 8
            anchors.top: parent.top; anchors.topMargin: 4
            text: "LX Pen"
            color: Theme.text
            font.pixelSize: Theme.pxTitle
            font.bold: true
        }
        Text {
            anchors.left: parent.left; anchors.leftMargin: 70
            anchors.top: parent.top; anchors.topMargin: 7
            text: root.scriptReady ? "音源就绪" : (root.scriptError !== "" ? "音源异常" : "启动中...")
            color: root.scriptReady ? Theme.success : (root.scriptError !== "" ? Theme.danger : Theme.textSub)
            font.pixelSize: Theme.pxTiny
        }

        /* 搜索框 */
        Rectangle {
            id: searchBox
            anchors.left: parent.left; anchors.leftMargin: 8
            anchors.right: parent.right; anchors.rightMargin: 8
            anchors.top: parent.top; anchors.topMargin: 27
            height: 28
            radius: Theme.radiusSmall
            color: Theme.card
            border.color: Theme.line
            border.width: 1

            Text {
                anchors.left: parent.left; anchors.leftMargin: 10
                anchors.right: clearBtn.left; anchors.rightMargin: 4
                anchors.verticalCenter: parent.verticalCenter
                text: root.keyword === "" ? "搜索歌曲..." : root.keyword
                color: root.keyword === "" ? Theme.textSub : Theme.text
                font.pixelSize: Theme.pxNormal
                elide: Text.ElideRight
            }

            MouseArea {
                anchors.fill: parent
                onClicked: {
                    root.touchDebug("searchbox")
                    keyboard.open(root.keyword)
                }
            }

            /* 清空按钮：清空搜索框并回到搜索记录 */
            Rectangle {
                id: clearBtn
                z: 2
                width: 20; height: 20
                anchors.right: parent.right; anchors.rightMargin: 5
                anchors.verticalCenter: parent.verticalCenter
                radius: 10
                visible: root.keyword !== "" || root.searchResult.length > 0
                color: clearArea.pressed ? Theme.cardHi : "transparent"
                Text {
                    anchors.centerIn: parent
                    text: "×"
                    color: Theme.textSub
                    font.pixelSize: Theme.pxNormal
                    font.bold: true
                }
                MouseArea {
                    id: clearArea
                    anchors.fill: parent
                    onClicked: {
                        root.touchDebug("clearSearch")
                        root.keyword = ""
                        root.searchResult = []
                    }
                }
            }
        }

        /* 平台 chips */
        Row {
            id: chips
            anchors.left: parent.left; anchors.leftMargin: 8
            anchors.top: searchBox.bottom; anchors.topMargin: 5
            spacing: 5

            Repeater {
                model: [ { k: "kw", n: "酷我" }, { k: "kg", n: "酷狗" }, { k: "mg", n: "咪咕" }, { k: "wy", n: "网易" }, { k: "tx", n: "QQ" } ]
                Rectangle {
                    width: 46
                    height: 22
                    radius: 11
                    color: root.platform === modelData.k ? Theme.accent : Theme.card
                    border.color: Theme.line
                    border.width: 1
                    Text {
                        anchors.centerIn: parent
                        text: modelData.n
                        color: root.platform === modelData.k ? "#FFFFFF" : Theme.textSub
                        font.pixelSize: Theme.pxTiny
                    }
                    MouseArea {
                        anchors.fill: parent
                        onClicked: {
                            if (root.platform !== modelData.k) {
                                root.platform = modelData.k
                                root.saveSettings()
                                root.doSearch()
                            }
                        }
                    }
                }
            }
        }

        /* 结果列表 */
        ListView {
            id: listView
            anchors.left: parent.left; anchors.leftMargin: 4
            anchors.right: parent.right; anchors.rightMargin: 4
            anchors.top: chips.bottom; anchors.topMargin: 4
            anchors.bottom: parent.bottom
            clip: true
            model: root.searchResult
            spacing: 2
            boundsBehavior: Flickable.StopAtBounds

            delegate: SongRow {
                width: listView.width - 8
                song: modelData
                onClicked: root.playSong(modelData, index)
            }

            /* 搜索记录（无结果时显示，点击直接搜索） */
            ListView {
                id: historyView
                anchors.fill: parent
                visible: root.searchResult.length === 0 && !root.searching && root.searchHistory.length > 0
                model: root.searchHistory
                spacing: 2
                clip: true
                boundsBehavior: Flickable.StopAtBounds

                header: Text {
                    width: historyView.width
                    text: "搜索记录"
                    color: Theme.textSub
                    font.pixelSize: Theme.pxTiny
                    font.bold: true
                    leftPadding: 8
                    topPadding: 2
                }

                footer: Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: "清空搜索记录"
                    color: Theme.textSub
                    font.pixelSize: Theme.pxTiny
                    topPadding: 4
                    MouseArea {
                        anchors.fill: parent
                        onClicked: root.clearHistory()
                    }
                }

                delegate: Rectangle {
                    width: historyView.width - 8
                    height: 30
                    radius: Theme.radiusSmall
                    color: hisArea.pressed ? Theme.cardHi : "transparent"
                    Text {
                        anchors.left: parent.left; anchors.leftMargin: 8
                        anchors.verticalCenter: parent.verticalCenter
                        text: modelData
                        color: Theme.text
                        font.pixelSize: Theme.pxSmall
                        elide: Text.ElideRight
                        width: parent.width - 20
                    }
                    MouseArea {
                        id: hisArea
                        anchors.fill: parent
                        onClicked: root.searchKeyword(modelData)
                    }
                }
            }

            Text {
                anchors.centerIn: parent
                visible: root.searchResult.length === 0 && root.searchHistory.length === 0
                text: root.searching ? "搜索中..." : "输入关键词搜索"
                color: Theme.textSub
                font.pixelSize: Theme.pxNormal
            }
        }
    }

    /* 右侧竖排入口 */
    Rectangle {
        id: sidebar
        width: Theme.sidebarWidth
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        color: "transparent"

        Column {
            anchors.fill: parent
            anchors.topMargin: 4
            anchors.bottomMargin: 4
            spacing: 2

                Repeater {
                    model: [ { t: "热搜", toast: "热搜功能开发中" }, { t: "榜单", toast: "榜单功能开发中" }, { t: "歌单", toast: "歌单功能开发中" } ]
                    Rectangle {
                        width: 48; height: 24
                        anchors.horizontalCenter: parent.horizontalCenter
                        radius: Theme.radiusSmall
                        color: area.pressed ? Theme.cardHi : Theme.card
                    border.color: Theme.line
                    border.width: 1
                    Text {
                        anchors.centerIn: parent
                        text: modelData.t
                        color: Theme.textSub
                        font.pixelSize: Theme.pxSmall
                    }
                    MouseArea {
                        id: area
                        anchors.fill: parent
                        onClicked: {
                            root.touchDebug("placeholder")
                            toast.show(modelData.toast, 2000)
                        }
                    }
                }
            }

            Rectangle {
                width: 48; height: 24
                anchors.horizontalCenter: parent.horizontalCenter
                radius: Theme.radiusSmall
                color: dlArea.pressed ? Theme.accentPressed : Theme.accent
                border.color: Theme.accentBorder
                border.width: 1
                Text {
                    anchors.centerIn: parent
                    text: "下载"
                    color: "#FFFFFF"
                    font.pixelSize: Theme.pxSmall
                }
                MouseArea {
                    id: dlArea
                    anchors.fill: parent
                    onClicked: {
                        root.touchDebug("downloads")
                        root.page = "downloads"
                    }
                }
            }

            Rectangle {
                width: 48; height: 24
                anchors.horizontalCenter: parent.horizontalCenter
                radius: Theme.radiusSmall
                color: setArea.pressed ? Theme.accentPressed : Theme.accent
                border.color: Theme.accentBorder
                border.width: 1
                Text {
                    anchors.centerIn: parent
                    text: "设置"
                    color: "#FFFFFF"
                    font.pixelSize: Theme.pxSmall
                }
                MouseArea {
                    id: setArea
                    anchors.fill: parent
                    onClicked: {
                        root.touchDebug("settings")
                        root.page = "settings"
                    }
                }
            }

            Rectangle {
                width: 48; height: 24
                anchors.horizontalCenter: parent.horizontalCenter
                radius: Theme.radiusSmall
                color: exitArea.pressed ? Theme.cardHi : Theme.card
                border.color: Theme.line
                border.width: 1
                Text {
                    anchors.centerIn: parent
                    text: "退出"
                    color: Theme.textSub
                    font.pixelSize: Theme.pxSmall
                }
                MouseArea {
                    id: exitArea
                    anchors.fill: parent
                    onClicked: {
                        root.touchDebug("exit")
                        root.exitPlugin()
                    }
                }
            }
        }
    }
}
