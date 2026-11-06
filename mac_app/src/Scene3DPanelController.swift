import Cocoa
import WebKit

/// 3D 场景构建独立窗口：承载 `http://127.0.0.1:31235/#/scene3d`。
///
/// 生命周期契约（与其它受管服务一致）：
///   - 打开窗口 → `POST /api/scene3d/ensure`（模型不全后台补下载、进程不在后台拉起，均不阻塞）；
///   - 关闭窗口 → `POST /api/scene3d/release` 终止 llama-server 进程、卸载模型，
///     并像字幕面板一样带核对补发（release 丢失时最多重发 3 次）。
///
/// WebView 常驻（orderOut 隐藏而非销毁）：重开窗口免冷加载页面，
/// 模型的加载/卸载完全由 ensure / release 驱动，与页面是否重新加载无关。
final class Scene3DWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// 开放式顶栏的拖拽层：与主窗口同一套做法 —— 窗口内容伸到标题栏下方（`.fullSizeContentView`），
/// 顶部 52pt 由本视图接管，可拖动整窗、双击切换标准尺寸。
///
/// `hitTest` 有两处必须穿透：
///   1. 左侧 78pt —— 红绿黄三个按钮画在标题栏里，被遮住就点不到了；
///   2. 全屏预览打开后最右侧那组工具按钮（重载/复制/关闭）—— 预览层贴着窗口顶边画，
///      它的按钮就落在本视图里，不放行就是「点了没反应」。
/// （WKWebView 会吞掉鼠标事件，光靠 `isMovableByWindowBackground` 拖不动窗口。）
final class Scene3DTitleBarDragView: NSView {
    private static let trafficLightZone: CGFloat = 78.0
    /// 预览顶栏右侧工具组让出的宽度（三个 32pt 圆钮 + 间距 + 内边距，留足余量）
    private static let previewToolbarZone: CGFloat = 200.0

    /// 由页面通过 `scene3dChrome` 桥同步：全屏预览是否打开（页面切换时也会同步）
    var previewOverlayActive = false
    /// 双击缩放 / 缩放态拖拽还原（与主窗口同一份实现，见 WindowResizeChrome）
    weak var resizeChrome: WindowResizeChrome?

    private var dragging = false
    private var pendingUnzoom = false
    private var initialMouseLocation = NSPoint.zero
    private var initialWindowOrigin = NSPoint.zero

    override func hitTest(_ point: NSPoint) -> NSView? {
        // point 是 superview 坐标系
        guard frame.contains(point) else { return nil }
        let localPoint = convert(point, from: superview)
        if localPoint.x < Self.trafficLightZone { return nil }
        if previewOverlayActive && localPoint.x >= bounds.width - Self.previewToolbarZone { return nil }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        guard let win = window else { return }
        if event.clickCount >= 2 {
            // 与主窗口一致：走带遮罩的自定义缩放，而不是系统的 performZoom
            resizeChrome?.toggleZoomAnimated()
            return
        }
        dragging = true
        initialMouseLocation = NSEvent.mouseLocation
        initialWindowOrigin = win.frame.origin
        pendingUnzoom = resizeChrome?.isZoomed ?? false
    }

    override func mouseDragged(with event: NSEvent) {
        guard dragging, let win = window else { return }
        let mouse = NSEvent.mouseLocation

        // 缩放态下首次实际拖动：先还原到原尺寸再无缝续拖（macOS 习惯）
        if pendingUnzoom {
            guard let restore = resizeChrome?.unzoomForTitleBarDrag(at: mouse, start: initialMouseLocation) else {
                return
            }
            initialMouseLocation = mouse
            initialWindowOrigin = restore.origin
            pendingUnzoom = false
            return
        }

        win.setFrameOrigin(NSPoint(
            x: initialWindowOrigin.x + (mouse.x - initialMouseLocation.x),
            y: initialWindowOrigin.y + (mouse.y - initialMouseLocation.y)
        ))
    }

    override func mouseUp(with event: NSEvent) {
        dragging = false
        pendingUnzoom = false
    }

    override var mouseDownCanMoveWindow: Bool { true }
}

