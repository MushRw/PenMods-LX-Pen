import QtQuick 2.12

/* 封装宿主 YInputPage 弹出输入框（与 PenMods 生态一致，依赖 qmlCreateComponent） */
Item {
    id: helper

    property string initialText: ""
    signal accepted(string content)
    signal dismissed()

    function open(prefill) {
        if (prefill !== undefined && prefill !== null) initialText = String(prefill)
        if (typeof qmlCreateComponent !== "function") {
            console.warn("qmlCreateComponent not available")
            return
        }
        var component = qmlCreateComponent("YInputPage")
        if (!component) return
        if (Component.Ready === component.status) {
            var incubator = component.incubateObject(helper.parent)
            if (incubator.status !== Component.Ready) {
                incubator.onStatusChanged = function() {
                    if (incubator.status === Component.Ready) helper.inputPageCreated(incubator.object)
                }
            } else {
                helper.inputPageCreated(incubator.object)
            }
        }
    }

    function inputPageCreated(keyboardPage) {
        keyboardPage.backButtonClicked.connect(function() {
            qmlGlobal.inputPageShowing = false
            keyboardPage.todoDestroy()
            keyboardPage = null
            helper.dismissed()
        })
        keyboardPage.inputFinished.connect(function(content) {
            qmlGlobal.inputPageShowing = false
            keyboardPage.todoDestroy()
            keyboardPage = null
            helper.accepted(content)
        })
        keyboardPage.enterText(helper.initialText)
        keyboardPage.show()
        qmlGlobal.inputPageShowing = true
    }
}
