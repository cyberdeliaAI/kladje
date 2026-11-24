// Drive only the disposable app, even when another copy of Kladje is running.
import AppKit
import ApplicationServices

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 3, let pid = Int32(args[0]),
      let process = NSRunningApplication(processIdentifier: pid),
      args[1].hasPrefix("app.kladje.qa."), process.bundleIdentifier == args[1],
      let bundle = process.bundleURL, !process.isTerminated else { exit(2) }
let app = AXUIElementCreateApplication(pid)

func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    AXUIElementCopyAttributeValue(element, key as CFString, &value)
    return value
}
func text(_ element: AXUIElement, _ key: String) -> String {
    attribute(element, key) as? String ?? ""
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    attribute(element, "AXChildren") as? [AXUIElement] ?? []
}
func title(_ element: AXUIElement) -> String { text(element, "AXTitle") }
func press(_ element: AXUIElement) {
    guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { exit(3) }
}
let windows = attribute(app, "AXWindows") as? [AXUIElement] ?? []
switch args[2] {
case "menu":
    guard args.count == 5, let bar = attribute(app, "AXMenuBar") else { exit(4) }
    let menus = children(bar as! AXUIElement)
    let parent = menus.first { args[3] == "App" ? title($0).contains("Kladje") : title($0) == args[3] }
    guard let parent = parent else {exit(5)}
    let front = attribute(app,"AXFocusedWindow") ?? attribute(app,"AXMainWindow")
    if !process.isActive {
        // Desktop focus may move while a probe is awaiting its IPC response.
        NSWorkspace.shared.openApplication(at:bundle, configuration:.init()) {_,_ in}
        let until = Date().addingTimeInterval(2)
        while !process.isActive && Date() < until { RunLoop.current.run(until:Date().addingTimeInterval(0.025)) }
    }
    guard process.isActive else {fputs("Test app could not acquire desktop focus.\n",stderr);exit(8)}
    if let front { AXUIElementPerformAction(front as! AXUIElement,kAXRaiseAction as CFString) }
    press(parent)
    guard let list = children(parent).first,
          let item = children(list).first(where: {title($0) == args[4]}) else {exit(5)}
    press(item)
case "tabs":
    let window = attribute(app, "AXFocusedWindow")
    let groups = window.map {children($0 as! AXUIElement)} ?? []
    let tabs = groups.filter {text($0, "AXRole") == "AXTabGroup"}.flatMap(children)
    print(tabs.filter {text($0, "AXRole") == "AXRadioButton"}.count)
case "answer":
    guard args.count == 4 else {exit(6)}
    func nativeElements(_ root: AXUIElement, depth: Int = 0) -> [AXUIElement] {
        guard depth < 12, text(root,"AXRole") != "AXWebArea" else {return []}
        return [root] + children(root).flatMap {nativeElements($0, depth:depth + 1)}
    }
    for window in windows {
        let sheets = attribute(window, "AXSheets") as? [AXUIElement] ?? []
        for dialog in sheets + [window] {
            let elements = nativeElements(dialog)
            guard let button = elements.first(where: {
                text($0, "AXRole") == "AXButton" && title($0) == args[3]
            }) else {continue}
            let detail = elements.filter {text($0, "AXRole") == "AXStaticText"}.map {text($0, "AXValue")}
            press(button)
            print("clicked " + detail.joined(separator:" "))
            exit(0)
        }
    }
default: exit(7)
}
