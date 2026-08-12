import QtQuick 2.12
import ".."

/* 歌曲行：歌名/歌手/时长 + 来源标记 */
Item {
    id: row
    width: parent ? parent.width : 260
    height: 40

    property var song: null
    signal clicked()

    function srcName(s) {
        if (s === "kw") return "酷我"
        if (s === "kg") return "酷狗"
        if (s === "mg") return "咪咕"
        if (s === "wy") return "网易"
        if (s === "tx") return "QQ"
        return s
    }

    Rectangle {
        anchors.fill: parent
        radius: Theme.radiusSmall
        color: area.pressed ? Theme.cardHi : "transparent"
    }

    Text {
        id: nameText
        anchors.left: parent.left; anchors.leftMargin: 8
        anchors.right: singerText.left; anchors.rightMargin: 4
        anchors.verticalCenter: parent.verticalCenter
        text: row.song ? row.song.name : ""
        color: Theme.text
        font.pixelSize: Theme.pxNormal
        font.bold: true
        elide: Text.ElideRight
    }

    Text {
        id: singerText
        width: 62
        anchors.right: timeText.left; anchors.rightMargin: 4
        anchors.verticalCenter: parent.verticalCenter
        text: row.song ? row.song.singer : ""
        color: Theme.textSub
        font.pixelSize: Theme.pxSmall
        elide: Text.ElideRight
        horizontalAlignment: Text.AlignRight
    }

    Text {
        id: timeText
        width: 34
        anchors.right: sourceText.left; anchors.rightMargin: 4
        anchors.verticalCenter: parent.verticalCenter
        text: row.song ? row.song.interval : ""
        color: Theme.textSub
        font.pixelSize: Theme.pxTiny
        horizontalAlignment: Text.AlignRight
    }

    Text {
        id: sourceText
        width: 30
        anchors.right: parent.right; anchors.rightMargin: 6
        anchors.verticalCenter: parent.verticalCenter
        text: row.song ? srcName(row.song.source) : ""
        color: Theme.accentBorder
        font.pixelSize: Theme.pxTiny
        horizontalAlignment: Text.AlignRight
    }

    MouseArea {
        id: area
        anchors.fill: parent
        onClicked: row.clicked()
    }
}
