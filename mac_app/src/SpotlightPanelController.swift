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

/// A dedicated native overlay view across the top 52px header bar of the expanded Spotlight panel.
/// Tracks mouse events directly to move the NSPanel smoothly, while transparently passing
/// button clicks through to WKWebView based on the current page layout.
class SpotlightDragView: NSView {
    var onDidDrag: ((NSPoint) -> Void)?
    private(set) var isDragging: Bool = false
    private(set) var currentPage: String = "chat"
    private(set) var pageDepth: Int = 0

    override var mouseDownCanMoveWindow: Bool {
        return true
    }

    func updatePage(pageKind: String, depth: Int) {
        self.currentPage = pageKind
        self.pageDepth = depth
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let win = self.window else { return }
            win.invalidateCursorRects(for: self)
        }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        window?.invalidateCursorRects(for: self)
    }

    /// Determines the draggable horizontal range `(minX, maxX)` for the current page layout.
    /// Returns `nil` when the top bar should not intercept mouse drags (e.g. search input bar).
    private func draggableXRange() -> (minX: CGFloat, maxX: CGFloat)? {
        let totalWidth = bounds.width
        let hasBackButton = pageDepth > 1

        switch currentPage {
        case "raw-text":
            // Raw text page:
            // Left: Back button (0...48) if depth > 1, otherwise title & icon start at 0
            // Right: Copy All button (~80px) + Close button (~24px) + margin/gap = ~140px (x >= totalWidth - 140)
            let minX: CGFloat = hasBackButton ? 48.0 : 0.0
            let maxX: CGFloat = max(minX, totalWidth - 140.0)
            return (minX, maxX)

        case "image":
            // Image preview page:
            // Left: Back button (0...48) if depth > 1, otherwise icon + "Image WxH" text starts at 0
            // Right: Zoom controls (~98px) + [Reset (~28px)] + Copy (~28px) + Download (~28px) + Preview (~28px) + Close (~24px) + margins (~36px)
            // The action button cluster starts around totalWidth - 285.0 (~215.0 on 500px panel)
            let minX: CGFloat = hasBackButton ? 48.0 : 0.0
            let maxX: CGFloat = max(minX, totalWidth - 285.0)
            return (minX, maxX)

        case "wiki-search":
            // Search input field occupies the middle; pass all mouse events to web
            return nil

        case "wiki-article":
            // Wiki article page:
            // Left: Back button (0...48) if depth > 1
            // Right: Jump / External / Close buttons (totalWidth - 120 ... totalWidth)
            let minX: CGFloat = hasBackButton ? 48.0 : 0.0
            let maxX: CGFloat = max(minX, totalWidth - 120.0)
            return (minX, maxX)

        default:
            // Normal Chat view:
            // Left: Close button (0...44)
            // Right: New chat + Maximize buttons (totalWidth - 85 ... totalWidth)
            let minX: CGFloat = 44.0
            let maxX: CGFloat = max(minX, totalWidth - 85.0)
            return (minX, maxX)
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, frame.contains(point) else { return nil }

        let localPoint = convert(point, from: superview)
        let x = localPoint.x

        guard let range = draggableXRange() else {
            return nil
        }

        if x >= range.minX && x <= range.maxX {
            return self // Intercept mouse to drag window smoothly!
        }

        // Outside draggable range -> pass clicks directly through to WKWebView buttons!
        return nil
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
        guard let range = draggableXRange() else { return }
        let draggableWidth = range.maxX - range.minX
        if draggableWidth > 0 {
            let draggableRect = NSRect(x: range.minX, y: 0, width: draggableWidth, height: bounds.height)
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
    private var animationGeneration: Int = 0
    private var targetFrameSize: NSSize = NSSize(width: 540, height: 88)

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
        userContent.add(self, name: "chooseFile")
        userContent.add(self, name: "openImageInPreview")
        userContent.add(self, name: "saveImage")
        userContent.add(self, name: "translateSelection")
        userContent.add(self, name: "copyWordEquation")
        userContent.add(self, name: "copyRichData")
        userContent.add(self, name: "openTableInWord")
        userContent.add(self, name: "openExternal")
        userContent.add(self, name: "spotlightPageStateChanged")
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
            dragView.heightAnchor.constraint(equalToConstant: 52.0)
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

    func show(isExpanded: Bool? = nil, notifyJS: Bool = true) {
        guard let panel = window else { return }
        if let exp = isExpanded {
            self.isExpanded = exp
        }
        let screen = currentScreen()
        let screenRect = screen.visibleFrame

        dragView?.isHidden = !self.isExpanded

        let targetWidth: CGFloat = self.isExpanded ? 500 : 540
        let targetHeight: CGFloat = self.isExpanded ? 640 : 88
        self.targetFrameSize = NSSize(width: targetWidth, height: targetHeight)
        self.animationGeneration += 1

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

        let wasVisible = panel.isVisible
        isProgrammaticAnimating = true
        if !wasVisible {
            panel.alphaValue = 0.0
        }
        panel.setFrame(targetFrame, display: true)
        isProgrammaticAnimating = false

        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
        if let view = webView {
            panel.makeFirstResponder(view)
        }
        if !wasVisible {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().alphaValue = 1.0
            }
        } else {
            panel.alphaValue = 1.0
        }
        if notifyJS {
            webView.evaluateJavaScript("window.onSpotlightShown && window.onSpotlightShown()") { _, _ in }
        }
    }

    func showWithSession(sessionId: String?, isExpanded: Bool = true) {
        if let sid = sessionId, !sid.isEmpty {
            let expLiteral = isExpanded ? "true" : "false"
            // Evaluate loadSessionInSpotlight BEFORE showing/focusing the panel so JS state
            // already points to the target session and knows its expanded state.
            webView.evaluateJavaScript("window.loadSessionInSpotlight && window.loadSessionInSpotlight('\(sid)', \(expLiteral))") { _, _ in }
            show(isExpanded: isExpanded, notifyJS: false)
        } else {
            show(isExpanded: isExpanded, notifyJS: true)
        }
    }

    func hide() {
        window?.orderOut(nil)
    }

    /// Resets the panel geometry to the compact bottom capsule state while hidden
    private func resetToCollapsedCapsuleWhileHidden() {
        guard let panel = window else { return }
        self.isExpanded = false
        self.dragView?.isHidden = true
        self.dragView?.updatePage(pageKind: "chat", depth: 0)
        self.hasUserCustomPosition = false
        self.customExpandedOrigin = nil
        let width: CGFloat = 540
        let height: CGFloat = 88
        self.targetFrameSize = NSSize(width: width, height: height)
        self.animationGeneration += 1
        let screen = currentScreen()
        let screenRect = screen.visibleFrame
        let defaultX = screenRect.origin.x + (screenRect.width - width) / 2
        let defaultY = targetY(for: height, on: screen)
        isProgrammaticAnimating = true
        panel.setFrame(NSRect(x: defaultX, y: defaultY, width: width, height: height), display: false)
        isProgrammaticAnimating = false
    }

    func handleResizePanel(width: CGFloat, height: CGFloat, isExpanding: Bool) {
        guard let panel = window else { return }

        // If the user is actively dragging the window with mouse, never interrupt or jitter!
        if dragView?.isDragging == true {
            return
        }

        self.isExpanded = isExpanding

        // Skip if both current frame and target size already match
        if !isProgrammaticAnimating &&
           abs(panel.frame.width - width) < 1.0 &&
           abs(panel.frame.height - height) < 1.0 &&
           abs(targetFrameSize.width - width) < 1.0 &&
           abs(targetFrameSize.height - height) < 1.0 {
            dragView.isHidden = !isExpanding
            return
        }

        self.targetFrameSize = NSSize(width: width, height: height)
        self.animationGeneration += 1

        let screen = currentScreen()
        let screenRect = screen.visibleFrame

        var targetFrame: NSRect

        if isExpanding {
            // EXPANDED:
            dragView.isHidden = false

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
            dragView.isHidden = true
            hasUserCustomPosition = false
            customExpandedOrigin = nil

            let defaultX = screenRect.origin.x + (screenRect.width - width) / 2
            let defaultY = targetY(for: height, on: screen)
            targetFrame = NSRect(x: defaultX, y: defaultY, width: width, height: height)
        }

        // Instant frame update without heavy multi-frame WKWebView geometry interpolation
        isProgrammaticAnimating = true
        panel.setFrame(targetFrame, display: panel.isVisible)
        isProgrammaticAnimating = false
        if panel.isVisible {
            panel.contentView?.layoutSubtreeIfNeeded()
            if let dragView = self.dragView {
                panel.invalidateCursorRects(for: dragView)
            }
        }
    }

    // MARK: - WKScriptMessageHandler
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "closeSpotlight" {
            hide()
        } else if message.name == "openMainWindow" || message.name == "openMainFromSpotlight" {
            let wasVisible = window?.isVisible ?? false
            hide()
            resetToCollapsedCapsuleWhileHidden()
            if wasVisible {
                onOpenMainWindow?()
            }
        } else if message.name == "resizePanel", let dict = message.body as? [String: Any] {
            let width = (dict["width"] as? CGFloat) ?? 540
            let height = (dict["height"] as? CGFloat) ?? 88
            let isExpanding = (dict["expanded"] as? Bool) ?? (height > 100)
            handleResizePanel(width: width, height: height, isExpanding: isExpanding)
        } else if message.name == "chooseDirectory", let dict = message.body as? [String: Any] {
            let currentPath = dict["currentPath"] as? String
            let callbackKey = dict["callbackKey"] as? String ?? "default"
            showDirectoryPicker(currentPath: currentPath, callbackKey: callbackKey)
        } else if message.name == "chooseFile", let dict = message.body as? [String: Any] {
            let currentPath = dict["currentPath"] as? String
            let callbackKey = dict["callbackKey"] as? String ?? "zim"
            let allowedExtensions = dict["allowedExtensions"] as? [String]
            showFilePicker(currentPath: currentPath, callbackKey: callbackKey, allowedExtensions: allowedExtensions)
        } else if message.name == "openImageInPreview", let dict = message.body as? [String: Any] {
            if let urlString = dict["url"] as? String {
                DispatchQueue.global(qos: .userInitiated).async {
                    MainWindowController.openImageInSystemPreview(urlString: urlString)
                }
            }
        } else if message.name == "saveImage", let dict = message.body as? [String: Any] {
            if let urlString = dict["url"] as? String {
                DispatchQueue.main.async {
                    self.showSaveImagePanel(urlString: urlString)
                }
            }
        } else if message.name == "translateSelection", let dict = message.body as? [String: Any] {
            let text = (dict["text"] as? String) ?? ""
            let trimmed = String(
                text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000)
            )
            guard !trimmed.isEmpty else { return }
            DispatchQueue.main.async {
                (NSApp.delegate as? AppDelegate)?.translationPanelController?.present(
                    text: trimmed, mode: .quick, autoTranslate: true)
            }
        } else if message.name == "copyWordEquation", let dict = message.body as? [String: Any] {
            let mathml = dict["mathml"] as? String ?? ""
            DispatchQueue.main.async {
                let pb = NSPasteboard.general
                pb.clearContents()
                // Claude 黄金法则：只写唯一的纯文本 MathML，绝不放任何 HTML/RTF，让 Word 内容嗅探直接命中公式转换！
                pb.setString(mathml, forType: .string)
            }
        } else if message.name == "copyRichData", let dict = message.body as? [String: Any] {
            let html = dict["html"] as? String ?? ""
            let plainText = dict["plainText"] as? String ?? ""
            DispatchQueue.main.async {
                let pb = NSPasteboard.general
                pb.clearContents()
                if !html.isEmpty {
                    pb.setString(html, forType: .html)
                }
                if !plainText.isEmpty {
                    pb.setString(plainText, forType: .string)
                }
            }
        } else if message.name == "openTableInWord", let dict = message.body as? [String: Any] {
            if let docXml = dict["documentXml"] as? String {
                DispatchQueue.global(qos: .userInitiated).async {
                    MainWindowController.createAndOpenDocx(documentXml: docXml)
                }
            }
        } else if message.name == "openExternal", let urlString = message.body as? String {
            guard let url = URL(string: urlString),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https" else { return }
            NSWorkspace.shared.open(url)
        } else if message.name == "spotlightPageStateChanged", let dict = message.body as? [String: Any] {
            let pageKind = dict["page"] as? String ?? "chat"
            let depth = (dict["depth"] as? Int) ?? (dict["depth"] as? NSNumber)?.intValue ?? 0
            dragView?.updatePage(pageKind: pageKind, depth: depth)
        }
    }

    /// 弹出原生系统保存对话框（NSSavePanel），由用户指定保存路径将图片写到本地磁盘
    private func showSaveImagePanel(urlString: String) {
        let savePanel = NSSavePanel()
        let isZh = AppLocale.isZh
        savePanel.title = isZh ? "保存图片" : "Save Image"
        savePanel.prompt = isZh ? "保存" : "Save"
        savePanel.canCreateDirectories = true

        let timestamp = Int(Date().timeIntervalSince1970)
        var defaultExt = "png"
        var imageData: Data? = nil

        if urlString.contains("/api/media/") {
            let filename = urlString.components(separatedBy: "/api/media/").last?
                .components(separatedBy: "?").first?
                .components(separatedBy: "#").first ?? ""
            if !filename.isEmpty {
                let home = FileManager.default.homeDirectoryForCurrentUser
                let mediaFile = home.appendingPathComponent("Library/Application Support/SimpleUI/media", isDirectory: true)
                    .appendingPathComponent(filename)
                let ext = mediaFile.pathExtension
                if !ext.isEmpty { defaultExt = ext }
                imageData = try? Data(contentsOf: mediaFile)
            }
        } else if urlString.hasPrefix("data:image/") {
            let parts = urlString.components(separatedBy: ",")
            if parts.count >= 2 {
                let header = parts[0].lowercased()
                if header.contains("jpeg") || header.contains("jpg") {
                    defaultExt = "jpg"
                } else if header.contains("webp") {
                    defaultExt = "webp"
                } else if header.contains("gif") {
                    defaultExt = "gif"
                }
                imageData = Data(base64Encoded: parts[1], options: .ignoreUnknownCharacters)
            }
        } else if let url = URL(string: urlString) {
            let ext = url.pathExtension
            if !ext.isEmpty { defaultExt = ext }
            imageData = try? Data(contentsOf: url)
        }

        savePanel.nameFieldStringValue = "SimpleUI_\(timestamp).\(defaultExt)"
        if let type = UTType(filenameExtension: defaultExt) {
            savePanel.allowedContentTypes = [type]
        }

        savePanel.begin { response in
            if response == .OK, let destinationURL = savePanel.url, let data = imageData {
                try? data.write(to: destinationURL)
            }
        }
    }

    /// 弹出原生系统文件选择框，将选中的物理文件路径回传给网页前端
    private func showFilePicker(currentPath: String?, callbackKey: String, allowedExtensions: [String]?) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "选择"
        panel.message = "请选择知识库文件 (.zim)"
        panel.allowsOtherFileTypes = true

        if let exts = allowedExtensions, !exts.isEmpty {
            let types = exts.compactMap { UTType(filenameExtension: $0) }
            if !types.isEmpty {
                panel.allowedContentTypes = types
            }
        }

        if let rawPath = currentPath, !rawPath.isEmpty {
            let expandedPath = (rawPath as NSString).expandingTildeInPath
            if FileManager.default.fileExists(atPath: expandedPath) {
                let url = URL(fileURLWithPath: expandedPath)
                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: expandedPath, isDirectory: &isDir) {
                    if isDir.boolValue {
                        panel.directoryURL = url
                    } else {
                        panel.directoryURL = url.deletingLastPathComponent()
                    }
                }
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
                self.webView.evaluateJavaScript("window.__onFileChosen && window.__onFileChosen(\(jsonStr))") { _, _ in }
            }
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
