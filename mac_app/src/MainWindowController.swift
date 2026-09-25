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
            // Model Selector button: x: 260 ... (sidebarWidth + 210), capped to never overlap right tools
            let maxModelSelectorX = min(sidebarWidth + 210.0, totalWidth - 65.0)
            if x >= sidebarWidth && x <= maxModelSelectorX {
                return nil // Click Model Selector!
            }

            // Shrink / Action button on far-right: x: (totalWidth - 60) ... totalWidth
            if x >= (totalWidth - 60.0) {
                return nil // Click Shrink to Spotlight!
            }

            // Empty title bar in Chat View: drag window!
            if x > maxModelSelectorX && x < (totalWidth - 60.0) {
                return self
            }
            return nil
        } else {
            // Sidebar is COLLAPSED (width = 0):
            // Open Sidebar button: x: 78 ... 122
            if x >= 78.0 && x <= 122.0 {
                return nil // Click Open Sidebar!
            }

            // Model Selector button: x: 122 ... capped to never overlap right tools
            let maxModelSelectorX = min(332.0, totalWidth - 65.0)
            if x > 122.0 && x <= maxModelSelectorX {
                return nil // Click Model Selector!
            }

            // Shrink / Action button on far-right: x: (totalWidth - 60) ... totalWidth
            if x >= (totalWidth - 60.0) {
                return nil // Click Shrink to Spotlight!
            }

            // Empty title bar in Chat View: drag window!
            if x > maxModelSelectorX && x < (totalWidth - 60.0) {
                return self
            }
            return nil
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
        userContent.add(self, name: "shrinkToSpotlight")
        config.userContentController = userContent

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
        let minWidth: CGFloat = isSidebarOpen ? 700.0 : 450.0
        let minHeight: CGFloat = 400.0
        win.minSize = NSSize(width: minWidth, height: minHeight)

        if isSidebarOpen && win.frame.width < minWidth {
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
