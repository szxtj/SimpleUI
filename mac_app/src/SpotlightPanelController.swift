import Cocoa
import WebKit
import UniformTypeIdentifiers

class SpotlightPanel: NSPanel {
    override var canBecomeKey: Bool {
        return true
    }
    override var canBecomeMain: Bool {
        return true
    }
}

/// A dedicated native overlay view across the top 46px header bar of the expanded Spotlight panel.
/// Tracks mouse events directly to move the NSPanel smoothly, while transparently passing
/// clicks on the ✖ button (left) and action buttons (right) through to WKWebView.
class SpotlightDragView: NSView {
    var onDidDrag: ((NSPoint) -> Void)?
    private(set) var isDragging: Bool = false

    override var mouseDownCanMoveWindow: Bool {
        return true
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, frame.contains(point) else { return nil }

        let localPoint = convert(point, from: superview)
        let x = localPoint.x
        let totalWidth = bounds.width

        // 1. Left button area (✖ close button at x: 0 ... 44):
        // Return nil so clicks hit the web button directly
        if x < 44.0 {
            return nil
        }

        // 2. Right action buttons (New Chat & Expand buttons at x: totalWidth - 85 ... totalWidth):
        // Return nil so clicks hit the web action buttons directly
        if x > (totalWidth - 85.0) {
            return nil
        }

        // 3. Middle header area (x: 44.0 ... totalWidth - 85.0):
        // Intercept mouse to drag window smoothly
        return self
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        return true
    }

    override func mouseDown(with event: NSEvent) {
        guard let window = self.window else { return }
        isDragging = true
        window.performDrag(with: event)
        isDragging = false
        onDidDrag?(window.frame.origin)
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        let draggableWidth = max(0, bounds.width - 129.0)
        if draggableWidth > 0 {
            let draggableRect = NSRect(x: 44.0, y: 0, width: draggableWidth, height: bounds.height)
            addCursorRect(draggableRect, cursor: isDragging ? .closedHand : .openHand)
        }
    }
}