final class Scene3DPanelController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private static let defaultWidth: CGFloat = 1180
    private static let defaultHeight: CGFloat = 760
    private static let minWidth: CGFloat = 860
    private static let minHeight: CGFloat = 560

    private var panel: Scene3DWindow?
    private var webView: WKWebView?
    private var dragView: Scene3DTitleBarDragView?
    /// 尺寸遮罩 + 双击缩放（与主窗口、Markdown 编辑器窗口共用，见 WindowResizeChrome）
    private var resizeChrome: WindowResizeChrome?
    private var webReady = false
    /// 关窗卸载的核对批次号：每次开/关窗自增，旧的核对链看到编号变了就自行放弃，
    /// 避免「关 → 立刻开」时上一次的补发 release 把刚拉起来的新进程杀掉。
    private var releaseVerifyToken = 0
    private static let maxReleaseAttempts = 3

    var isVisible: Bool { panel?.isVisible ?? false }

    // MARK: - 开窗

    func showAndFocus() {
        if Thread.isMainThread {
            performShow()
        } else {
            DispatchQueue.main.async { [weak self] in self?.performShow() }
        }
    }

    private func performShow() {
        // 作废上一次关窗遗留的卸载核对（它可能正打算补发 release）
        releaseVerifyToken &+= 1

        let p = panel ?? makePanel()
        panel = p
        if !webReady {
            loadContent()
        }
        ensureService()

        if !p.isVisible {
            center(p)
        }
        p.makeKeyAndOrderFront(nil)
        p.orderFrontRegardless()
    }

    private func makePanel() -> Scene3DWindow {
        let p = Scene3DWindow(
            contentRect: NSRect(x: 0, y: 0, width: Self.defaultWidth, height: Self.defaultHeight),
            // `.fullSizeContentView`：内容一直画到窗口顶边，标题栏透明 —— 与主窗口同一套「开放式」外观
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        p.title = AppLocale.isZh ? "3D 场景构建" : "3D Scene Builder"
        p.titleVisibility = .hidden
        p.titlebarAppearsTransparent = true
        p.isMovableByWindowBackground = true
        // 底色与页面根节点一致（#131417 / #fafafa），避免首帧/露边时闪白
        p.backgroundColor = Self.windowBackgroundColor()
        p.minSize = NSSize(width: Self.minWidth, height: Self.minHeight)
        p.isReleasedWhenClosed = false
        p.isRestorable = false
        p.hidesOnDeactivate = false
        p.animationBehavior = .utilityWindow
        p.delegate = self

        let config = WKWebViewConfiguration()
        _ = makeWebView(in: p, config: config)
        installDragArea(in: p)
        // 实时拉伸遮罩 / 双击缩放 / 拖拽还原，整套与主窗口同一份实现
        resizeChrome = WindowResizeChrome(window: p, webView: webView!, above: dragView)
        dragView?.resizeChrome = resizeChrome
        return p
    }

    private static func windowBackgroundColor() -> NSColor {
        let isDark: Bool = {
            if let stored = UserDefaults.standard.object(forKey: "simpleui_is_dark") as? Bool {
                return stored
            }
            if let match = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) {
                return match == .darkAqua
            }
            return false
        }()
        return isDark
            ? NSColor(red: 19/255.0, green: 20/255.0, blue: 23/255.0, alpha: 1.0)
            : NSColor(red: 250/255.0, green: 250/255.0, blue: 250/255.0, alpha: 1.0)
    }

    /// 顶部 52pt 拖拽带（与前端两个列头的 52px 等高，保证盖住的都是非交互区域）
    private func installDragArea(in panel: Scene3DWindow) {
        guard let contentView = panel.contentView else { return }
        let drag = Scene3DTitleBarDragView()
        drag.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(drag, positioned: .above, relativeTo: webView)
        NSLayoutConstraint.activate([
            drag.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            drag.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            drag.topAnchor.constraint(equalTo: contentView.topAnchor),
            drag.heightAnchor.constraint(equalToConstant: 52.0)
        ])
        dragView = drag
    }

    private func makeWebView(in panel: Scene3DWindow, config: WKWebViewConfiguration) -> WKWebView {
        // 页面把「全屏预览是否打开」告诉原生：预览层贴顶画，拖拽层要给它右侧的按钮放行
        let userContent = WKUserContentController()
        userContent.add(self, name: "scene3dChrome")
        config.userContentController = userContent

        let wv = WKWebView(frame: panel.contentView?.bounds ?? .zero, configuration: config)
        wv.autoresizingMask = [.width, .height]
        wv.navigationDelegate = self
        // 没有它，网页里 <input type="file"> 的 click() 会静默无响应（+/附件按钮失效）
        wv.uiDelegate = self
        panel.contentView?.addSubview(wv)
        webView = wv
        return wv
    }

    private func loadContent() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/#/scene3d") else { return }
        webView?.load(URLRequest(url: url))
    }

    private func center(_ p: NSWindow) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSPointInRect(mouse, $0.frame) })
            ?? NSScreen.main ?? NSScreen.screens[0]
        let visible = screen.visibleFrame
        let origin = NSPoint(
            x: visible.midX - p.frame.width / 2,
            y: visible.midY - p.frame.height / 2
        )
        p.setFrameOrigin(origin)
    }

    // MARK: - 服务生命周期

    /// 打窗即后台拉起（fire-and-forget，加载进度由前端轮询 /api/scene3d/status 展示）
    private func ensureService() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/scene3d/ensure") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        URLSession.shared.dataTask(with: req).resume()
    }

    func hide() {
        if Thread.isMainThread {
            performHide()
        } else {
            DispatchQueue.main.async { [weak self] in self?.performHide() }
        }
    }

    private func performHide() {
        guard let p = panel, p.isVisible else { return }
        requestServiceRelease()
        p.orderOut(nil)
    }

    // MARK: - 关窗卸载的确认与补发（与 SubtitleOverlayPanelController 同一套模式）

    /// release 请求若丢失（代理正在重启、端口瞬断），3.4 GB 的模型进程会一直驻留内存
    /// 直到退出 App。关窗后主动核对一次，确认仍有进程在跑就重发，最多 3 次；
    /// 代理不可达时不再重试 —— 退出路径的进程清扫会兜底。
    private func requestServiceRelease() {
        releaseVerifyToken &+= 1
        let token = releaseVerifyToken
        postRelease()
        verifyServiceReleased(token: token, sent: 1)
    }

    private func postRelease() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/scene3d/release") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        URLSession.shared.dataTask(with: req).resume()
    }

    private func verifyServiceReleased(token: Int, sent: Int) {
        guard sent <= Self.maxReleaseAttempts else { return }
        let delay: TimeInterval = sent == 1 ? 0.5 : 1.0
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self,
                  self.releaseVerifyToken == token,
                  !self.isVisible else { return }
            self.fetchScene3dRunState { stillActive, reachable in
                guard reachable, self.releaseVerifyToken == token, !self.isVisible else { return }
                guard stillActive else {
                    NSLog("[Scene3D] ✅ 模型进程已确认卸载（第 \(sent) 次 release）")
                    return
                }
                guard sent < Self.maxReleaseAttempts else {
                    NSLog("[Scene3D] ⚠️ 连续 \(sent) 次 release 后进程仍在运行，交由退出清扫兜底")
                    return
                }
                NSLog("[Scene3D] ⚠️ release 未生效，重发（第 \(sent + 1) 次）")
                self.postRelease()
                self.verifyServiceReleased(token: token, sent: sent + 1)
            }
        }
    }

    /// 读取 3D 服务运行状态：`completion(是否仍有进程在运行, 代理是否可达)`，始终在主线程回调。
    /// 判定看 `running` —— ready 只在健康检查通过后为 true，加载中同样算「仍在运行」。
    private func fetchScene3dRunState(completion: @escaping (Bool, Bool) -> Void) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/scene3d/status") else {
            DispatchQueue.main.async { completion(false, false) }
            return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { data, response, error in
            var stillActive = false
            var reachable = false
            if error == nil,
               let http = response as? HTTPURLResponse, http.statusCode == 200,
               let data = data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                reachable = true
                stillActive = (obj["running"] as? Bool) ?? false
            }
            DispatchQueue.main.async { completion(stillActive, reachable) }
        }.resume()
    }

    // MARK: - NSWindowDelegate

    func windowWillStartLiveResize(_ notification: Notification) {
        resizeChrome?.windowWillStartLiveResize()
    }

    func windowDidResize(_ notification: Notification) {
        resizeChrome?.windowDidResize()
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        resizeChrome?.windowDidEndLiveResize()
    }

    /// 绿色交通灯：走与双击一致的动画缩放（返回 false 阻止系统 performZoom）
    func windowShouldZoom(_ window: NSWindow, toFrame newFrame: NSRect) -> Bool {
        resizeChrome?.handleWindowShouldZoom() ?? false
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // 关闭 = 隐藏 + 卸载模型（WebView 常驻，重开免冷加载）
        requestServiceRelease()
        sender.orderOut(nil)
        return false
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webReady = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.loadContent()
        }
    }

    // MARK: - WKScriptMessageHandler

    /// `{ preview: Bool }`：全屏预览开着时，窗口顶部 52pt 已被预览顶栏占满，
    /// 拖拽层必须把最右侧那组工具按钮让出来，否则按钮全被拖拽层吃掉（点了没反应）。
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "scene3dChrome",
              let dict = message.body as? [String: Any],
              let preview = dict["preview"] as? Bool else { return }
        let apply: () -> Void = { [weak self] in
            guard let self = self else { return }
            self.dragView?.previewOverlayActive = preview
        }
        if Thread.isMainThread {
            apply()
        } else {
            DispatchQueue.main.async(execute: apply)
        }
    }

    // MARK: - WKUIDelegate

    /// 网页 <input type="file">（3D 窗口输入框的附件按钮）弹出系统文件选择面板。
    /// 与 MainWindowController 同一套实现；不实现此方法时 input.click() 静默无响应。
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
