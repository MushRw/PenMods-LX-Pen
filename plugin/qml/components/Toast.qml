import QtQuick 2.12
import ".."

/* 底部弹条提示（Rectangle 显式尺寸 + parent 空值保护，避免 0x0 不可见） */
Rectangle {
    id: toast
    width: Math.min(toastText.implicitWidth + 28, parent ? parent.width - 24 : 200)
    height: 30
    radius: 15
    color: "#E61A1B1F"
    border.color: Theme.line
    border.width: 1

    anchors.horizontalCenter: parent ? parent.horizontalCenter : undefined
    anchors.bottom: parent ? parent.bottom : undefined
    anchors.bottomMargin: 8

    visible: false
    opacity: 0
    z: 200

    Text {
        id: toastText
        anchors.centerIn: parent
        color: Theme.text
        font.pixelSize: Theme.pxNormal
        text: ""
        elide: Text.ElideRight
        width: parent.width - 20
        horizontalAlignment: Text.AlignHCenter
    }

    property var queue: []

    function display(msg, ms) {
        hideAnim.stop()
        toastText.text = msg
        toast.visible = true
        showAnim.restart()
        hideTimer.interval = (ms === undefined || ms === null) ? 2000 : ms
        hideTimer.restart()
    }

    function show(msg, ms) {
        if (toast.visible) {
            queue.push({ message: msg, duration: ms })
            if (queue.length > 2) queue.shift()
            return
        }
        display(msg, ms)
    }

    NumberAnimation {
        id: showAnim
        target: toast
        property: "opacity"
        from: 0
        to: 1
        duration: 150
    }

    Timer {
        id: hideTimer
        onTriggered: hideAnim.start()
    }

    NumberAnimation {
        id: hideAnim
        target: toast
        property: "opacity"
        from: 1
        to: 0
        duration: 180
        onFinished: {
            toast.visible = false
            if (queue.length > 0) {
                var next = queue.shift()
                display(next.message, next.duration)
            }
        }
    }
}
