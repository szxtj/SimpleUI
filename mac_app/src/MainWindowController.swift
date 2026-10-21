import Cocoa
import WebKit
import UniformTypeIdentifiers

class TitleBarDragView: NSView {
    var isSidebarOpen: Bool = true
    var isWikiPanelOpen: Bool = false
    /** 右侧面板当前宽度（由前端 usePanelWidth 通过 setPanelWidth 同步；关闭时忽略） */
    var panelWidth: CGFloat = 440.0

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

        // Mirror the web layout constants (Sidebar.tsx / usePanelWidth.ts)
        let sidebarWidth: CGFloat = 260.0

        let liveWidth: CGFloat = isWikiPanelOpen ? panelWidth : 0.0
        let chatRight: CGFloat = totalWidth - liveWidth

        // 1. Native macOS Traffic Lights (x: 0 ... 78):
        // Always pass through so close/minimize/zoom buttons work!
        if x < 78.0 {
            return nil
        }

        // 2. 右侧面板顶栏（x: chatRight ... totalWidth）：
        // 现在这里整条都是**标签栏**（标签 / + / 收起），全部必须可点 → 整块穿透。
        // 面板不再是"拖拽区"，拖窗交给对话区顶栏与左侧栏顶栏。
        if isWikiPanelOpen && x >= chatRight {
            return nil
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
            // 最大化按住顶栏拖拽：加上遮罩，遮盖单次重排并平滑淡出，彻底告别卡顿
            controller.unzoomAndDragWithOverlay(targetFrame: restore)
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

/// 窗口缩放时的全屏纯色尺寸指示遮罩（极速覆盖并冻结底层 WebKit 逐帧排版，彻底消除卡顿）
class ResizeOverlayView: NSView {
    private let pillView = NSView()
    private let dimensionLabel = NSTextField(labelWithString: "")
    private var fadeWorkItem: DispatchWorkItem?
    private var appIsDark: Bool?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        autoresizingMask = [.width, .height]
        isHidden = true
        alphaValue = 0

        pillView.wantsLayer = true
        pillView.translatesAutoresizingMaskIntoConstraints = false
        pillView.layer?.cornerRadius = 19.0
        pillView.layer?.masksToBounds = false
        addSubview(pillView)

        dimensionLabel.isBezeled = false
        dimensionLabel.drawsBackground = false
        dimensionLabel.isEditable = false
        dimensionLabel.isSelectable = false
        dimensionLabel.alignment = .center
        dimensionLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 18, weight: .semibold)
        dimensionLabel.translatesAutoresizingMaskIntoConstraints = false
        pillView.addSubview(dimensionLabel)

        NSLayoutConstraint.activate([
            pillView.centerXAnchor.constraint(equalTo: centerXAnchor),
            pillView.centerYAnchor.constraint(equalTo: centerYAnchor),
            pillView.heightAnchor.constraint(equalToConstant: 38),

            dimensionLabel.leadingAnchor.constraint(equalTo: pillView.leadingAnchor, constant: 20),
            dimensionLabel.trailingAnchor.constraint(equalTo: pillView.trailingAnchor, constant: -20),
            dimensionLabel.centerYAnchor.constraint(equalTo: pillView.centerYAnchor)
        ])

        if let stored = UserDefaults.standard.object(forKey: "simpleui_is_dark") as? Bool {
            self.appIsDark = stored
        }
        applyTheme()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // 关键：返回 nil 绝不拦截底层边框缩放/光标追踪/拖拽事件
    override func hitTest(_ point: NSPoint) -> NSView? {
        return nil
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        if appIsDark == nil {
            applyTheme()
        }
    }

    func setIsDarkMode(_ isDark: Bool) {
        self.appIsDark = isDark
        applyTheme()
    }

    private var isDarkMode: Bool {
        if let custom = appIsDark {
            return custom
        }
        if let match = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) {
            return match == .darkAqua
        }
        return effectiveAppearance.name.rawValue.contains("Dark")
    }

    func update(size: NSSize) {
        let w = Int(round(size.width))
        let h = Int(round(size.height))
        dimensionLabel.stringValue = "\(w) × \(h)"
    }

