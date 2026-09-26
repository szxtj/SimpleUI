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
    private var initialMouseLocation: NSPoint = .zero
    private var initialWindowOrigin: NSPoint = .zero
    private var isDragging: Bool = false

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
        initialMouseLocation = NSEvent.mouseLocation
        initialWindowOrigin = window.frame.origin
        window.invalidateCursorRects(for: self)
    }

    override func mouseDragged(with event: NSEvent) {
        guard isDragging, let window = self.window else { return }
        let currentMouseLocation = NSEvent.mouseLocation
        let deltaX = currentMouseLocation.x - initialMouseLocation.x
        let deltaY = currentMouseLocation.y - initialMouseLocation.y
        let newOrigin = NSPoint(
            x: initialWindowOrigin.x + deltaX,
            y: initialWindowOrigin.y + deltaY
        )
        window.setFrameOrigin(newOrigin)
        onDidDrag?(newOrigin)
    }

    override func mouseUp(with event: NSEvent) {
        guard isDragging else { return }
        isDragging = false
        if let window = self.window {
            window.invalidateCursorRects(for: self)
            onDidDrag?(window.frame.origin)
        }
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

    func show() {
        guard let panel = window else { return }
        let screen = currentScreen()
        let screenRect = screen.visibleFrame

        if isExpanded && hasUserCustomPosition, let origin = customExpandedOrigin {
            // Restore to the exact user-dragged position, clamped safely within active screens
            let targetSize = panel.frame.size
            let clampedX = min(screenRect.maxX - 100, max(screenRect.minX - targetSize.width + 100, origin.x))
            let clampedY = min(screenRect.maxY - targetSize.height, max(screenRect.minY, origin.y))
            let targetFrame = NSRect(x: clampedX, y: clampedY, width: targetSize.width, height: targetSize.height)

            isProgrammaticAnimating = true
            panel.setFrame(targetFrame, display: true)
            isProgrammaticAnimating = false
        } else {
            // In compact state OR no custom position: default Dock-aligned bottom center
            let width = panel.frame.width
            let height = panel.frame.height
            let x = screenRect.origin.x + (screenRect.width - width) / 2
            let y = targetY(for: height, on: screen)

            isProgrammaticAnimating = true
            panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
            isProgrammaticAnimating = false
        }

        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
        if let view = webView {
            panel.makeFirstResponder(view)
        }
        webView.evaluateJavaScript("window.onSpotlightShown && window.onSpotlightShown()") { _, _ in }
    }

    func showWithSession(sessionId: String?) {
        show()
        if let sid = sessionId {
            webView.evaluateJavaScript("window.loadSessionInSpotlight && window.loadSessionInSpotlight('\(sid)')") { _, _ in }
        }
    }

    func hide() {
        window?.orderOut(nil)
    }

    func handleResizePanel(width: CGFloat, height: CGFloat, isExpanding: Bool) {
        guard let panel = window else { return }
        self.isExpanded = isExpanding

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

        animateTo(newFrame: targetFrame)
    }

    private func animateTo(newFrame: NSRect) {
        guard let panel = window else { return }
        isProgrammaticAnimating = true
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().setFrame(newFrame, display: true)
        }, completionHandler: { [weak self] in
            guard let self = self else { return }
            self.isProgrammaticAnimating = false
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
