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

class SpotlightPanelController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    var onOpenMainWindow: (() -> Void)?

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
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.hasShadow = false // Web content provides clean soft shadow to prevent double-border halos
        panel.isOpaque = false

        super.init(window: panel)

        setupWebView()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setupWebView() {
        guard let panel = window else { return }

        let config = WKWebViewConfiguration()
        config.processPool = AppState.processPool
        let userContent = WKUserContentController()
        userContent.add(self, name: "openMainWindow")
        userContent.add(self, name: "openMainFromSpotlight")
        userContent.add(self, name: "closeSpotlight")
        userContent.add(self, name: "resizePanel")
        config.userContentController = userContent

        webView = WKWebView(frame: panel.contentView?.bounds ?? .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground") // Fully transparent background

        panel.contentView?.addSubview(webView)
        loadContent()
    }

    func loadContent() {
        if let url = URL(string: "http://127.0.0.1:3000/#/spotlight") {
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

    func show() {
        guard let panel = window else { return }
        let screen = currentScreen()
        let screenRect = screen.visibleFrame

        let width = panel.frame.width
        let height = panel.frame.height
        let x = screenRect.origin.x + (screenRect.width - width) / 2
        let y = targetY(for: height, on: screen)

        panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)

        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
    }

    func hide() {
        window?.orderOut(nil)
    }

    func animateTo(width: CGFloat, height: CGFloat) {
        guard let panel = window else { return }
        let screen = currentScreen()
        let screenRect = screen.visibleFrame

        let newX = screenRect.origin.x + (screenRect.width - width) / 2
        let newY = targetY(for: height, on: screen)
        let newFrame = NSRect(x: newX, y: newY, width: width, height: height)

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().setFrame(newFrame, display: true)
        }
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
            animateTo(width: width, height: height)
        }
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
