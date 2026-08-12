import QtQuick 2.12
import ".."
import "../components"

/* 播放页：封面/信息 + 控制 + 进度 + LRC 歌词 */
Item {
    id: playerPage
    anchors.fill: parent

    property alias lyricView: lyricView

    function positionLyric(idx) {
        if (lyricView.count > 0) lyricView.positionViewAtIndex(idx, ListView.Center)
    }

    TitleBar {
        title: root.currentSong ? root.currentSong.name : "播放"
        onBackClicked: root.page = "home"
    }

    /* 封面 + 歌名/歌手 */
    Rectangle {
        id: coverBox
        width: 52; height: 52
        anchors.left: parent.left; anchors.leftMargin: 8
        anchors.top: parent.top; anchors.topMargin: 36
        radius: 8
        color: Theme.card
        border.color: Theme.line
        border.width: 1

        Image {
            anchors.fill: parent
            source: root.coverPath.length > 0 ? "file://" + root.coverPath : ""
            fillMode: Image.PreserveAspectCrop
            visible: root.coverPath.length > 0
            onStatusChanged: { if (status === Image.Error) visible = false }
        }
        Text {
            anchors.centerIn: parent
            visible: root.coverPath.length === 0
            text: "♪"
            color: Theme.textSub
            font.pixelSize: 26
        }
    }

    Column {
        anchors.left: coverBox.right; anchors.leftMargin: 8
        anchors.right: parent.right; anchors.rightMargin: 8
        anchors.top: parent.top; anchors.topMargin: 38
        spacing: 2

        Text {
            width: parent.width
            text: root.currentSong ? root.currentSong.name : ""
            color: Theme.text
            font.pixelSize: Theme.pxNormal
            font.bold: true
            elide: Text.ElideRight
        }
        Text {
            width: parent.width
            text: root.currentSong ? root.currentSong.singer + "  ·  " + root.srcName(root.currentSong.source) : ""
            color: Theme.textSub
            font.pixelSize: Theme.pxSmall
            elide: Text.ElideRight
        }
    }

    /* 进度条 + 时间 */
    Rectangle {
        anchors.left: coverBox.right; anchors.leftMargin: 8
        anchors.right: parent.right; anchors.rightMargin: 8
        anchors.top: parent.top; anchors.topMargin: 78
        height: 22
        color: "transparent"

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            height: 3
            radius: 2
            color: Theme.cardHi

            Rectangle {
                width: parent.width * (root.duration > 0 ? Math.min(1, root.timePos / root.duration) : 0)
                height: parent.height
                radius: 2
                color: Theme.accent
            }
        }
        Text {
            anchors.left: parent.left
            anchors.bottom: parent.bottom
            text: root.fmtTime(root.timePos)
            color: Theme.textSub
            font.pixelSize: Theme.pxTiny
        }
        Text {
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            text: root.fmtTime(root.duration)
            color: Theme.textSub
            font.pixelSize: Theme.pxTiny
        }
        MouseArea {
            anchors.fill: parent
            onClicked: {
                var ratio = Math.max(0, Math.min(1, mouse.x / width))
                root.seekTo(root.duration * ratio)
            }
        }
    }

    /* 控制行 */
    Row {
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top; anchors.topMargin: 104
        spacing: 26

        Repeater {
            model: [ "prev", "toggle", "next" ]
            Rectangle {
                width: 40; height: 32
                radius: Theme.radiusSmall
                color: btn.pressed ? Theme.cardHi : Theme.card
                border.color: Theme.line
                border.width: 1
                Text {
                    anchors.centerIn: parent
                    text: modelData === "prev" ? "◀◀" : (modelData === "toggle" ? (root.paused ? "▶" : "||") : "▶▶")
                    color: Theme.text
                    font.pixelSize: Theme.pxBig
                }
                MouseArea {
                    id: btn
                    anchors.fill: parent
                    onClicked: {
                        if (modelData === "prev") root.playPrev()
                        else if (modelData === "toggle") root.togglePlay()
                        else root.playNext()
                    }
                }
            }
        }

        Rectangle {
            width: 44; height: 32
            radius: Theme.radiusSmall
            color: volArea.pressed ? Theme.cardHi : Theme.card
            border.color: Theme.line
            border.width: 1
            Text {
                anchors.centerIn: parent
                text: "音量"
                color: Theme.textSub
                font.pixelSize: Theme.pxTiny
            }
            MouseArea {
                id: volArea
                anchors.fill: parent
                onClicked: toast.show("音量 " + Math.round(root.volume * 100) + "%", 1500)
            }
        }
    }

    /* 歌词区 */
    Rectangle {
        anchors.left: parent.left; anchors.leftMargin: 6
        anchors.right: parent.right; anchors.rightMargin: 6
        anchors.top: parent.top; anchors.topMargin: 140
        anchors.bottom: parent.bottom
        clip: true
        color: "transparent"

        Text {
            anchors.centerIn: parent
            visible: !root.currentSong
            text: "暂无播放"
            color: Theme.textSub
            font.pixelSize: Theme.pxNormal
        }
        Text {
            anchors.centerIn: parent
            visible: root.currentSong && root.lyricData === null
            text: "歌词加载中..."
            color: Theme.textSub
            font.pixelSize: Theme.pxSmall
        }

        ListView {
            id: lyricView
            anchors.fill: parent
            visible: root.lyricData !== null && root.lyricData.length > 0
            model: root.lyricData
            spacing: 3
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            delegate: Column {
                width: lyricView.width
                Text {
                    width: parent.width
                    text: modelData.text
                    color: modelData.active ? Theme.accentBorder : Theme.textSub
                    font.pixelSize: Theme.pxSmall
                    font.bold: modelData.active
                    elide: Text.ElideRight
                    horizontalAlignment: Text.AlignHCenter
                }
                Text {
                    width: parent.width
                    visible: modelData.trans !== ""
                    text: modelData.trans
                    color: Theme.textSub
                    font.pixelSize: Theme.pxTiny
                    elide: Text.ElideRight
                    horizontalAlignment: Text.AlignHCenter
                }
            }
        }
        Text {
            anchors.centerIn: parent
            visible: root.lyricData !== null && root.lyricData.length === 0
            text: "暂无歌词"
            color: Theme.textSub
            font.pixelSize: Theme.pxSmall
        }
    }

    onVisibleChanged: {
        if (visible) root.updateLyricPosition()
    }
}