class SpotlightPanelController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private var dragView: SpotlightDragView!
    var onOpenMainWindow: (() -> Void)?

    // State tracking for window position preservation and reset
    private var isExpanded: Bool = false
    private var hasUserCustomPosition: Bool = false
    private var customExpandedOrigin: NSPoint? = nil
    private var isProgrammaticAnimating: Bool = false

    init() {
        // Initial compact input capsule size: 540 x 88
        let width: CGFloat = 540
        let height: CGFloat = 88

        let panel = SpotlightPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.titled, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = false // Window dragging is handled by SpotlightDragView
        panel.backgroundColor = .clear
        panel.hasShadow = false // Clean flat presentation without outer halos
        panel.isOpaque = false

        super.init(window: panel)

        setupWebView()
        setupDragView()
        setupNotificationObservers()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setupWebView() {
        guard let panel = window else { return }

        let config = WKWebViewConfiguration()
        let userContent = WKUserContentController()
        userContent.add(self, name: "openMainWindow")
        userContent.add(self, name: "openMainFromSpotlight")
        userContent.add(self, name: "closeSpotlight")
        userContent.add(self, name: "resizePanel")
        userContent.add(self, name: "chooseDirectory")
        config.userContentController = userContent

        webView = WKWebView(frame: panel.contentView?.bounds ?? .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground") // Fully transparent background

        panel.contentView?.addSubview(webView)
    }

    private func setupDragView() {
        guard let panel = window, let contentView = panel.contentView else { return }
        dragView = SpotlightDragView()
        dragView.translatesAutoresizingMaskIntoConstraints = false
        dragView.isHidden = true // Initially hidden in compact capsule state
        dragView.onDidDrag = { [weak self] newOrigin in
            guard let self = self, self.isExpanded else { return }
            self.hasUserCustomPosition = true
            self.customExpandedOrigin = newOrigin
        }
        contentView.addSubview(dragView, positioned: .above, relativeTo: webView)

        NSLayoutConstraint.activate([
            dragView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            dragView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            dragView.topAnchor.constraint(equalTo: contentView.topAnchor),
            dragView.heightAnchor.constraint(equalToConstant: 46.0)
        ])
    }

    private func setupNotificationObservers() {
        guard let panel = window else { return }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleWindowDidMove(_:)),
            name: NSWindow.didMoveNotification,
            object: panel
        )
        // 语音转写结果要插入本 App 自身的输入框（WKWebView 内 AX 判定不到），经前端桥写入光标处
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onVoiceInsertText(_:)),
            name: VoiceInputManager.insertTextNotification,
            object: nil
        )
    }

    @objc private func onVoiceInsertText(_ note: Notification) {
        guard let text = note.object as? String, !text.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let panel = self.window, panel.isVisible else { return }
            // 只有当主窗口不是 key 窗口（即用户焦点在 Spotlight 浮窗）时，才插入到浮窗
            if NSApp.windows.contains(where: { !($0 is NSPanel) && $0.isVisible && $0.isKeyWindow }) {
                return
            }
            guard let data = try? JSONSerialization.data(withJSONObject: ["t": text]),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.webView.evaluateJavaScript("window.__insertVoiceText && window.__insertVoiceText((\(json)).t)") { _, _ in }
        }
    }

    @objc private func handleWindowDidMove(_ notification: Notification) {
        guard !isProgrammaticAnimating, isExpanded, let panel = window else { return }
        hasUserCustomPosition = true
        customExpandedOrigin = panel.frame.origin
    }

    func loadContent() {
        if let url = URL(string: ProcessManager.spotlightURLString) {
            webView.load(URLRequest(url: url))
        }
    }

    func toggle() {
        guard let panel = window else { return }
        if panel.isVisible && panel.isKeyWindow {
            hide()
        } else {
            show()
        }
    }

    private func currentScreen() -> NSScreen {
        let mouseLocation = NSEvent.mouseLocation
        let screens = NSScreen.screens
        return screens.first(where: { NSPointInRect(mouseLocation, $0.frame) }) ?? NSScreen.main ?? screens[0]
    }

    // Position directly above the Dock (screen.visibleFrame.origin.y + 16px)
    private func targetY(for height: CGFloat, on screen: NSScreen) -> CGFloat {
        let screenRect = screen.visibleFrame
        return screenRect.origin.y + 16
    }

    func show(isExpanded: Bool? = nil) {
        guard let panel = window else { return }
        if let exp = isExpanded {
            self.isExpanded = exp
        }
        let screen = currentScreen()
        let screenRect = screen.visibleFrame

        dragView?.isHidden = !self.isExpanded

        let targetWidth: CGFloat = self.isExpanded ? 500 : 540
        let targetHeight: CGFloat = self.isExpanded ? 640 : 88

        var targetFrame: NSRect
        if self.isExpanded && hasUserCustomPosition, let origin = customExpandedOrigin {
            // Restore to the exact user-dragged position, clamped safely within active screens
            let clampedX = min(screenRect.maxX - 100, max(screenRect.minX - targetWidth + 100, origin.x))
            let clampedY = min(screenRect.maxY - targetHeight, max(screenRect.minY, origin.y))
            targetFrame = NSRect(x: clampedX, y: clampedY, width: targetWidth, height: targetHeight)
        } else {
            // Default Dock-aligned bottom center
            let x = screenRect.origin.x + (screenRect.width - targetWidth) / 2
            let y = targetY(for: targetHeight, on: screen)
            targetFrame = NSRect(x: x, y: y, width: targetWidth, height: targetHeight)
        }

        isProgrammaticAnimating = true
        panel.setFrame(targetFrame, display: true)
        isProgrammaticAnimating = false

        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
        if let view = webView {
            panel.makeFirstResponder(view)
        }
        webView.evaluateJavaScript("window.onSpotlightShown && window.onSpotlightShown()") { _, _ in }
    }

    func showWithSession(sessionId: String?, isExpanded: Bool = true) {
        show(isExpanded: isExpanded)
        if let sid = sessionId {
            webView.evaluateJavaScript("window.loadSessionInSpotlight && window.loadSessionInSpotlight('\(sid)')") { _, _ in }
        }
    }

    func hide() {
        window?.orderOut(nil)
    }

    func handleResizePanel(width: CGFloat, height: CGFloat, isExpanding: Bool) {
        guard let panel = window else { return }

        // If the user is actively dragging the window with mouse, never interrupt or jitter!
        if dragView?.isDragging == true {
            return
        }

        self.isExpanded = isExpanding

        // If the panel is already at requested size and state, do NOT trigger redundant animations
        if abs(panel.frame.width - width) < 1.0 && abs(panel.frame.height - height) < 1.0 {
            dragView.isHidden = !isExpanding
            return
        }

        let screen = currentScreen()
        let screenRect = screen.visibleFrame

        var targetFrame: NSRect

        if isExpanding {
            // EXPANDED:
            dragView.isHidden = false
            panel.contentView?.layoutSubtreeIfNeeded()
            panel.invalidateCursorRects(for: dragView)

            if hasUserCustomPosition, let origin = customExpandedOrigin {
                // User already dragged it previously: preserve location
                let clampedX = min(screenRect.maxX - 100, max(screenRect.minX - width + 100, origin.x))
                let clampedY = min(screenRect.maxY - height, max(screenRect.minY, origin.y))
                targetFrame = NSRect(x: clampedX, y: clampedY, width: width, height: height)
            } else {
                // Initial expansion: centered horizontally, bottom above Dock
                let x = screenRect.origin.x + (screenRect.width - width) / 2
                let y = targetY(for: height, on: screen)
                targetFrame = NSRect(x: x, y: y, width: width, height: height)
            }
        } else {
            // COLLAPSED / NEW CHAT RESET:
            // "当然，当新建对话之后，收起来之后，位置应当归位"
            dragView.isHidden = true
            hasUserCustomPosition = false
            customExpandedOrigin = nil

            let defaultX = screenRect.origin.x + (screenRect.width - width) / 2
            let defaultY = targetY(for: height, on: screen)
            targetFrame = NSRect(x: defaultX, y: defaultY, width: width, height: height)
        }

        // If the window is currently hidden, set frame immediately without animation.
        // Invisible windows do not run AppKit animation groups properly and can get stuck.
        if !panel.isVisible {
            panel.setFrame(targetFrame, display: false)
            return
        }

        animateTo(newFrame: targetFrame)
    }

    private func animateTo(newFrame: NSRect) {
        guard let panel = window else { return }
        if abs(panel.frame.minX - newFrame.minX) < 1.0 &&
           abs(panel.frame.minY - newFrame.minY) < 1.0 &&
           abs(panel.frame.width - newFrame.width) < 1.0 &&
           abs(panel.frame.height - newFrame.height) < 1.0 {
            return
        }
        isProgrammaticAnimating = true
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().setFrame(newFrame, display: true)
        }, completionHandler: { [weak self] in
            guard let self = self else { return }
            self.isProgrammaticAnimating = false
            // Guarantee final frame is accurate even under high GPU/CPU load
            self.window?.setFrame(newFrame, display: true)
            self.window?.contentView?.layoutSubtreeIfNeeded()
            if let dragView = self.dragView {
                self.window?.invalidateCursorRects(for: dragView)
            }
        })
    }

    // MARK: - WKScriptMessageHandler
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "closeSpotlight" {
            hide()
        } else if message.name == "openMainWindow" || message.name == "openMainFromSpotlight" {
            hide()
            onOpenMainWindow?()
        } else if message.name == "resizePanel", let dict = message.body as? [String: Any] {
            let width = (dict["width"] as? CGFloat) ?? 540
            let height = (dict["height"] as? CGFloat) ?? 88
            let isExpanding = (dict["expanded"] as? Bool) ?? (height > 100)
            handleResizePanel(width: width, height: height, isExpanding: isExpanding)
        } else if message.name == "chooseDirectory", let dict = message.body as? [String: Any] {
            let currentPath = dict["currentPath"] as? String
            let callbackKey = dict["callbackKey"] as? String ?? "default"
            showDirectoryPicker(currentPath: currentPath, callbackKey: callbackKey)
        }
    }

    /// 弹出原生系统文件夹选择框，将选中的物理路径回传给网页前端
    private func showDirectoryPicker(currentPath: String?, callbackKey: String) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "选择"
        panel.message = "请选择项目所在文件夹"

        if let rawPath = currentPath, !rawPath.isEmpty {
            let expandedPath = (rawPath as NSString).expandingTildeInPath
            if FileManager.default.fileExists(atPath: expandedPath) {
                panel.directoryURL = URL(fileURLWithPath: expandedPath)
            }
        }

        panel.begin { [weak self] response in
            guard let self = self else { return }
            if response == .OK, let selectedURL = panel.url {
                let chosenPath = selectedURL.path
                let home = NSHomeDirectory()
                let displayPath = chosenPath.hasPrefix(home) ? "~" + chosenPath.dropFirst(home.count) : chosenPath
                guard let data = try? JSONSerialization.data(withJSONObject: [
                    "path": displayPath,
                    "key": callbackKey
                ]), let jsonStr = String(data: data, encoding: .utf8) else { return }
                self.webView.evaluateJavaScript("window.__onDirectoryChosen && window.__onDirectoryChosen(\(jsonStr))") { _, _ in }
            }
        }
    }

    // MARK: - WKNavigationDelegate
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("Spotlight provisional navigation failed: \(error.localizedDescription). Retrying in 0.5s...")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.loadContent()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("Spotlight navigation failed: \(error.localizedDescription). Retrying in 0.5s...")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.loadContent()
        }
    }

    // MARK: - WKUIDelegate (External Links)
    // Same as the main window: `target="_blank"` is dropped unless implemented here.
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
        openPanel.begin { response in
            completionHandler(response == .OK ? openPanel.urls : nil)
        }
    }
}
