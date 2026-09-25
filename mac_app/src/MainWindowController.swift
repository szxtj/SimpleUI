import Cocoa
import WebKit
import UniformTypeIdentifiers

class TitleBarDragView: NSView {
    var isSidebarOpen: Bool = true

    override func hitTest(_ point: NSPoint) -> NSView? {
        // point passed to hitTest is in superview's coordinate system!
        guard frame.contains(point) else { return nil }

        let localPoint = convert(point, from: superview)
        let x = localPoint.x
        let totalWidth = bounds.width

        // 1. Native macOS Traffic Lights (x: 0 ... 78):
        // Always pass through so close/minimize/zoom buttons work!
        if x < 78.0 {
            return nil
        }

        if isSidebarOpen {
            let sidebarWidth: CGFloat = 260.0

            // 2. Sidebar Top Area (78 ... 260):
            // Collapse button on far-right of sidebar: x: (sidebarWidth - 45) ... sidebarWidth
            if x >= (sidebarWidth - 45.0) && x <= sidebarWidth {
                return nil // Click Collapse Sidebar button!
            }

            // Between 78 and (sidebarWidth - 45): EMPTY TOP OF SIDEBAR!
            if x < sidebarWidth {
                return self // Drag window!
            }

            // 3. Chat View Top Area (260 ... totalWidth):
            // Model Selector button: x: 260 ... (sidebarWidth + 210)
            if x >= sidebarWidth && x <= (sidebarWidth + 210.0) {
                return nil // Click Model Selector!
            }

            // Settings button on far-right: x: (totalWidth - 60) ... totalWidth
            if x >= (totalWidth - 60.0) {
                return nil // Click Settings!
            }

            // Empty title bar in Chat View: x: (sidebarWidth + 210) ... (totalWidth - 60)
            return self // Drag window!
        } else {
            // Sidebar is COLLAPSED (width = 0):
            // Open Sidebar button: x: 78 ... 122
            if x >= 78.0 && x <= 122.0 {
                return nil // Click Open Sidebar!
            }

            // Model Selector button: x: 122 ... 332
            if x > 122.0 && x <= 332.0 {
                return nil // Click Model Selector!
            }

            // Settings button on far-right: x: (totalWidth - 60) ... totalWidth
            if x >= (totalWidth - 60.0) {
                return nil // Click Settings!
            }

            // Empty title bar in Chat View: x: 332 ... (totalWidth - 60)
            return self // Drag window!
        }
    }

    override func mouseDown(with event: NSEvent) {
        // Drag window cleanly without double-click zooming to fullscreen
        window?.performDrag(with: event)
    }

    override var mouseDownCanMoveWindow: Bool {
        return true
    }
}

class MainWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var dragView: TitleBarDragView!
    var onShrinkToSpotlight: ((String?) -> Void)?

    init() {
        let width: CGFloat = 1180
        let height: CGFloat = 760

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.minSize = NSSize(width: 920, height: 580)
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
        userContent.add(self, name: "shrinkToSpotlight")
        config.userContentController = userContent

        webView = WKWebView(frame: win.contentView?.bounds ?? .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(true, forKey: "drawsBackground") // Main window uses solid background to avoid GPU compositor blur bugs

        win.contentView?.addSubview(webView)
        loadContent()
    }

    private func setupDragArea() {
        guard let win = window, let contentView = win.contentView else { return }

        // Top 52px drag area covering the entire window width with smart button hit-testing
        let topBarHeight: CGFloat = 52.0
        let dragRect = NSRect(
            x: 0,
            y: contentView.bounds.height - topBarHeight,
            width: contentView.bounds.width,
            height: topBarHeight
        )
        dragView = TitleBarDragView(frame: dragRect)
        dragView.autoresizingMask = [.width, .minYMargin]
        contentView.addSubview(dragView, positioned: .above, relativeTo: webView)
    }

    func loadContent() {
        if let url = URL(string: ProcessManager.baseURLString) {
            webView.load(URLRequest(url: url))
        }
    }

    func reload() {
        webView.reload()
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
        } else if message.name == "shrinkToSpotlight" {
            let dict = message.body as? [String: Any]
            let sessionId = dict?["sessionId"] as? String
            window?.orderOut(nil)
            onShrinkToSpotlight?(sessionId)
        }
    }

    // MARK: - NSWindowDelegate
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
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
