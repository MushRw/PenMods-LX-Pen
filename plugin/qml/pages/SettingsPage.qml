import QtQuick 2.12
import ".."
import "../components"

/* 设置页：音源脚本 / 音质 / 自动连播 / 重启 / 日志 */
Item {
    id: settingsPage
    anchors.fill: parent

    TitleBar {
        title: "设置"
        onBackClicked: root.page = "home"
    }

    Flickable {
        id: flick
        anchors.left: parent.left; anchors.leftMargin: 8
        anchors.right: parent.right; anchors.rightMargin: 8
        anchors.top: parent.top; anchors.topMargin: Theme.titleBarHeight + 4
        anchors.bottom: bottomBar.top; anchors.bottomMargin: 4
        contentWidth: width
        contentHeight: contentCol.height
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: contentCol
            width: parent.width
            spacing: 4

            Text {
                text: "音源脚本"
                color: Theme.textSub
                font.pixelSize: Theme.pxSmall
                font.bold: true
            }

            Repeater {
                model: root.scriptList
                Rectangle {
                    width: parent.width
                    height: 30
                    radius: Theme.radiusSmall
                    color: root.selectedScript === modelData.file ? Theme.accent : Theme.card
                    border.color: Theme.line
                    border.width: 1
                    Text {
                        anchors.left: parent.left; anchors.leftMargin: 10
                        anchors.verticalCenter: parent.verticalCenter
                        text: modelData.name + (modelData.version ? "  v" + modelData.version : "")
                        color: root.selectedScript === modelData.file ? "#FFFFFF" : Theme.text
                        font.pixelSize: Theme.pxSmall
                        elide: Text.ElideRight
                        width: parent.width - 20
                    }
                    MouseArea {
                        anchors.fill: parent
                        onClicked: {
                            if (root.selectedScript !== modelData.file) {
                                root.selectedScript = modelData.file
                                root.saveSettings()
                                root.restartRunner()
                            }
                        }
                    }
                }
            }

            Text {
                text: "默认音质"
                color: Theme.textSub
                font.pixelSize: Theme.pxSmall
                font.bold: true
            }
            Row {
                spacing: 6
                Repeater {
                    model: [ "128k", "320k", "flac" ]
                    Rectangle {
                        width: 52; height: 24
                        radius: 12
                        color: root.quality === modelData ? Theme.accent : Theme.card
                        border.color: Theme.line
                        border.width: 1
                        Text {
                            anchors.centerIn: parent
                            text: modelData
                            color: root.quality === modelData ? "#FFFFFF" : Theme.text
                            font.pixelSize: Theme.pxSmall
                        }
                        MouseArea {
                            anchors.fill: parent
                            onClicked: {
                                root.quality = modelData
                                root.saveSettings()
                            }
                        }
                    }
                }
            }

            Row {
                spacing: 8
                Rectangle {
                    width: (parent.parent.width - 8) / 2
                    height: 30
                    radius: Theme.radiusSmall
                    color: restartArea.pressed ? Theme.accentPressed : Theme.accent
                    border.color: Theme.accentBorder
                    border.width: 1
                    Text {
                        anchors.centerIn: parent
                        text: "重启 runner"
                        color: "#FFFFFF"
                        font.pixelSize: Theme.pxSmall
                    }
                    MouseArea {
                        id: restartArea
                        anchors.fill: parent
                        onClicked: root.restartRunner()
                    }
                }
            }

            Text {
                text: "日志（最近 8 条）"
                color: Theme.textSub
                font.pixelSize: Theme.pxSmall
                font.bold: true
            }
            Repeater {
                model: root.logLines.length > 8 ? root.logLines.slice(root.logLines.length - 8) : root.logLines
                Text {
                    width: parent.width
                    text: modelData
                    color: Theme.textSub
                    font.pixelSize: Theme.pxTiny
                    elide: Text.ElideRight
                }
            }
        }
    }

    Rectangle {
        id: bottomBar
        anchors.left: parent.left; anchors.leftMargin: 8
        anchors.right: parent.right; anchors.rightMargin: 8
        anchors.bottom: parent.bottom; anchors.bottomMargin: 6
        height: 30
        radius: Theme.radiusSmall
        color: stopArea.pressed ? "#C4273A" : Theme.danger
        Text {
            anchors.centerIn: parent
            text: "停止播放并退出"
            color: "#FFFFFF"
            font.pixelSize: Theme.pxSmall
        }
        MouseArea {
            id: stopArea
            anchors.fill: parent
            onClicked: {
                if (typeof lxpenPlayer !== "undefined" && lxpenPlayer && lxpenPlayer.stop) {
                    lxpenPlayer.stop()
                }
                root.exitPlugin()
            }
        }
    }
}
