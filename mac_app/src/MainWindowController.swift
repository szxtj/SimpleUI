import Cocoa
import WebKit
import UniformTypeIdentifiers

class TitleBarDragView: NSView {
    var isSidebarOpen: Bool = true
    var isWikiPanelOpen: Bool = false

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
        userContent.add(self, name: "setWikiPanelOpen")
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
        }
    }

    // MARK: - NSWindowDelegate
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
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
