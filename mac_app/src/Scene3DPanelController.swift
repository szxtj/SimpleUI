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

final class Scene3DPanelController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private static let defaultWidth: CGFloat = 1180
    private static let defaultHeight: CGFloat = 760
    private static let minWidth: CGFloat = 860
    private static let minHeight: CGFloat = 560

    private var panel: Scene3DWindow?
    private var webView: WKWebView?
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
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        p.title = AppLocale.isZh ? "3D 场景构建" : "3D Scene Builder"
        p.minSize = NSSize(width: Self.minWidth, height: Self.minHeight)
        p.isReleasedWhenClosed = false
        p.isRestorable = false
        p.hidesOnDeactivate = false
        p.animationBehavior = .utilityWindow
        p.delegate = self

        let config = WKWebViewConfiguration()
        _ = makeWebView(in: p, config: config)
        return p
    }

    private func makeWebView(in panel: Scene3DWindow, config: WKWebViewConfiguration) -> WKWebView {
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
