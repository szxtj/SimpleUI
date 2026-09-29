import Cocoa
import WebKit
import UniformTypeIdentifiers

class TitleBarDragView: NSView {
    var isSidebarOpen: Bool = true
    var isWikiPanelOpen: Bool = false

    // —— 手动拖拽状态（不用 performDrag，是为了在最大尺寸下拖动时能先还原原尺寸再继续拖）——
    private var dragging = false
    private var initialMouseLocation = NSPoint.zero
    private var initialWindowOrigin = NSPoint.zero
    /** 本次按下时处于自定义缩放态；实际位移超过阈值时先还原原尺寸、再无缝继续拖 */
    private var pendingUnzoom = false
    private static let unzoomDragThreshold: CGFloat = 4.0

    override func hitTest(_ point: NSPoint) -> NSView? {
        // point passed to hitTest is in superview's coordinate system!
        guard frame.contains(point) else { return nil }

        let localPoint = convert(point, from: superview)
        let x = localPoint.x
        let totalWidth = bounds.width

        // Mirror the web layout constants (App.tsx / WikiSidebar.tsx / Sidebar.tsx)
        let sidebarWidth: CGFloat = 260.0
        let wikiPanelWidth: CGFloat = 440.0

        let panelWidth: CGFloat = isWikiPanelOpen ? wikiPanelWidth : 0.0
        let chatRight: CGFloat = totalWidth - panelWidth

        // 1. Native macOS Traffic Lights (x: 0 ... 78):
        // Always pass through so close/minimize/zoom buttons work!
        if x < 78.0 {
            return nil
        }

        // 2. Wiki Knowledge Panel header (x: chatRight ... totalWidth):
        // Only the header's own action buttons (collapse / open external) are
        // interactive — they occupy the panel's right-most ~80px. Everywhere else
        // on the panel header drags the window, just like the other two top bars.
        if isWikiPanelOpen && x >= chatRight {
            return x >= (totalWidth - 80.0) ? nil : self
        }

        // 3. Sessions Sidebar header (x: 0 ... sidebarWidth)
        if isSidebarOpen {
            // Collapse button on the far-right of the sidebar: x: (260 - 45) ... 260
            if x >= (sidebarWidth - 45.0) && x <= sidebarWidth {
                return nil // Click Collapse Sidebar button!
            }
            // Between 78 and (sidebarWidth - 45): EMPTY TOP OF SIDEBAR!
            if x < sidebarWidth {
                return self // Drag window!
            }
        } else {
            // Sidebar is COLLAPSED (width = 0):
            // Open Sidebar button: x: 78 ... 122
            if x >= 78.0 && x <= 122.0 {
                return nil // Click Open Sidebar!
            }
        }

        // 4. Chat View header (x: sidebarWidth/122 ... chatRight)
        // 4a. Right tools (Shrink-to-Spotlight always rendered, Knowledge Panel
        //     toggle while the panel is closed) sit in the column's right ~100px.
        //     NOTE: these are positioned relative to the *chat column*, which ends
        //     at chatRight — using totalWidth here made the Shrink button
        //     unclickable whenever the knowledge panel was open.
        if x >= (chatRight - 100.0) {
            return nil
        }

        // 4b. Model Selector button: starts at the column's left edge (or right
        //     after the Open-Sidebar button when the sidebar is collapsed).
        let modelLeft: CGFloat = isSidebarOpen ? sidebarWidth : 122.0
        let modelRight = min(modelLeft + 210.0, chatRight - 100.0)
        if x >= modelLeft && x <= modelRight {
            return nil // Click Model Selector!
        }

        // 4c. Empty title bar in the Chat View: drag window!
        return self
    }

    override func mouseDown(with event: NSEvent) {
        // 双击顶部栏 → 在「非全屏的最大尺寸」与原尺寸之间切换（macOS 应用常见行为）。
        // 两个方向**都由双击触发**；单击/拖动不再触发还原（2026-09-28 用户要求统一）。
        if event.clickCount >= 2 {
            (window?.windowController as? MainWindowController)?.toggleZoomAnimated()
            return
        }
        let controller = window?.windowController as? MainWindowController
        // 动画进行中用户按下鼠标：停掉动画，把窗口交给拖拽，避免两套帧互相打架
        controller?.cancelZoomAnimation()
        guard let win = window else { return }
        dragging = true
        initialMouseLocation = NSEvent.mouseLocation
        initialWindowOrigin = win.frame.origin
        pendingUnzoom = controller?.isZoomed ?? false
    }