    private func applyTheme() {
        let dark = isDarkMode
        // 底色与主窗口 WebKit 背景完全保持一致（Light: #f8f9fb / Dark: #18191c）
        layer?.backgroundColor = dark
            ? NSColor(red: 24/255.0, green: 25/255.0, blue: 28/255.0, alpha: 1.0).cgColor
            : NSColor(red: 248/255.0, green: 249/255.0, blue: 251/255.0, alpha: 1.0).cgColor

        // 胶囊卡片（Pill Container）
        pillView.layer?.backgroundColor = dark
            ? NSColor(red: 34/255.0, green: 36/255.0, blue: 42/255.0, alpha: 0.95).cgColor
            : NSColor(red: 255/255.0, green: 255/255.0, blue: 255/255.0, alpha: 0.96).cgColor

        pillView.layer?.borderWidth = 1.0
        pillView.layer?.borderColor = dark
            ? NSColor(white: 1.0, alpha: 0.12).cgColor
            : NSColor(white: 0.0, alpha: 0.08).cgColor

        pillView.layer?.shadowColor = NSColor.black.cgColor
        pillView.layer?.shadowOpacity = dark ? 0.35 : 0.08
        pillView.layer?.shadowOffset = CGSize(width: 0, height: -2)
        pillView.layer?.shadowRadius = dark ? 10.0 : 8.0

        dimensionLabel.textColor = dark
            ? NSColor(red: 241/255.0, green: 243/255.0, blue: 247/255.0, alpha: 1.0)
            : NSColor(red: 31/255.0, green: 35/255.0, blue: 40/255.0, alpha: 1.0)
    }

    func showInstant(size: NSSize) {
        fadeWorkItem?.cancel()
        fadeWorkItem = nil
        update(size: size)
        applyTheme()
        alphaValue = 1.0
        isHidden = false
    }

    func showAnimated(size: NSSize, duration: TimeInterval = 0.10) {
        fadeWorkItem?.cancel()
        fadeWorkItem = nil
        update(size: size)
        applyTheme()
        isHidden = false
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = duration
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            animator().alphaValue = 1.0
        }
    }

    func hideAnimated(delay: TimeInterval = 0.08, duration: TimeInterval = 0.27, completion: (() -> Void)? = nil) {
        fadeWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = duration
                ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                self.animator().alphaValue = 0.0
            }, completionHandler: {
                if self.alphaValue == 0.0 {
                    self.isHidden = true
                }
                completion?()
            })
        }
        fadeWorkItem = work
        if delay > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        } else {
            work.perform()
        }
    }
}

class MainWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var dragView: TitleBarDragView!
    private var resizeOverlayView: ResizeOverlayView!
    var onShrinkToSpotlight: ((String?, Bool) -> Void)?
    /** 双击缩放前的原帧（自定义 zoom 态，替代 performZoom，见 toggleZoomAnimated 注释） */
    private var preZoomFrame: NSRect?
    /** 双击缩放的任务句柄 */
    private var zoomWorkItem: DispatchWorkItem?
    /** 用户在全屏下点了关闭：先退全屏，退完再隐藏窗口（避免全屏 Space 残留黑屏） */
    private var pendingCloseAfterFullscreenExit = false
    /** 标识是否正在执行受管的帧切换动画，防止重复触发 windowDidResize 遮罩 */
    private var isInternalFrameChange = false

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
        let initialIsDark: Bool = {
            if let stored = UserDefaults.standard.object(forKey: "simpleui_is_dark") as? Bool {
                return stored
            }
            if let match = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) {
                return match == .darkAqua
            }
            return false
        }()
        let initialBg = initialIsDark
            ? NSColor(red: 24/255.0, green: 25/255.0, blue: 28/255.0, alpha: 1.0)
            : NSColor(red: 248/255.0, green: 249/255.0, blue: 251/255.0, alpha: 1.0)
        window.backgroundColor = initialBg
        window.center()

        super.init(window: window)
        window.delegate = self

        setupWebView()
        setupDragArea()
        setupResizeOverlay()
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
        userContent.add(self, name: "setPanelWidth")
        userContent.add(self, name: "growWindow")
        userContent.add(self, name: "shrinkToSpotlight")
        // 语音输入权限桥（设置页「语音识别服务」卡片据此展示/申请三件套权限）
        userContent.add(self, name: "voiceInput")
        userContent.add(self, name: "openExternal")
        userContent.add(self, name: "chooseDirectory")
        userContent.add(self, name: "chooseFile")
        userContent.add(self, name: "setAppLanguage")
        userContent.add(self, name: "setAppTheme")
        userContent.add(self, name: "setTranslatorConfig")
        userContent.add(self, name: "translateSelection")
        userContent.add(self, name: "copyWordEquation")
        userContent.add(self, name: "copyRichData")
        userContent.add(self, name: "openTableInWord")
        userContent.add(self, name: "openImageInPreview")
        userContent.add(self, name: "saveImage")
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

    private func setupResizeOverlay() {
        guard let win = window, let contentView = win.contentView else { return }

        resizeOverlayView = ResizeOverlayView(frame: contentView.bounds)
        contentView.addSubview(resizeOverlayView, positioned: .above, relativeTo: dragView)
    }

    func updateWindowMinSize(isSidebarOpen: Bool) {
        guard let win = window else { return }
        // 宽度模型与前端 src/layout.ts 一致：
        //   窗口最小宽 = 左栏(0/260) + 中部最小 460 + 右栏(0/面板宽)
        // 左右两栏宽度固定，只有中部可伸缩 —— 拖动窗口边缘时右栏宽度锁死。
        let livePanelWidth: CGFloat = (dragView?.isWikiPanelOpen == true) ? (dragView?.panelWidth ?? 0) : 0
        let leftWidth: CGFloat = isSidebarOpen ? 260.0 : 0.0
        let minWidth: CGFloat = leftWidth + 460.0 + livePanelWidth
        let minHeight: CGFloat = 400.0
        win.minSize = NSSize(width: minWidth, height: minHeight)
        // 这里**不再**主动把窗口撑到 minSize：
        // 开合侧边栏时 minSize 会跳变，若在此强行 setFrame 会出现"点一下侧栏窗口猛跳一下"
        // （还会连带触发缩放态还原）。缺口由前端按 shortfall 调 growWindow 平滑补齐；
        // 这条 minSize 只用于约束用户手动拖窗口的下限。
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
        guard let win = window else { return }
        let wasVisible = win.isVisible
        if !wasVisible {
            win.alphaValue = 0.0
        }
        NSApp.activate(ignoringOtherApps: true)
        win.makeKeyAndOrderFront(nil)
        if !wasVisible {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                win.animator().alphaValue = 1.0
            }
        } else {
            win.alphaValue = 1.0
        }
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
        } else if message.name == "setPanelWidth", let width = message.body as? Double {
            // 面板左沿可拖拽改宽：只记值 + 重算最小宽度，不动窗口实际尺寸
            dragView?.panelWidth = CGFloat(width)
            updateWindowMinSize(isSidebarOpen: dragView?.isSidebarOpen ?? true)
        } else if message.name == "growWindow", let dict = message.body as? [String: Any] {
            // 展开/收起侧边栏：窗口同步伸缩，让中部对话列宽度不变
            let delta = (dict["delta"] as? Double) ?? 0
            let anchor = (dict["anchor"] as? String) ?? "right"
            growWindow(by: CGFloat(delta), anchor: anchor)
        } else if message.name == "shrinkToSpotlight" {
            let dict = message.body as? [String: Any]
            let sessionId = dict?["sessionId"] as? String
            let isExpanded = (dict?["isExpanded"] as? Bool) ?? true
            window?.orderOut(nil)
            onShrinkToSpotlight?(sessionId, isExpanded)
        } else if message.name == "voiceInput", let dict = message.body as? [String: Any] {
            handleVoiceInputMessage(dict)
        } else if message.name == "openExternal", let urlString = message.body as? String {
            openExternal(urlString)
        } else if message.name == "chooseDirectory", let dict = message.body as? [String: Any] {
            let currentPath = dict["currentPath"] as? String
            let callbackKey = dict["callbackKey"] as? String ?? "default"
            showDirectoryPicker(currentPath: currentPath, callbackKey: callbackKey)
        } else if message.name == "chooseFile", let dict = message.body as? [String: Any] {
            let currentPath = dict["currentPath"] as? String
            let callbackKey = dict["callbackKey"] as? String ?? "zim"
            let allowedExtensions = dict["allowedExtensions"] as? [String]
            showFilePicker(currentPath: currentPath, callbackKey: callbackKey, allowedExtensions: allowedExtensions)
        } else if message.name == "setAppLanguage", let dict = message.body as? [String: Any] {
            let lang = dict["lang"] as? String
            AppLocale.update(lang: lang)
            (NSApp.delegate as? AppDelegate)?.setupMainMenu()
            (NSApp.delegate as? AppDelegate)?.statusBarController?.refreshMenuLanguage()
            (NSApp.delegate as? AppDelegate)?.translationPanelController?.refreshLocaleAndSettings()
        } else if message.name == "setAppTheme", let dict = message.body as? [String: Any] {
            let isDark = (dict["isDark"] as? Bool) ?? false
            UserDefaults.standard.set(isDark, forKey: "simpleui_is_dark")
            resizeOverlayView.setIsDarkMode(isDark)
            let winBg = isDark
                ? NSColor(red: 24/255.0, green: 25/255.0, blue: 28/255.0, alpha: 1.0)
                : NSColor(red: 248/255.0, green: 249/255.0, blue: 251/255.0, alpha: 1.0)
            window?.backgroundColor = winBg
        } else if message.name == "setTranslatorConfig", let dict = message.body as? [String: Any] {
            DispatchQueue.main.async {
                TranslationProfileStore.shared.updateFromWebDict(dict)
                (NSApp.delegate as? AppDelegate)?.translationPanelController?.refreshLocaleAndSettings()
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
        }
    }

    // MARK: - Word Docx Export & Auto-cleanup
    private static var trackedDocxFiles: [URL] = []

    public static func cleanupAllTrackedWordExports() {
        let fileManager = FileManager.default
        let tempBase = fileManager.temporaryDirectory.appendingPathComponent("SimpleUI_Word_Exports", isDirectory: true)
        try? fileManager.removeItem(at: tempBase)
        let imgTempBase = fileManager.temporaryDirectory.appendingPathComponent("SimpleUI_Image_Previews", isDirectory: true)
        try? fileManager.removeItem(at: imgTempBase)
        trackedDocxFiles.removeAll()
    }

    public static func createAndOpenDocx(documentXml: String) {
        let fileManager = FileManager.default
        let tempBase = fileManager.temporaryDirectory.appendingPathComponent("SimpleUI_Word_Exports", isDirectory: true)

        // 自动清理超过 1 小时的旧临时文件
        if let existing = try? fileManager.contentsOfDirectory(at: tempBase, includingPropertiesForKeys: [.contentModificationDateKey], options: .skipsHiddenFiles) {
            let oneHourAgo = Date().addingTimeInterval(-3600)
            for file in existing {
                if let attrs = try? file.resourceValues(forKeys: [.contentModificationDateKey]),
                   let date = attrs.contentModificationDate, date < oneHourAgo {
                    try? fileManager.removeItem(at: file)
                }
            }
        }

        let runId = UUID().uuidString
        let tempFolder = tempBase.appendingPathComponent(runId, isDirectory: true)
        let wordDir = tempFolder.appendingPathComponent("word", isDirectory: true)
        let relsDir = tempFolder.appendingPathComponent("_rels", isDirectory: true)

        do {
            try fileManager.createDirectory(at: wordDir, withIntermediateDirectories: true)
            try fileManager.createDirectory(at: relsDir, withIntermediateDirectories: true)

            let contentTypes = """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
              <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
              <Default Extension="xml" ContentType="application/xml"/>
              <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
            </Types>
            """

            let rels = """
            <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
            </Relationships>
            """

            try contentTypes.data(using: .utf8)?.write(to: tempFolder.appendingPathComponent("[Content_Types].xml"))
            try rels.data(using: .utf8)?.write(to: relsDir.appendingPathComponent(".rels"))
            try documentXml.data(using: .utf8)?.write(to: wordDir.appendingPathComponent("document.xml"))

            let timestamp = Int(Date().timeIntervalSince1970)
            let docxFile = tempBase.appendingPathComponent("SimpleUI_Table_\(timestamp).docx")

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
            process.currentDirectoryURL = tempFolder
            process.arguments = ["-q", "-r", docxFile.path, "[Content_Types].xml", "_rels", "word"]
            try process.run()
            process.waitUntilExit()

            // 删除解压缩的中间目录
            try? fileManager.removeItem(at: tempFolder)

            // 直接调用 Microsoft Word 打开
            DispatchQueue.main.async {
                NSWorkspace.shared.open(docxFile)
                trackedDocxFiles.append(docxFile)
            }
        } catch {
            print("Failed to create docx:", error)
        }
    }

    // MARK: - Image Preview in macOS System (Preview.app)
    public static func openImageInSystemPreview(urlString: String) {
        guard !urlString.isEmpty else { return }

        let fileManager = FileManager.default

        // 1. 本地磁盘媒体库：/api/media/<filename>
        if urlString.contains("/api/media/") {
            let filename = urlString.components(separatedBy: "/api/media/").last?
                .components(separatedBy: "?").first?
                .components(separatedBy: "#").first ?? ""
            if !filename.isEmpty {
                let home = fileManager.homeDirectoryForCurrentUser
                let mediaFile = home.appendingPathComponent("Library/Application Support/SimpleUI/media", isDirectory: true)
                    .appendingPathComponent(filename)
                if fileManager.fileExists(atPath: mediaFile.path) {
                    DispatchQueue.main.async {
                        NSWorkspace.shared.open(mediaFile)
                    }
                    return
                }
            }
        }

        // 2. Base64 Data URL (data:image/png;base64,... 或 data:image/jpeg;base64,...)
        if urlString.hasPrefix("data:image/") {
            let parts = urlString.components(separatedBy: ",")
            if parts.count >= 2 {
                let header = parts[0].lowercased()
                let base64Data = parts[1]
                var ext = "png"
                if header.contains("jpeg") || header.contains("jpg") {
                    ext = "jpg"
                } else if header.contains("webp") {
                    ext = "webp"
                } else if header.contains("gif") {
                    ext = "gif"
                }

                if let data = Data(base64Encoded: base64Data, options: .ignoreUnknownCharacters) {
                    let tempBase = fileManager.temporaryDirectory.appendingPathComponent("SimpleUI_Image_Previews", isDirectory: true)
                    try? fileManager.createDirectory(at: tempBase, withIntermediateDirectories: true)

                    // 自动清理超过 1 小时的临时预览图片
                    if let existing = try? fileManager.contentsOfDirectory(at: tempBase, includingPropertiesForKeys: [.contentModificationDateKey], options: .skipsHiddenFiles) {
                        let oneHourAgo = Date().addingTimeInterval(-3600)
                        for file in existing {
                            if let attrs = try? file.resourceValues(forKeys: [.contentModificationDateKey]),
                               let date = attrs.contentModificationDate, date < oneHourAgo {
                                try? fileManager.removeItem(at: file)
                            }
                        }
                    }

                    let tempFile = tempBase.appendingPathComponent("SimpleUI_Preview_\(Int(Date().timeIntervalSince1970))_\(UUID().uuidString.prefix(8)).\(ext)")
                    do {
                        try data.write(to: tempFile)
                        DispatchQueue.main.async {
                            NSWorkspace.shared.open(tempFile)
                        }
                        return
                    } catch {
                        print("Failed to save temp preview image:", error)
                    }
                }
            }
        }

        // 3. 网络普通链接 (http:// 或 https://)
        if let url = URL(string: urlString), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            DispatchQueue.main.async {
                NSWorkspace.shared.open(url)
            }
        }
    }

    /// 弹出原生系统保存对话框（NSSavePanel），由用户指定保存路径将图片写到本地磁盘
    public func showSaveImagePanel(urlString: String) {
        guard let win = window else { return }
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

        let handleResponse: (NSApplication.ModalResponse) -> Void = { response in
            if response == .OK, let destinationURL = savePanel.url, let data = imageData {
                try? data.write(to: destinationURL)
            }
        }

        if win.attachedSheet != nil {
            savePanel.begin { response in handleResponse(response) }
        } else {
            savePanel.beginSheetModal(for: win) { response in handleResponse(response) }
        }
    }

    /// 弹出原生系统文件选择框，将选中的物理文件路径回传给网页前端
    private func showFilePicker(currentPath: String?, callbackKey: String, allowedExtensions: [String]?) {
        guard let win = window else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = AppLocale.isZh ? "选择" : "Select"
        panel.message = AppLocale.isZh ? "请选择知识库文件 (.zim)" : "Please select a Knowledge Base file (.zim)"
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

        let handleResponse: (NSApplication.ModalResponse) -> Void = { [weak self] response in
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

        if win.attachedSheet != nil {
            panel.begin { response in
                handleResponse(response)
            }
        } else {
            panel.beginSheetModal(for: win) { response in
                handleResponse(response)
            }
        }
    }

    /// 弹出原生系统文件夹选择框，将选中的物理路径回传给网页前端
    private func showDirectoryPicker(currentPath: String?, callbackKey: String) {
        guard let win = window else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = AppLocale.isZh ? "选择" : "Select"
        panel.message = AppLocale.isZh ? "请选择项目所在文件夹" : "Please select the project directory"

        if let rawPath = currentPath, !rawPath.isEmpty {
            let expandedPath = (rawPath as NSString).expandingTildeInPath
            if FileManager.default.fileExists(atPath: expandedPath) {
                panel.directoryURL = URL(fileURLWithPath: expandedPath)
            }
        }

        let handleResponse: (NSApplication.ModalResponse) -> Void = { [weak self] response in
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

        if win.attachedSheet != nil {
            panel.begin { response in
                handleResponse(response)
            }
        } else {
            panel.beginSheetModal(for: win) { response in
                handleResponse(response)
            }
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

    // MARK: - 实时窗口拉伸缩放（Live Resize）性能保护
    func windowWillStartLiveResize(_ notification: Notification) {
        guard let win = window else { return }
        // 1. 暂时剥离 webView 的自适应 autoresizingMask，避免中间 60~120 次鼠标移动事件逐帧触发 WebKit 频繁重排
        webView.autoresizingMask = []
        // 2. 快速淡入纯色尺寸遮罩
        resizeOverlayView.showAnimated(size: win.frame.size, duration: 0.10)
    }

    func windowDidResize(_ notification: Notification) {
        guard let win = window, let contentView = win.contentView else { return }
        if win.inLiveResize {
            resizeOverlayView.update(size: win.frame.size)
        } else if resizeOverlayView.isHidden && !isInternalFrameChange {
            // 只要有主窗口尺寸变化的情况就加遮罩（例如系统分屏/Magnet/Rectangle/显示器切换等触发的尺寸跳变）
            webView.autoresizingMask = []
            resizeOverlayView.showInstant(size: win.frame.size)
            webView.frame = contentView.bounds
            webView.autoresizingMask = [.width, .height]
            resizeOverlayView.hideAnimated(delay: 0.08, duration: 0.24)
        }
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        guard let win = window, let contentView = win.contentView else { return }
        // 1. 将 webView 一次性设置为最终尺寸并恢复自适应，整个拖拽过程仅触发 1 次最终排版
        webView.frame = contentView.bounds
        webView.autoresizingMask = [.width, .height]
        // 2. 等待 WebKit 单次重排绘制完成后，平滑淡出遮罩（留存时间延长 50%，充分掩盖重排过程）
        resizeOverlayView.hideAnimated(delay: 0.08, duration: 0.27)
    }

    // 响应原生交通灯绿色缩放按钮，对齐自定义极速遮罩过渡行为
    func windowShouldZoom(_ window: NSWindow, toFrame newFrame: NSRect) -> Bool {
        toggleZoomAnimated()
        return false
    }

    /// 最大化时按住顶栏拖拽还原（或任何非交互式尺寸跳变）：瞬间拉起全遮罩并冻结 WebKit 逐帧重排，重排就绪后淡出
    func unzoomAndDragWithOverlay(targetFrame: NSRect) {
        guard let win = window, let contentView = win.contentView else { return }
        webView.autoresizingMask = []
        resizeOverlayView.showInstant(size: targetFrame.size)
        isInternalFrameChange = true
        win.setFrame(targetFrame, display: false)
        isInternalFrameChange = false
        webView.frame = contentView.bounds
        webView.autoresizingMask = [.width, .height]
        // 留存时间与双击一致：0.08s 纯色遮盖排版 + 0.24s 平滑淡出
        resizeOverlayView.hideAnimated(delay: 0.08, duration: 0.24)
    }

    /// 展开/收起侧边栏时的窗口伸缩：中部对话列在屏幕上保持原宽度。
    ///
    /// - `anchor == "left"`：左边缘外扩（展开左栏时中部与右栏原地不动）
    /// - `anchor == "right"`：右边缘外扩（展开右栏时左栏与中部原地不动）
    /// - 全屏态不动 frame（中部只能被压缩，前端已用遮罩覆盖）
    /// - 自定义缩放态先回到双击前的尺寸再伸缩，避免把最大尺寸当基准
    /// - 屏幕挤不下时先保宽度再修 origin，最小不低于 `minSize`
    func growWindow(by delta: CGFloat, anchor: String) {
        guard let win = window, delta != 0 else { return }
        guard !win.styleMask.contains(.fullScreen) else { return }
        // 注意：**不动** preZoomFrame / 不进/出全屏。
        // 全屏态上面已经 return；自定义缩放态就以当前 frame 为基准，
        // 缺口通常会被屏幕钳制掉 —— 绝不"顺手还原成原始尺寸"。
        cancelZoomAnimation()

        let base = win.frame
        var target = base
        if anchor == "left" {
            target.origin.x -= delta
            target.size.width += delta
        } else {
            target.size.width += delta
        }

        if let screen = (win.screen ?? NSScreen.main)?.visibleFrame {
            if target.maxX > screen.maxX {
                target.size.width -= (target.maxX - screen.maxX)
            }
            if target.minX < screen.minX {
                let overflow = screen.minX - target.minX
                target.origin.x = screen.minX
                target.size.width -= overflow
            }
        }
        target.size.width = max(target.size.width, win.minSize.width)
        guard target.size.width > 100 else { return }

        isInternalFrameChange = true
        let done: () -> Void = { [weak self] in self?.isInternalFrameChange = false }

        if abs(target.size.width - base.size.width) < 0.5 && abs(target.origin.x - base.origin.x) < 0.5 {
            // 已被屏幕/最小宽度卡住：只把基准帧应用回去（缩放态还原）
            if base != win.frame {
                win.setFrame(base, display: true)
            }
            done()
            return
        }

        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.2
            ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            win.animator().setFrame(target, display: true)
        }, completionHandler: done)
    }

    // MARK: - 双击缩放（极速遮罩过渡）
    /// 中断进行中的缩放任务
    func cancelZoomAnimation() {
        zoomWorkItem?.cancel()
        zoomWorkItem = nil
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

        cancelZoomAnimation()

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

        // 策略 1：极速遮罩过渡（留存时间延长 50%，彻底覆盖窗口放大/还原过程中的重排卡顿）
        webView.autoresizingMask = []
        resizeOverlayView.showAnimated(size: targetFrame.size, duration: 0.12)

        let work = DispatchWorkItem { [weak self] in
            guard let self = self, let win = self.window, let contentView = win.contentView else { return }
            self.isInternalFrameChange = true
            win.setFrame(targetFrame, display: false)
            self.isInternalFrameChange = false
            self.webView.frame = contentView.bounds
            self.webView.autoresizingMask = [.width, .height]
            self.resizeOverlayView.hideAnimated(delay: 0.08, duration: 0.24)
        }
        zoomWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
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
