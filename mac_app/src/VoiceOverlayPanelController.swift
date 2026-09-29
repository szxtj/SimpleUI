import Cocoa
import WebKit

/// 语音识别悬浮胶囊面板：**不可成为 key、不接收鼠标事件**。
/// 这样它既能浮在所有 App 之上，又绝不会把焦点从用户正在输入的输入框抢走
/// （焦点一旦被抢走，⌘V 就贴不到正确的位置了）。
class VoiceOverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// 屏幕**底部居中**的语音识别 UI 容器。
///
/// 与 Spotlight 浮窗同一套路：一个透明、非激活的浮动面板，内部加载
/// `http://127.0.0.1:31235/#/voice`，由 React 渲染胶囊本体（绿色渐变 + 麦克风 +
/// 电平点阵）。Swift 侧只负责定位、显隐与状态下发。
class VoiceOverlayPanelController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate {
    /// 面板尺寸（含阴影留白）；胶囊本体居中绘制（约为原始尺寸的 80%）
    private static let panelWidth: CGFloat = 240
    private static let panelHeight: CGFloat = 83
    /// 距屏幕可视区底边的高度（紧贴 Dock 上方一点点）
    private static let bottomInset: CGFloat = 12

    private var webView: WKWebView!
    private var webReady = false
    /// 最近一次状态（webView 尚未就绪时暂存，就绪后补发）
    private var pendingPayload: [String: Any] = ["state": VoiceInputState.idle.rawValue, "level": 0]
    private var autoHideWorkItem: DispatchWorkItem?

    init() {
        let panel = VoiceOverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.panelWidth, height: Self.panelHeight),
            styleMask: [.nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isOpaque = false
        // 关键：整块面板不接收鼠标事件，点击直接穿透到下面的 App
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.animationBehavior = .none

        super.init(window: panel)

        setupWebView()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setupWebView() {
        guard let panel = window else { return }
        let config = WKWebViewConfiguration()
        let userContent = WKUserContentController()
        userContent.add(self, name: "voiceOverlay")
        config.userContentController = userContent

        webView = WKWebView(frame: panel.contentView?.bounds ?? .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground") // 完全透明背景
        panel.contentView?.addSubview(webView)
    }

    func loadContent() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/#/voice") else { return }
        webView.load(URLRequest(url: url))
    }

    // MARK: - 定位与显隐

    private func currentScreen() -> NSScreen {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { NSPointInRect(mouse, $0.frame) }) ?? NSScreen.main ?? NSScreen.screens[0]
    }

    private func bottomCenterFrame(on screen: NSScreen) -> NSRect {
        let v = screen.visibleFrame
        let x = v.origin.x + (v.width - Self.panelWidth) / 2
        let y = v.origin.y + Self.bottomInset
        return NSRect(x: x, y: y, width: Self.panelWidth, height: Self.panelHeight)
    }

    /// 显示（不激活 App、不抢焦点）
    func show() {
        guard let panel = window else { return }
        autoHideWorkItem?.cancel()
        autoHideWorkItem = nil
        panel.setFrame(bottomCenterFrame(on: currentScreen()), display: true)
        panel.orderFrontRegardless()
    }

    func hide() {
        autoHideWorkItem?.cancel()
        autoHideWorkItem = nil
        window?.orderOut(nil)
    }

    // MARK: - 状态下发

    /// 更新胶囊状态；done / error 会自动延时收起，idle 立即收起
    func update(state: VoiceInputState, level: Float, text: String?, action: String?) {
        var payload: [String: Any] = ["state": state.rawValue, "level": level]
        if let text = text { payload["text"] = text }
        if let action = action { payload["action"] = action }
        pendingPayload = payload

        switch state {
        case .recording, .transcribing:
            show()
        case .done:
            show()
            scheduleAutoHide(after: 1.6)
        case .error:
            show()
            scheduleAutoHide(after: 2.4)
        case .idle:
            hide()
            return
        }

        pushState()
    }

    private func scheduleAutoHide(after seconds: TimeInterval) {
        autoHideWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.hide()
            self?.pendingPayload = ["state": VoiceInputState.idle.rawValue, "level": 0]
        }
        autoHideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func pushState() {
        guard webReady else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: pendingPayload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__setVoiceState && window.__setVoiceState(\(json))") { _, _ in }
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "voiceOverlay",
              let dict = message.body as? [String: Any],
              let action = dict["action"] as? String else { return }
        if action == "ready" {
            webReady = true
            pushState()
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 页面装载完成后再补发一次（didFinish 早于 React 挂载时靠 ready 消息兜底）
        pushState()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.loadContent()
        }
    }
}
