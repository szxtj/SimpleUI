import Cocoa
import UniformTypeIdentifiers
import WebKit

/// Markdown 编辑器独立窗口：承载 `http://127.0.0.1:31235/#/markdown`。
///
/// 与 3D 场景窗口同属「开放式顶栏」一类（内容画到窗口顶边、标题栏透明），
/// 但没有后台模型服务，因此**不需要** ensure / release 那一套生命周期：
/// WebView 常驻（关窗只 orderOut），重开窗口免冷加载，编辑中的内容也不会丢。
///
/// 未保存保护：页面把 `{name, edited, path}` 同步过来，这里落到 `isDocumentEdited`
/// （关闭按钮因此会出现小圆点）。关窗 / 退出时若仍有未保存内容会弹原生确认框。
final class MarkdownEditorWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// 顶部 52pt 拖拽带：与主窗口 / 3D 窗口同一套做法 —— 窗口内容伸到标题栏下方
/// （`.fullSizeContentView`），顶部这一条由本视图接管，可拖动整窗、双击切换标准尺寸。
///
/// `hitTest` 让两块区域穿透：
/// 1. 左侧 78pt —— 红绿黄三个按钮画在标题栏里，被遮住就点不到了；
/// 2. 右侧功能区 —— 编辑器的「打开 / 保存 / 另存为 / 三态切换」与红绿灯并排，
///    左边界由页面通过 `{action:"chromeHit", left}` 实时报上来（见 applyChromeHit），
///    页面没报时按窗口宽度的比例兜底，保证按钮不会整条被吃掉。
///
/// （WKWebView 会吞掉鼠标事件，光靠 `isMovableByWindowBackground` 拖不动窗口，
/// 所以拖拽只能由这一层接管；反过来，这一层不挖洞，网页按钮就点不动。）
final class MarkdownTitleBarDragView: NSView {
    private static let trafficLightZone: CGFloat = 78.0

    /// 右侧交互区起点（窗口内容坐标，pt）。nil → 用宽度比例兜底。
    var interactiveFromLeft: CGFloat?

    /// 兜底比例：还没收到页面上报时，右侧 55% 先让给功能项。
    /// 宁可拖拽区小一点，也不能让按钮点不动 —— 工具条点不动的观感比拖不动差得多。
    private static let fallbackInteractiveRatio: CGFloat = 0.55

    /// 双击缩放 / 缩放态拖拽还原（与主窗口同一份实现，见 WindowResizeChrome）
    weak var resizeChrome: WindowResizeChrome?

    private var dragging = false
    private var pendingUnzoom = false
    private var initialMouseLocation = NSPoint.zero
    private var initialWindowOrigin = NSPoint.zero

    override func hitTest(_ point: NSPoint) -> NSView? {
        // point 是 superview 坐标系
        guard frame.contains(point) else { return nil }
        let localPoint = convert(point, from: superview)
        if localPoint.x < Self.trafficLightZone { return nil }
        let holeStart = interactiveFromLeft
            ?? (bounds.width * (1 - Self.fallbackInteractiveRatio))
        if localPoint.x >= holeStart { return nil }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        guard let win = window else { return }
        if event.clickCount >= 2 {
            // 与主窗口一致：走带遮罩的自定义缩放，而不是系统的 performZoom
            resizeChrome?.toggleZoomAnimated()
            return
        }
        dragging = true
        initialMouseLocation = NSEvent.mouseLocation
        initialWindowOrigin = win.frame.origin
        pendingUnzoom = resizeChrome?.isZoomed ?? false
    }

    override func mouseDragged(with event: NSEvent) {
        guard dragging, let win = window else { return }
        let mouse = NSEvent.mouseLocation

        // 缩放态下首次实际拖动：先还原到原尺寸再无缝续拖（macOS 习惯）
        if pendingUnzoom {
            guard let restore = resizeChrome?.unzoomForTitleBarDrag(at: mouse, start: initialMouseLocation) else {
                return
            }
            initialMouseLocation = mouse
            initialWindowOrigin = restore.origin
            pendingUnzoom = false
            return
        }

        win.setFrameOrigin(NSPoint(
            x: initialWindowOrigin.x + (mouse.x - initialMouseLocation.x),
            y: initialWindowOrigin.y + (mouse.y - initialMouseLocation.y)
        ))
    }

    override func mouseUp(with event: NSEvent) {
        dragging = false
        pendingUnzoom = false
    }

    override var mouseDownCanMoveWindow: Bool { true }
}