    override func mouseDragged(with event: NSEvent) {
        guard dragging, let win = window else { return }
        let mouse = NSEvent.mouseLocation

        // 最大尺寸下首次实际拖动：先还原原尺寸（光标保持在标题栏上
        // 相同的相对水平位置、相同的"距顶边"高度，与原生 macOS 一致），随后无缝续拖
        if pendingUnzoom {
            let dx = mouse.x - initialMouseLocation.x
            let dy = mouse.y - initialMouseLocation.y
            guard sqrt(dx * dx + dy * dy) >= TitleBarDragView.unzoomDragThreshold else { return }
            guard let controller = window?.windowController as? MainWindowController,
                  var restore = controller.consumePreZoomFrame() else {
                pendingUnzoom = false
                return
            }
            restore.size.width = max(restore.width, win.minSize.width)
            restore.size.height = max(restore.height, win.minSize.height)
            let relativeX = (mouse.x - win.frame.minX) / win.frame.width
            let topOffset = win.frame.maxY - mouse.y
            restore.origin.x = mouse.x - restore.width * relativeX
            restore.origin.y = mouse.y - restore.height + topOffset
            win.setFrame(restore, display: true)
            // 以还原瞬间为新的拖拽基准，后续位移无缝衔接
            initialMouseLocation = mouse
            initialWindowOrigin = restore.origin
            pendingUnzoom = false
            return
        }

        let deltaX = mouse.x - initialMouseLocation.x
        let deltaY = mouse.y - initialMouseLocation.y
        win.setFrameOrigin(NSPoint(x: initialWindowOrigin.x + deltaX, y: initialWindowOrigin.y + deltaY))
    }

    override func mouseUp(with event: NSEvent) {
        dragging = false
        pendingUnzoom = false
    }

    override var mouseDownCanMoveWindow: Bool {
        return true
    }
}

class MainWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var dragView: TitleBarDragView!
    var onShrinkToSpotlight: ((String?) -> Void)?
    /** 双击缩放前的原帧（自定义 zoom 态，替代 performZoom，见 toggleZoomAnimated 注释） */
    private var preZoomFrame: NSRect?
    /** 双击缩放的步进动画定时器 */
    private var zoomAnimationTimer: Timer?
    /** 用户在全屏下点了关闭：先退全屏，退完再隐藏窗口（避免全屏 Space 残留黑屏） */
    private var pendingCloseAfterFullscreenExit = false

    init() {
        let width: CGFloat = 1180
        let height: CGFloat = 760

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.minSize = NSSize(width: 700, height: 400)
        window.title = "SimpleUI"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor.windowBackgroundColor
        window.center()

        super.init(window: window)
        window.delegate = self

        setupWebView()
        setupDragArea()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setupWebView() {
        guard let win = window else { return }

        let config = WKWebViewConfiguration()
        let userContent = WKUserContentController()
        userContent.add(self, name: "setModalOpen")
        userContent.add(self, name: "setSidebarOpen")
        userContent.add(self, name: "setWikiPanelOpen")
        userContent.add(self, name: "shrinkToSpotlight")
        // 语音输入权限桥（设置页「语音识别服务」卡片据此展示/申请三件套权限）
        userContent.add(self, name: "voiceInput")
        userContent.add(self, name: "openExternal")
        config.userContentController = userContent

        // 权限状态在系统设置里被改动后，主动回推给页面刷新
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onVoicePermissionsChanged),
            name: .simpleUIVoicePermissionsChanged,
            object: nil
        )

        // 语音转写结果要插入本 App 自身的输入框（WKWebView 内 AX 判定不到），经前端桥写入光标处
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onVoiceInsertText(_:)),
            name: VoiceInputManager.insertTextNotification,
            object: nil
        )

        webView = WKWebView(frame: win.contentView?.bounds ?? .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(true, forKey: "drawsBackground") // Main window uses solid background to avoid GPU compositor blur bugs

        win.contentView?.addSubview(webView)
    }

    private func setupDragArea() {
        guard let win = window, let contentView = win.contentView else { return }

        dragView = TitleBarDragView()
        dragView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(dragView, positioned: .above, relativeTo: webView)

        NSLayoutConstraint.activate([
            dragView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            dragView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            dragView.topAnchor.constraint(equalTo: contentView.topAnchor),
            dragView.heightAnchor.constraint(equalToConstant: 52.0)
        ])
    }

    func updateWindowMinSize(isSidebarOpen: Bool) {
        guard let win = window else { return }
        // When sidebar is closed, user can shrink the window down to chat-only width (~450px)
        // Wiki panel (440px) adds to the minimum so sidebars keep constant width
        let wikiWidth: CGFloat = (dragView?.isWikiPanelOpen == true) ? 440.0 : 0.0
        let minWidth: CGFloat = (isSidebarOpen ? 700.0 : 450.0) + wikiWidth
        let minHeight: CGFloat = 400.0
        win.minSize = NSSize(width: minWidth, height: minHeight)

        if win.frame.width < minWidth {
            var newFrame = win.frame
            newFrame.size.width = minWidth
            win.setFrame(newFrame, display: true, animate: true)
        }
    }

    func loadContent() {
        if let url = URL(string: ProcessManager.baseURLString) {
            webView.load(URLRequest(url: url))
        }
    }

    func reload() {
        if webView.url == nil {
            loadContent()
        } else {
            webView.reload()
        }
    }

    // MARK: - WKNavigationDelegate
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("MainWindow provisional navigation failed: \(error.localizedDescription). Retrying in 0.5s...")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.loadContent()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("MainWindow navigation failed: \(error.localizedDescription). Retrying in 0.5s...")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.loadContent()
        }
    }

    func showAndFocus() {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        // Instantly sync latest sessions from storage
        webView.evaluateJavaScript("window.reloadSessionsFromStorage && window.reloadSessionsFromStorage()") { _, _ in }
    }

    // MARK: - WKScriptMessageHandler
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "setModalOpen", let isOpen = message.body as? Bool {
            // When any modal (like Settings) is open, hide dragView so all clicks pass straight to webView
            dragView?.isHidden = isOpen
        } else if message.name == "setSidebarOpen", let isOpen = message.body as? Bool {
            dragView?.isSidebarOpen = isOpen
            updateWindowMinSize(isSidebarOpen: isOpen)
        } else if message.name == "setWikiPanelOpen", let isOpen = message.body as? Bool {
            dragView?.isWikiPanelOpen = isOpen
            updateWindowMinSize(isSidebarOpen: dragView?.isSidebarOpen ?? true)
        } else if message.name == "shrinkToSpotlight" {
            let dict = message.body as? [String: Any]
            let sessionId = dict?["sessionId"] as? String
            window?.orderOut(nil)
            onShrinkToSpotlight?(sessionId)
        } else if message.name == "voiceInput", let dict = message.body as? [String: Any] {
            handleVoiceInputMessage(dict)
        } else if message.name == "openExternal", let urlString = message.body as? String {
            openExternal(urlString)
        }
    }

    /// 用系统默认浏览器打开外部链接（网页里的 <a target="_blank"> 在 WKWebView 里不会自己跳转）。
    /// 只放行 http/https —— 防止网页侧意外触发 file: / 自定义 scheme 打开本地内容。
    private func openExternal(_ urlString: String) {
        guard let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    // MARK: - 语音输入权限桥

    private func handleVoiceInputMessage(_ dict: [String: Any]) {
        guard let action = dict["action"] as? String else { return }
        switch action {
        case "getPermissions":
            pushVoicePermissions()
        case "requestMicrophone":
            VoiceInputManager.shared.requestMicrophone()
        case "requestAccessibility":
            VoiceInputManager.shared.requestAccessibility()
        case "requestInputMonitoring":
            VoiceInputManager.shared.requestInputMonitoring()
        case "openPrivacyPane":
            if let pane = dict["pane"] as? String {
                VoiceInputManager.shared.openPrivacyPane(pane)
            }
        default:
            break
        }
    }

    @objc private func onVoiceInsertText(_ note: Notification) {
        guard let text = note.object as? String, !text.isEmpty else { return }
        // 该通知是从 URLSession 回调线程（com.apple.NSURLSession-delegate）发出的，
        // 而 WKWebView.evaluateJavaScript 必须在主线程调用 —— 先切回主线程再操作。
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // 只有本窗口是当前 key 窗口时才插入，避免把文字塞进非前台窗口
            // （例如 Spotlight 浮窗在前台时，语音结果不该落到主窗口输入框）。
            guard self.window?.isKeyWindow == true else { return }
            // 顶层必须是 Array / Dictionary：JSONSerialization 传裸 String 会抛
            // ObjC 异常（NSInvalidArgumentException），而 try? 接不住 ObjC 异常 → 直接 abort。
            // 因此包进字典再取 .t；引号/换行/反斜杠等转义交给序列化器，避免拼出坏 JS。
            guard let data = try? JSONSerialization.data(withJSONObject: ["t": text]),
                  let json = String(data: data, encoding: .utf8) else { return }
            // json 形如 {"t":"…"}，本身是合法 JS 对象字面量
            self.webView.evaluateJavaScript("window.__insertVoiceText && window.__insertVoiceText((\(json)).t)") { _, _ in }
        }
    }

    private func pushVoicePermissions() {
        let snap = VoiceInputManager.shared.permissionSnapshot()
        guard let data = try? JSONSerialization.data(withJSONObject: snap),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__onVoicePermissions && window.__onVoicePermissions(\(json))") { _, _ in }
    }

    @objc private func onVoicePermissionsChanged() {
        pushVoicePermissions()
    }

    // MARK: - NSWindowDelegate
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // 全屏下直接 orderOut 会把全屏 Space 留在屏幕上（表现为全屏黑屏，App 还活着）。
        // macOS 惯例是先退全屏、动画收完再隐藏窗口 —— 用 windowDidExitFullScreen 收尾。
        if sender.styleMask.contains(.fullScreen) {
            pendingCloseAfterFullscreenExit = true
            sender.toggleFullScreen(nil)
            return false
        }
        sender.orderOut(nil)
        return false
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        guard pendingCloseAfterFullscreenExit,
              let win = notification.object as? NSWindow, win === window else { return }
        pendingCloseAfterFullscreenExit = false
        // 再让系统跑完 Space 收起的收尾帧，然后隐藏窗口
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.window?.orderOut(nil)
        }
    }

    // MARK: - 双击缩放（自定义动画）
    /**
     * 双击顶部栏在「非全屏的最大尺寸」与原尺寸之间切换。
     *
     * 为什么不用 performZoom：它的帧动画期间 WKWebView 的远程图层不会逐帧重排，
     * 内容被整体拉伸、边缘露底，整个界面观感异常；而用户自由拖拽边框是逐帧真实布局，
     * 从来不糊。因此这里把帧变化拆成 ~60fps 的小步 `setFrame(display: true)`——
     * 每一步都触发一次真实布局，观感与自由拉伸一致。
     */
    /// 中断进行中的缩放动画（拖拽/新一轮缩放开始前调用）
    func cancelZoomAnimation() {
        zoomAnimationTimer?.invalidate()
        zoomAnimationTimer = nil
    }

    /// 是否处于自定义缩放态（双击放大后、尚未还原）
    var isZoomed: Bool { preZoomFrame != nil }

    /// 取走记忆的原尺寸（拖动还原用）；取走即清空，避免重复还原到过期帧
    func consumePreZoomFrame() -> NSRect? {
        defer { preZoomFrame = nil }
        return preZoomFrame
    }

    func toggleZoomAnimated() {
        guard let win = window, let screen = win.screen ?? NSScreen.main else { return }
        // 原生全屏态下不做自定义缩放（全屏有自己的进出场动画）
        guard !win.styleMask.contains(.fullScreen) else { return }

        zoomAnimationTimer?.invalidate()
        zoomAnimationTimer = nil

        let startFrame = win.frame
        let targetFrame: NSRect
        if let restore = preZoomFrame {
            // 已是缩放态 → 回到双击前的原尺寸
            targetFrame = restore
            preZoomFrame = nil
        } else {
            preZoomFrame = startFrame
            targetFrame = screen.visibleFrame
        }
        guard startFrame != targetFrame else { return }

        let steps = 16
        var step = 0
        let timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] timer in
            guard let self = self, let win = self.window else {
                timer.invalidate()
                return
            }
            step += 1
            let t = min(1.0, Double(step) / Double(steps))
            // ease-in-out：节奏接近系统缩放动画
            let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
            var frame = NSRect.zero
            frame.origin.x = startFrame.origin.x + (targetFrame.origin.x - startFrame.origin.x) * eased
            frame.origin.y = startFrame.origin.y + (targetFrame.origin.y - startFrame.origin.y) * eased
            frame.size.width = startFrame.width + (targetFrame.width - startFrame.width) * eased
            frame.size.height = startFrame.height + (targetFrame.height - startFrame.height) * eased
            // 夹到最小尺寸，避免把窗口缩穿
            frame.size.width = max(frame.size.width, win.minSize.width)
            frame.size.height = max(frame.size.height, win.minSize.height)
            win.setFrame(frame, display: true)
            if step >= steps {
                timer.invalidate()
                self.zoomAnimationTimer = nil
                win.setFrame(targetFrame, display: true)
            }
        }
        zoomAnimationTimer = timer
    }


    // MARK: - WKUIDelegate (External Links)
    // WKWebView silently ignores `target="_blank"` navigations unless this delegate
    // method is implemented — that is why the wiki panel's "open original article"
    // button did nothing. Route such links to the macOS default browser.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // MARK: - WKUIDelegate (File Upload Panel)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let openPanel = NSOpenPanel()
        openPanel.canChooseFiles = true
        openPanel.canChooseDirectories = false
        openPanel.allowsMultipleSelection = parameters.allowsMultipleSelection
        openPanel.allowedContentTypes = [.image]
        openPanel.beginSheetModal(for: webView.window!) { response in
            completionHandler(response == .OK ? openPanel.urls : nil)
        }
    }
}
