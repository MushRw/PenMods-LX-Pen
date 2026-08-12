import QtQuick 2.12
import ".."

Item {
    id: toast
    anchors.fill: parent
    visible: false
    z: 1000

    property alias text: label.text

    Rectangle {
        anchors.centerIn: parent
        width: Math.min(parent.width - 40, label.contentWidth + 32)
        height: 34
        radius: 17
        color: "#CC000000"
        border.color: Theme.line
        border.width: 1

        Text {
            id: label
            anchors.centerIn: parent
            color: Theme.text
            font.pixelSize: Theme.pxNormal
            wrapMode: Text.Wrap
            horizontalAlignment: Text.AlignHCenter
        }
    }

    Timer {
        id: hideTimer
        interval: 2500
        onTriggered: toast.visible = false
    }

    function show(msg, ms) {
        text = msg
        visible = true
        hideTimer.interval = (ms === undefined ? 2500 : ms)
        hideTimer.restart()
    }
}
