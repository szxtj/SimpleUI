import Cocoa
import WebKit

/// 文件夹快速检索独立窗口：承载 `http://127.0.0.1:31235/#/folder_search`。
///
/// 生命周期契约（与 3D / Markdown 窗口同一套）：
///   - 打开窗口 → `POST /api/folder_index/open`（按需续建索引，已暂停的不动）
///   - 关闭窗口 → `POST /api/folder_index/close`（当前批落盘后停索引，卸载模型）
///
/// 窗口本身常驻（orderOut 隐藏），页面只加载一次；索引的启停完全由
/// open / close 两个请求驱动，与页面是否重载无关。
final class FolderSearchWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// 开放式顶栏拖拽层：窗口内容伸到标题栏下方，顶部 52pt 由本视图接管。
/// 左侧 78pt 让给红绿灯按钮（否则点不到）。
final class FolderSearchTitleBarDragView: NSView {
    private static let trafficLightZone: CGFloat = 78.0
    /// 右上方是「列表 / 网格 / 暂停」三个按钮（见 FolderSearchWindow.tsx 的顶栏），
    /// 这段宽度必须整体穿透，否则原生拖拽层会把点击吃掉 —— 表现就是「按钮点了没反应」。
    private static let toolbarZone: CGFloat = 300.0
    weak var resizeChrome: WindowResizeChrome?
    private var dragging = false
    private var pendingUnzoom = false
    private var initialMouseLocation = NSPoint.zero
    private var initialWindowOrigin = NSPoint.zero

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard frame.contains(point) else { return nil }
        let localPoint = convert(point, from: superview)
        if localPoint.x < Self.trafficLightZone { return nil }
        if localPoint.x >= bounds.width - Self.toolbarZone { return nil }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        guard let win = window else { return }
        if event.clickCount >= 2 {
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
        if pendingUnzoom {
            guard let restore = resizeChrome?.unzoomForTitleBarDrag(at: mouse, start: initialMouseLocation) else { return }
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
}

final class FolderSearchPanelController: NSObject, NSWindowDelegate, WKScriptMessageHandler {
    private var panel: FolderSearchWindow?
    private var webView: WKWebView?
    private var dragView: FolderSearchTitleBarDragView?
    private var resizeChrome: WindowResizeChrome?
    /// 全屏下关窗先退全屏（与主窗口同一套处理，见 FullscreenAwareCloser）
    private var fullscreenCloser: FullscreenAwareCloser?
    private var loaded = false

    private static let defaultSize = NSSize(width: 960, height: 660)
    private static let minWidth: CGFloat = 760
    private static let minHeight: CGFloat = 480

    private static func windowBackgroundColor() -> NSColor {
        let isDark: Bool = {
            if let stored = UserDefaults.standard.object(forKey: "simpleui_is_dark") as? Bool { return stored }
            if let match = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) {
                return match == .darkAqua
            }
            return false
        }()
        return isDark
            ? NSColor(red: 24/255.0, green: 25/255.0, blue: 28/255.0, alpha: 1.0)
            : NSColor(red: 248/255.0, green: 249/255.0, blue: 251/255.0, alpha: 1.0)
    }

    private func makePanel() -> FolderSearchWindow {
        let p = FolderSearchWindow(
            contentRect: NSRect(origin: .zero, size: Self.defaultSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        p.title = "文件夹检索"
        p.titleVisibility = .hidden
        p.titlebarAppearsTransparent = true
        p.isMovableByWindowBackground = true
        p.backgroundColor = Self.windowBackgroundColor()
        p.minSize = NSSize(width: Self.minWidth, height: Self.minHeight)
        p.isReleasedWhenClosed = false
        fullscreenCloser = FullscreenAwareCloser(window: p)
        // 延迟关窗收尾：停索引 + 卸载模型（与 windowWillClose 同一套动作）
        fullscreenCloser?.onClosed = { [weak self] in self?.notifyClose() }
        p.isRestorable = false
        p.hidesOnDeactivate = false
        p.animationBehavior = .utilityWindow
        p.delegate = self
        if !p.setFrameUsingName("SimpleUIFolderSearchWindow") {
            center(p)
        }
        p.setFrameAutosaveName("SimpleUIFolderSearchWindow")

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "folderSearch")
        let wv = WKWebView(frame: p.contentView?.bounds ?? .zero, configuration: config)
        wv.autoresizingMask = [.width, .height]
        wv.uiDelegate = self
        p.contentView?.addSubview(wv)
        webView = wv

        let drag = FolderSearchTitleBarDragView()
        drag.translatesAutoresizingMaskIntoConstraints = false
        p.contentView?.addSubview(drag, positioned: .above, relativeTo: wv)
        if let cv = p.contentView {
            NSLayoutConstraint.activate([
                drag.leadingAnchor.constraint(equalTo: cv.leadingAnchor),
                drag.trailingAnchor.constraint(equalTo: cv.trailingAnchor),
                drag.topAnchor.constraint(equalTo: cv.topAnchor),
                drag.heightAnchor.constraint(equalToConstant: 52.0),
            ])
        }
        dragView = drag
        resizeChrome = WindowResizeChrome(window: p, webView: wv, above: drag)
        drag.resizeChrome = resizeChrome
        return p
    }

    private func center(_ p: NSWindow) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSPointInRect(mouse, $0.frame) })
            ?? NSScreen.main ?? NSScreen.screens[0]
        let visible = screen.visibleFrame
        p.setFrameOrigin(NSPoint(x: visible.midX - p.frame.width / 2, y: visible.midY - p.frame.height / 2))
    }

    func show() {
        if Thread.isMainThread { performShow() } else { DispatchQueue.main.async { [weak self] in self?.performShow() } }
    }

    /// Finder 右键带过来的文件夹：开窗并让它成为当前索引
    func show(withPath path: String) {
        let work = { [weak self] in
            guard let self = self else { return }
            self.performShow()
            NSLog("[FolderSearch] 带路径打开: \(path) ready=\(self.webViewReady)")
            guard !path.isEmpty else { return }
            if self.webViewReady {
                self.pushPathToPage(path)
            } else {
                // 页面还没加载完：把参数挂到 URL 上，由页面自己解析
                self.loaded = true
                if let encoded = path.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
                   let url = URL(string: "\(ProcessManager.baseURLString)/#/folder_search?add=\(encoded)") {
                    self.webView?.load(URLRequest(url: url))
                }
            }
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }

    /// 页面已就绪：直接调它暴露的钩子，避免重新加载页面
    private func pushPathToPage(_ path: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [path], options: []),
              let json = String(data: data, encoding: .utf8) else { return }
        // json 形如 ["/path"]，取第一个元素
        let arg = String(json.dropFirst().dropLast())
        webView?.evaluateJavaScript("window.__folderSearchAddPath && window.__folderSearchAddPath(\(arg))", completionHandler: nil)
    }

    private var webViewReady: Bool {
        guard let wv = webView else { return false }
        return loaded && !wv.isLoading
    }

    private func performShow() {
        if panel == nil { panel = makePanel() }
        guard let p = panel else { return }
        if !loaded {
            loaded = true
            if let url = URL(string: "\(ProcessManager.baseURLString)/#/folder_search") {
                webView?.load(URLRequest(url: url))
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
        notifyOpen()
    }

    /// 开窗打点：让后端按需续建（暂停态不动）
    private func notifyOpen() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/folder_index/open") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        req.timeoutInterval = 10
        URLSession.shared.dataTask(with: req).resume()
    }

    /// 关窗打点：当前批落盘后停索引并卸载模型（失败也不阻塞关窗）
    private func notifyClose() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/folder_index/close") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        req.timeoutInterval = 15
        URLSession.shared.dataTask(with: req).resume()
    }

    // 全屏下直接收窗会留下整面黑屏：先退全屏，收完再走 onClosed（notifyClose）收尾
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if fullscreenCloser?.handleCloseRequest() == true { return false }
        notifyClose()
        sender.orderOut(nil)
        return false
    }

    func windowWillClose(_ notification: Notification) {
        notifyClose()
    }

    // MARK: - 缩放遮罩（与主窗口 / 3D / Markdown 同一套 WindowResizeChrome）

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

    // MARK: - 页面桥

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        switch action {
        case "pick":
            pickFolder()
        case "open":
            if let p = body["path"] as? String {
                NSWorkspace.shared.open(URL(fileURLWithPath: p))
            }
        case "reveal":
            if let p = body["path"] as? String {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
            }
        default:
            break
        }
    }

    /// 选文件夹（NSOpenPanel 的委托式授权同时把 TCC 权限一并拿到）
    private func pickFolder() {
        guard let p = panel else { return }
        let op = NSOpenPanel()
        op.canChooseFiles = false
        op.canChooseDirectories = true
        op.allowsMultipleSelection = false
        op.canCreateDirectories = false
        op.prompt = AppLocale.isZh ? "建立索引" : "Index"
        op.message = AppLocale.isZh ? "选择一个文件夹，SimpleUI 会在本地为它建立检索索引" : "Choose a folder to index locally"
        op.beginSheetModal(for: p) { [weak self] response in
            guard response == .OK, let url = op.url else { return }
            DispatchQueue.main.async {
                self?.addFolder(url.path)
            }
        }
    }

    private func addFolder(_ path: String) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/folder_index/add") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["path": path], options: [])
        req.timeoutInterval = 20
        URLSession.shared.dataTask(with: req) { data, _, _ in
            DispatchQueue.main.async { [weak self] in
                guard let self = self, let wv = self.webView else { return }
                if let data = data, let json = String(data: data, encoding: .utf8) {
                    let js = "window.__folderSearchAdded && window.__folderSearchAdded(\(json))"
                    wv.evaluateJavaScript(js, completionHandler: nil)
                }
            }
        }.resume()
    }
}

extension FolderSearchPanelController: WKUIDelegate {}