final class MarkdownEditorPanelController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private static let defaultWidth: CGFloat = 1120
    private static let defaultHeight: CGFloat = 780
    private static let minWidth: CGFloat = 720
    private static let minHeight: CGFloat = 480

    private var panel: MarkdownEditorWindow?
    private var webView: WKWebView?
    private var dragView: MarkdownTitleBarDragView?
    private var webReady = false
    /// 尺寸遮罩 + 双击缩放（与主窗口、3D 窗口共用，见 WindowResizeChrome）
    private var resizeChrome: WindowResizeChrome?
    /// 全屏下关窗先退全屏（与主窗口同一套处理，见 FullscreenAwareCloser）
    private var fullscreenCloser: FullscreenAwareCloser?
    /// Markdown 内容原生桥：与主窗口、浮窗**同一份实现**（复制富文本/公式块、表格导出 Word、
    /// 图片预览与保存、划选翻译）。少了它，预览里的这些按钮会静默降级或直接不显示。
    private var markdownBridge: MarkdownContentBridge?

    var isVisible: Bool { panel?.isVisible ?? false }

    // MARK: - 开窗

    func showAndFocus() {
        if Thread.isMainThread {
            performShow()
        } else {
            DispatchQueue.main.async { [weak self] in self?.performShow() }
        }
    }

    private func performShow() {
        let p = panel ?? makePanel()
        panel = p
        if !webReady {
            loadContent()
        }

        if !p.isVisible {
            center(p)
        }
        p.makeKeyAndOrderFront(nil)
        p.orderFrontRegardless()
        // 重开窗口时让页面把最新状态（文件名 / 未保存标记）再推一次：
        // 上次关窗时原生已把 isDocumentEdited 清掉，不重推就会与页面上的小圆点脱钩
        webView?.evaluateJavaScript("window.__mdRequestState && window.__mdRequestState();") { _, _ in }
    }

    private func makePanel() -> MarkdownEditorWindow {
        let p = MarkdownEditorWindow(
            contentRect: NSRect(x: 0, y: 0, width: Self.defaultWidth, height: Self.defaultHeight),
            // `.fullSizeContentView`：内容一直画到窗口顶边，标题栏透明 —— 与主窗口同一套「开放式」外观
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        p.title = AppLocale.isZh ? "Markdown 编辑器" : "Markdown Editor"
        p.titleVisibility = .hidden
        p.titlebarAppearsTransparent = true
        p.isMovableByWindowBackground = true
        // 底色与页面根节点一致（#18191c / #f8f9fb），避免首帧/露边时闪白
        p.backgroundColor = Self.windowBackgroundColor()
        p.minSize = NSSize(width: Self.minWidth, height: Self.minHeight)
        p.isReleasedWhenClosed = false
        fullscreenCloser = FullscreenAwareCloser(window: p)
        p.isRestorable = false
        p.hidesOnDeactivate = false
        p.animationBehavior = .utilityWindow
        p.delegate = self

        let config = WKWebViewConfiguration()
        _ = makeWebView(in: p, config: config)
        installDragArea(in: p)
        // 实时拉伸遮罩 / 双击缩放 / 拖拽还原，整套与主窗口同一份实现
        resizeChrome = WindowResizeChrome(window: p, webView: webView!, above: dragView)
        dragView?.resizeChrome = resizeChrome
        return p
    }

    private static func windowBackgroundColor() -> NSColor {
        let isDark: Bool = {
            if let stored = UserDefaults.standard.object(forKey: "simpleui_is_dark") as? Bool {
                return stored
            }
            if let match = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) {
                return match == .darkAqua
            }
            return false
        }()
        return isDark
            ? NSColor(red: 24/255.0, green: 25/255.0, blue: 28/255.0, alpha: 1.0)
            : NSColor(red: 248/255.0, green: 249/255.0, blue: 251/255.0, alpha: 1.0)
    }

    /// 顶部 52pt 拖拽带（与前端预留的 52px 留白带等高，保证盖住的都是非交互区域）
    private func installDragArea(in panel: MarkdownEditorWindow) {
        guard let contentView = panel.contentView else { return }
        let drag = MarkdownTitleBarDragView()
        drag.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(drag, positioned: .above, relativeTo: webView)
        dragView = drag
        NSLayoutConstraint.activate([
            drag.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            drag.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            drag.topAnchor.constraint(equalTo: contentView.topAnchor),
            drag.heightAnchor.constraint(equalToConstant: 52.0)
        ])
    }

    private func makeWebView(in panel: MarkdownEditorWindow, config: WKWebViewConfiguration) -> WKWebView {
        let userContent = WKUserContentController()
        userContent.add(self, name: "mdEditor")
        // 预览区渲染的是同一个 MarkdownRenderer，它依赖的原生能力必须一并注册
        markdownBridge = MarkdownContentBridge.attach(to: userContent, hostWindow: panel)
        config.userContentController = userContent

        let wv = WKWebView(frame: panel.contentView?.bounds ?? .zero, configuration: config)
        wv.autoresizingMask = [.width, .height]
        wv.navigationDelegate = self
        // 没有它，网页里 <input type="file"> 的 click() 会静默无响应
        wv.uiDelegate = self
        panel.contentView?.addSubview(wv)
        webView = wv
        return wv
    }

    private func loadContent() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/#/markdown") else { return }
        webView?.load(URLRequest(url: url))
    }

    private func center(_ p: NSWindow) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSPointInRect(mouse, $0.frame) })
            ?? NSScreen.main ?? NSScreen.screens[0]
        let visible = screen.visibleFrame
        let origin = NSPoint(
            x: visible.midX - p.frame.width / 2,
            y: visible.midY - p.frame.height / 2
        )
        p.setFrameOrigin(origin)
    }

    func hide() {
        let apply: () -> Void = { [weak self] in self?.panel?.orderOut(nil) }
        if Thread.isMainThread {
            apply()
        } else {
            DispatchQueue.main.async(execute: apply)
        }
    }

    // MARK: - 脚本桥

    /// 页面 → 原生：
    ///   `{action:"open"}`                                    打开 .md（NSOpenPanel → 读文件 → `__mdFileOpened`）
    ///   `{action:"save", path, content}`                      写回已知路径（无路径时自动转「另存为」）
    ///   `{action:"saveAs", content, suggestedName}`           另存为（NSSavePanel）
    ///   `{action:"state", name, edited, path}`                同步文件名 / 未保存标记 / 代表文件
    ///   `{action:"chromeHit", left}`                          顶栏功能区左边界（拖拽层据此挖洞）
    ///   `{action:"confirmDiscard"}`                           覆盖未保存内容前的确认
    ///   `{action:"closeNow"}`                                 「保存并关闭」流程收尾
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "mdEditor", let dict = message.body as? [String: Any] else { return }
        let action = dict["action"] as? String ?? ""
        let run = { [weak self] in
            guard let self = self else { return }
            switch action {
            case "open":
                self.openDocument()
            case "save":
                self.writeDocument(path: dict["path"] as? String, content: dict["content"] as? String ?? "")
            case "saveAs":
                self.writeDocumentAs(
                    content: dict["content"] as? String ?? "",
                    suggestedName: dict["suggestedName"] as? String
                )
            case "state":
                self.applyDocumentState(dict)
            case "chromeHit":
                self.applyChromeHit(dict)
            case "confirmDiscard":
                self.confirmDiscard()
            case "cancelClose":
                // 「保存并关闭」流程里用户取消了另存为 / 落盘失败：撤掉挂起状态，
                // 否则下一次点关闭会被当成「已确认」而静默丢弃内容
                self.awaitingSaveBeforeClose = false
            case "closeNow":
                self.performCloseConfirmed()
            default:
                break
            }
        }
        if Thread.isMainThread {
            run()
        } else {
            DispatchQueue.main.async(execute: run)
        }
    }

    /// 回传结果给页面。`JSONSerialization` 的顶层必须是 Array / Dictionary —— 这里永远是字典，
    /// 传裸字符串会抛 ObjC 异常（`try?` 接不住）直接把进程 abort 掉。
    private func reply(_ function: String, _ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.\(function) && window.\(function)(\(json));"
        let apply: () -> Void = { [weak self] in
            self?.webView?.evaluateJavaScript(js) { _, _ in }
        }
        if Thread.isMainThread {
            apply()
        } else {
            DispatchQueue.main.async(execute: apply)
        }
    }

    /// 顶栏功能区的左边界（页面按 CSS px＝pt 上报）：拖拽层从这里往右让出鼠标事件。
    /// 夹在红绿灯右侧 40pt 之后，防止异常值把整条带子都让出去、窗口变成拖不动。
    private func applyChromeHit(_ dict: [String: Any]) {
        guard let raw = dict["left"] as? Double else { return }
        let left = CGFloat(raw)
        guard left > 0, let win = panel else { return }
        let clamped = min(max(left - 6, 118), win.frame.width)
        dragView?.interactiveFromLeft = clamped
    }

    private func applyDocumentState(_ dict: [String: Any]) {
        guard let win = panel else { return }
        let name = (dict["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let edited = (dict["edited"] as? Bool) ?? false
        let path = (dict["path"] as? String) ?? ""

        win.title = name.isEmpty
            ? (AppLocale.isZh ? "Markdown 编辑器" : "Markdown Editor")
            : name
        // 未保存时关闭按钮出现小圆点，是 macOS 的「有改动」原生信号
        win.isDocumentEdited = edited
        if path.isEmpty {
            win.representedURL = nil
        } else {
            win.representedURL = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        }
    }

    // MARK: - 打开

    private func openDocument() {
        guard let win = panel else { return }
        let openPanel = NSOpenPanel()
        openPanel.canChooseFiles = true
        openPanel.canChooseDirectories = false
        openPanel.allowsMultipleSelection = false
        openPanel.canCreateDirectories = false
        openPanel.allowsOtherFileTypes = true
        openPanel.prompt = AppLocale.isZh ? "打开" : "Open"
        openPanel.message = AppLocale.isZh
            ? "选择要编辑的 Markdown 文件"
            : "Choose a Markdown file to edit"

        var types: [UTType] = [.plainText]
        if let md = UTType(filenameExtension: "md") { types.insert(md, at: 0) }
        if let markdown = UTType(filenameExtension: "markdown") { types.insert(markdown, at: 1) }
        openPanel.allowedContentTypes = types

        let handler: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self = self, response == .OK, let url = openPanel.url else { return }
            self.readFile(url)
        }

        if win.attachedSheet != nil {
            openPanel.begin(completionHandler: handler)
        } else {
            openPanel.beginSheetModal(for: win, completionHandler: handler)
        }
    }

    private func readFile(_ url: URL) {
        var encoding: String.Encoding = .utf8
        do {
            let text = try String(contentsOf: url, usedEncoding: &encoding)
            reply("__mdFileOpened", [
                "ok": true,
                "path": url.path,
                "name": url.lastPathComponent,
                "content": text,
            ])
        } catch {
            reply("__mdFileOpened", [
                "ok": false,
                "path": url.path,
                "name": url.lastPathComponent,
                "error": error.localizedDescription,
            ])
        }
    }

    // MARK: - 保存

    private func writeDocument(path: String?, content: String) {
        let cleaned = (path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else {
            writeDocumentAs(content: content, suggestedName: nil)
            return
        }
        let url = URL(fileURLWithPath: (cleaned as NSString).expandingTildeInPath)
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
            reply("__mdFileSaved", [
                "ok": true,
                "path": url.path,
                "name": url.lastPathComponent,
            ])
        } catch {
            reply("__mdFileSaved", ["ok": false, "error": error.localizedDescription])
        }
    }

    private func writeDocumentAs(content: String, suggestedName: String?) {
        guard let win = panel else { return }
        let savePanel = NSSavePanel()
        savePanel.canCreateDirectories = true
        savePanel.prompt = AppLocale.isZh ? "保存" : "Save"
        savePanel.message = AppLocale.isZh
            ? "保存为 Markdown 文件"
            : "Save as a Markdown file"
        if let md = UTType(filenameExtension: "md") {
            savePanel.allowedContentTypes = [md]
        }
        let suggested = (suggestedName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        savePanel.nameFieldStringValue = suggested.isEmpty
            ? (AppLocale.isZh ? "未命名.md" : "Untitled.md")
            : suggested

        if let current = panel?.representedURL {
            savePanel.directoryURL = current.deletingLastPathComponent()
        }

        let handler: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self = self else { return }
            guard response == .OK, let url = savePanel.url else {
                // 用户取消：必须回一个结果，否则页面会一直等「保存完成」而关不掉窗口
                self.reply("__mdFileSaved", ["ok": false, "cancelled": true])
                return
            }
            do {
                try content.write(to: url, atomically: true, encoding: .utf8)
                self.reply("__mdFileSaved", [
                    "ok": true,
                    "path": url.path,
                    "name": url.lastPathComponent,
                ])
            } catch {
                self.reply("__mdFileSaved", ["ok": false, "error": error.localizedDescription])
            }
        }

        if win.attachedSheet != nil {
            savePanel.begin(completionHandler: handler)
        } else {
            savePanel.beginSheetModal(for: win, completionHandler: handler)
        }
    }

    /// 「打开另一份文件」前如果当前有未保存内容，先问一句（缓存里的内容一换就找不回来了）
    private func confirmDiscard() {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = AppLocale.isZh ? "放弃未保存的更改？" : "Discard unsaved changes?"
        alert.informativeText = AppLocale.isZh
            ? "当前内容还没有保存到文件，继续操作会丢失这些更改。"
            : "The current content has not been saved to a file. Continuing will lose those changes."
        alert.addButton(withTitle: AppLocale.isZh ? "取消" : "Cancel")
        alert.addButton(withTitle: AppLocale.isZh ? "放弃更改" : "Discard")
        let response = alert.runModal()
        reply("__mdDiscardDecision", ["ok": response == .alertSecondButtonReturn])
    }

    // MARK: - 关窗

    /// 未保存时的关窗流程：保存（页面落盘成功后再通知这里关）/ 不保存 / 取消
    private var awaitingSaveBeforeClose = false

    private func performCloseConfirmed() {
        awaitingSaveBeforeClose = false
        guard let p = panel else { return }
        p.isDocumentEdited = false
        p.orderOut(nil)
    }

    /// App 退出前的守卫：仍有未保存内容就让用户确认一次，返回 true 表示可以继续退出
    func confirmQuitWithUnsavedChanges() -> Bool {
        guard let p = panel, p.isVisible, p.isDocumentEdited else { return true }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = AppLocale.isZh ? "有未保存的更改" : "Unsaved changes"
        alert.informativeText = AppLocale.isZh
            ? "Markdown 编辑器里的内容还没有保存到文件，退出后这些更改会丢失。"
            : "The Markdown editor has content that has not been saved to a file. Quitting will lose those changes."
        alert.addButton(withTitle: AppLocale.isZh ? "取消" : "Cancel")
        alert.addButton(withTitle: AppLocale.isZh ? "放弃并退出" : "Discard and Quit")
        return alert.runModal() == .alertSecondButtonReturn
    }

    func windowWillStartLiveResize(_ notification: Notification) {
        resizeChrome?.windowWillStartLiveResize()
    }

    func windowDidResize(_ notification: Notification) {
        resizeChrome?.windowDidResize()
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        resizeChrome?.windowDidEndLiveResize()
    }

    /// 绿色交通灯：走与双击一致的动画缩放（返回 false 阻止系统 performZoom）
    func windowShouldZoom(_ window: NSWindow, toFrame newFrame: NSRect) -> Bool {
        resizeChrome?.handleWindowShouldZoom() ?? false
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // 全屏下直接收窗会留下整面黑屏：先退全屏，收完再重新走一遍关窗流程
        if fullscreenCloser?.handleCloseRequest() == true { return false }
        // 保存流程进行中：忽略重复关闭（落盘成功后页面会回传 closeNow）
        if awaitingSaveBeforeClose { return false }

        if !sender.isDocumentEdited {
            sender.orderOut(nil)
            return false
        }

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = AppLocale.isZh ? "要保存更改吗？" : "Save changes?"
        alert.informativeText = AppLocale.isZh
            ? "关闭窗口前，是否将当前内容保存到文件？"
            : "Do you want to save the current content before closing?"
        alert.addButton(withTitle: AppLocale.isZh ? "保存" : "Save")
        alert.addButton(withTitle: AppLocale.isZh ? "不保存" : "Don't Save")
        alert.addButton(withTitle: AppLocale.isZh ? "取消" : "Cancel")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            // 「保存」可能是弹出另存为面板，落盘完成后由页面回传 closeNow
            awaitingSaveBeforeClose = true
            webView?.evaluateJavaScript(
                "window.__mdRequestSaveClose && window.__mdRequestSaveClose();"
            ) { _, _ in }
            return false
        case .alertSecondButtonReturn:
            sender.isDocumentEdited = false
            sender.orderOut(nil)
            return false
        default:
            return false
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webReady = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.loadContent()
        }
    }

    // MARK: - WKUIDelegate

    /// 网页 <input type="file">（浏览器无桥回退路径）弹出系统文件选择面板。
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let openPanel = NSOpenPanel()
        openPanel.canChooseFiles = true
        openPanel.canChooseDirectories = false
        openPanel.allowsMultipleSelection = parameters.allowsMultipleSelection
        openPanel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText, .plainText]
        openPanel.beginSheetModal(for: webView.window!) { response in
            completionHandler(response == .OK ? openPanel.urls : nil)
        }
    }

    /// 预览里的外链是 `target="_blank"`。WKWebView 不实现这个 delegate 时会**静默忽略**点击，
    /// 表现为「链接点了没反应」——与主窗口同一套处理：交给系统浏览器打开。
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}
