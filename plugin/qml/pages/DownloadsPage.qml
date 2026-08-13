import QtQuick 2.12
import ".."
import "../components"

/* 下载页：已下载歌曲列表（点按播放、删除）；记录持久化在 LocalStorage */
Item {
    id: downloadsPage
    anchors.fill: parent

    TitleBar {
        title: "下载"
        onBackClicked: root.page = "home"
    }

    ListView {
        anchors.left: parent.left; anchors.leftMargin: 8
        anchors.right: parent.right; anchors.rightMargin: 8
        anchors.top: parent.top; anchors.topMargin: Theme.titleBarHeight + 4
        anchors.bottom: parent.bottom; anchors.bottomMargin: 6
        clip: true
        spacing: 2
        model: root.downloads

        delegate: Rectangle {
            width: parent.width
            height: 36
            radius: Theme.radiusSmall
            color: itemArea.pressed ? Theme.cardHi : Theme.card
            border.color: Theme.line
            border.width: 1

            Column {
                anchors.left: parent.left; anchors.leftMargin: 8
                anchors.right: delBtn.left; anchors.rightMargin: 6
                anchors.verticalCenter: parent.verticalCenter
                Text {
                    width: parent.width
                    text: modelData.name || ""
                    color: Theme.text
                    font.pixelSize: Theme.pxSmall
                    elide: Text.ElideRight
                }
                Text {
                    width: parent.width
                    text: modelData.singer || ""
                    color: Theme.textSub
                    font.pixelSize: Theme.pxTiny
                    elide: Text.ElideRight
                }
            }

            MouseArea {
                id: itemArea
                anchors.fill: parent
                onClicked: root.playDownload(modelData)
            }

            Rectangle {
                id: delBtn
                width: 44; height: 26
                anchors.right: parent.right; anchors.rightMargin: 6
                anchors.verticalCenter: parent.verticalCenter
                radius: Theme.radiusSmall
                color: delArea.pressed ? "#C4273A" : Theme.danger
                Text {
                    anchors.centerIn: parent
                    text: "删除"
                    color: "#FFFFFF"
                    font.pixelSize: Theme.pxTiny
                }
                MouseArea {
                    id: delArea
                    anchors.fill: parent
                    onClicked: root.removeDownload(modelData.path)
                }
            }
        }

        Text {
            anchors.centerIn: parent
            visible: root.downloads.length === 0
            text: "暂无下载，搜索结果点 ↓ 下载"
            color: Theme.textSub
            font.pixelSize: Theme.pxNormal
        }
    }
}
