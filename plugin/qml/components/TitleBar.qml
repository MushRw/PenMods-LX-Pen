import QtQuick 2.12
import ".."

/* 通用标题栏：左返回 + 居中标题 + 可选右侧操作 */
Rectangle {
    id: bar
    width: parent ? parent.width : 320
    height: Theme.titleBarHeight
    color: "transparent"

    property string title: ""
    property bool showBack: true
    property string rightText: ""
    signal backClicked()
    signal rightClicked()

    Rectangle {
        visible: bar.showBack
        width: 32; height: 28
        anchors.left: parent.left; anchors.leftMargin: 4
        anchors.verticalCenter: parent.verticalCenter
        radius: Theme.radiusSmall
        color: backArea.pressed ? Theme.cardHi : "transparent"
        Canvas {
            anchors.centerIn: parent
            width: 16; height: 16
            onPaint: {
                var ctx = getContext("2d");
                ctx.clearRect(0, 0, width, height);
                ctx.strokeStyle = Theme.text;
                ctx.lineWidth = 2;
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                ctx.beginPath();
                ctx.moveTo(12, 3); ctx.lineTo(5, 8); ctx.lineTo(12, 13);
                ctx.stroke();
            }
        }
        MouseArea {
            id: backArea
            anchors.fill: parent
            onClicked: bar.backClicked()
        }
    }

    Text {
        anchors.centerIn: parent
        text: bar.title
        color: Theme.text
        font.pixelSize: Theme.pxTitle
        font.bold: true
        elide: Text.ElideRight
        width: 180
        horizontalAlignment: Text.AlignHCenter
    }

    Rectangle {
        visible: bar.rightText.length > 0
        width: 40; height: 28
        anchors.right: parent.right; anchors.rightMargin: 4
        anchors.verticalCenter: parent.verticalCenter
        radius: Theme.radiusSmall
        color: rightArea.pressed ? Theme.cardHi : "transparent"
        Text {
            anchors.centerIn: parent
            text: bar.rightText
            color: Theme.accentBorder
            font.pixelSize: Theme.pxSmall
        }
        MouseArea {
            id: rightArea
            anchors.fill: parent
            onClicked: bar.rightClicked()
        }
    }
}
