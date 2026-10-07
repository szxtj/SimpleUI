import Cocoa

// 菜单栏状态图标（单图标、无状态变化）
//
//  - 单击 / 右键行为一致：statusItem.menu 赋值后两种点击天然打开同一个菜单；
//  - 菜单内容：三项受管服务状态（基础模型 / 知识库 / 语音识别，**始终显示**，
//    统一三态：绿「就绪」/ 红「离线」/ 黄「启动中」，与主界面左下角逐字一致）、
//    打开主界面、打开小窗口、退出并停止所有服务；
//  - 状态来源与前端同源：proxy 的 /api/wiki/status 与 /api/model/status，
//    每 5s 轮询 + 菜单打开时立即刷新（异步回调直接改标题，菜单打开期间也会实时更新）；
//  - 中英文适配跟随系统首选语言（zh* → 中文，其余 → 英文），与前端 language=system 的默认行为一致；
//  - 「最靠左侧」：第三方状态项只能出现在系统项左侧的区域里，这里通过在状态栏
//    视图内重排自身按钮，把图标钉到所有第三方状态项的最左边（系统不提供公开 API）。
class StatusBarController: NSObject, NSMenuDelegate {
    var onOpenMainWindow: (() -> Void)?
    var onOpenSpotlight: (() -> Void)?

    private var statusItem: NSStatusItem?
    private var kbStatusItem: NSMenuItem!
    private var svcStatusItem: NSMenuItem!
    private var asrStatusItem: NSMenuItem!
    private var pollTimer: Timer?
    private var pinAttempts = 0

    // 服务当前开启状态（对应服务控制面板里的各服务开关）与防重点击锁
    private var kbEnabled = false
    private var modelEnabled = true
    private var asrEnabled = true
    private var kbBusy = false
    private var modelBusy = false
    private var asrBusy = false

    // 状态缓存（菜单打开前最后一次轮询的结果；异步刷新会直接改已显示的标题）
    private struct ServiceView {
        var dot: NSColor
        var text: String
    }

    // ----------------------------- 中英文 -----------------------------

    private let zh = Locale.preferredLanguages.first?.hasPrefix("zh") ?? false

    private var lblKB: String { zh ? "知识库" : "Knowledge Base" }
    private var lblSvc: String { zh ? "基础模型" : "Base Model" }
    private var lblAsr: String { zh ? "语音识别" : "Speech Recognition" }
    private var lblReady: String { zh ? "就绪" : "Ready" }
    private var lblOffline: String { zh ? "离线" : "Offline" }
    private var lblStarting: String { zh ? "启动中" : "Starting" }
    private var lblStopping: String { zh ? "停止中" : "Stopping" }
    private var lblOpenMain: String { zh ? "打开主界面" : "Open Main Window" }
    private var lblOpenSpotlight: String { zh ? "打开小窗口" : "Open Mini Window" }
    private var lblQuit: String { zh ? "退出并停止所有服务" : "Quit & Stop All Services" }

    private var tipKB: String { zh ? "点击开启或关闭知识库服务" : "Click to toggle Knowledge Base service" }
    private var tipSvc: String { zh ? "点击开启或关闭基础模型服务" : "Click to toggle Base Model service" }
    private var tipAsr: String { zh ? "点击开启或关闭语音识别服务" : "Click to toggle Speech Recognition service" }

    // ----------------------------- 生命周期 -----------------------------

    func setup() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = Self.makeIcon()
        item.button?.image?.isTemplate = true
        item.button?.toolTip = "SimpleUI"
        statusItem = item

        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false

        kbStatusItem = NSMenuItem(title: "", action: #selector(toggleKB), keyEquivalent: "")
        kbStatusItem.target = self
        kbStatusItem.isEnabled = true
        kbStatusItem.toolTip = tipKB
        menu.addItem(kbStatusItem)

        svcStatusItem = NSMenuItem(title: "", action: #selector(toggleModel), keyEquivalent: "")
        svcStatusItem.target = self
        svcStatusItem.isEnabled = true
        svcStatusItem.toolTip = tipSvc
        menu.addItem(svcStatusItem)

        asrStatusItem = NSMenuItem(title: "", action: #selector(toggleASR), keyEquivalent: "")
        asrStatusItem.target = self
        asrStatusItem.isEnabled = true
        asrStatusItem.toolTip = tipAsr
        menu.addItem(asrStatusItem)

        menu.addItem(NSMenuItem.separator())

        let openMain = NSMenuItem(title: lblOpenMain, action: #selector(openMainWindow), keyEquivalent: "")
        openMain.target = self
        menu.addItem(openMain)

        let openSpotlight = NSMenuItem(title: lblOpenSpotlight, action: #selector(openSpotlightWindow), keyEquivalent: "")
        openSpotlight.target = self
        menu.addItem(openSpotlight)

        menu.addItem(NSMenuItem.separator())

        let quit = NSMenuItem(title: lblQuit, action: #selector(quitAndStopAll), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)

        // 左键与右键都会打开这个菜单（行为一致）
        item.menu = menu

        refreshStatuses()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.refreshStatuses()
        }
        // 状态栏布局就绪后把图标钉到第三方状态项的最左侧（需要重试等待 superview 就绪）
        pinLeftmost()
    }

    func teardown() {
        pollTimer?.invalidate()
        pollTimer = nil
        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
        }
        statusItem = nil
    }

    // ----------------------------- 菜单动作 -----------------------------

    // ---- 快速启停受管服务（对齐设置页服务管理控制面板的开关逻辑） ----

    @objc private func toggleKB() {
        guard !kbBusy else { return }
        kbBusy = true
        let next = !kbEnabled
        kbEnabled = next

        let tempView = ServiceView(
            dot: .systemOrange,
            text: next ? lblStarting : lblStopping
        )
        kbStatusItem.attributedTitle = statusLine(label: lblKB, view: tempView)

        postJSON("/api/wiki/config", body: ["enabled": next]) { [weak self] in
            guard let self = self else { return }
            self.kbBusy = false
            self.refreshStatuses()
        }
    }

    @objc private func toggleModel() {
        guard !modelBusy else { return }
        modelBusy = true
        let next = !modelEnabled
        modelEnabled = next

        let tempView = ServiceView(
            dot: .systemOrange,
            text: next ? lblStarting : lblStopping
        )
        svcStatusItem.attributedTitle = statusLine(label: lblSvc, view: tempView)

        postJSON("/api/model/config", body: ["enabled": next]) { [weak self] in
            guard let self = self else { return }
            let action = next ? "start" : "stop"
            self.postJSON("/api/model/\(action)") { [weak self] in
                guard let self = self else { return }
                self.modelBusy = false
                self.refreshStatuses()
            }
        }
    }

    @objc private func toggleASR() {
        guard !asrBusy else { return }
        asrBusy = true
        let next = !asrEnabled
        asrEnabled = next

        let tempView = ServiceView(
            dot: .systemOrange,
            text: next ? lblStarting : lblStopping
        )
        asrStatusItem.attributedTitle = statusLine(label: lblAsr, view: tempView)

        postJSON("/api/asr/config", body: ["enabled": next]) { [weak self] in
            guard let self = self else { return }
            let action = next ? "start" : "stop"
            self.postJSON("/api/asr/\(action)") { [weak self] in
                guard let self = self else { return }
                self.asrBusy = false
                self.refreshStatuses()
            }
        }
    }

    @objc private func openMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        onOpenMainWindow?()
    }

    @objc private func openSpotlightWindow() {
        NSApp.activate(ignoringOtherApps: true)
        onOpenSpotlight?()
    }

    // 退出即停所有服务：NSApp.terminate → AppDelegate.applicationWillTerminate
    // → ProcessManager.stop()（SIGTERM 代理）→ 代理退出钩子再终止 kiwix 与模型服务
    @objc private func quitAndStopAll() {
        NSApp.terminate(nil)
    }

    // NSMenuDelegate：菜单即将打开时立即刷新一次（轮询间隔内也能拿到最新状态）
    func menuWillOpen(_ menu: NSMenu) {
        refreshStatuses()
        pinLeftmost()
    }

    // ----------------------------- 状态获取与渲染 -----------------------------

    private func fetchJSON(_ path: String, completion: @escaping ([String: Any]?) -> Void) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)\(path)") else {
            completion(nil)
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2.0
        URLSession.shared.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            DispatchQueue.main.async { completion(obj) }
        }.resume()
    }

    private func postJSON(_ path: String, body: [String: Any]? = nil, completion: (() -> Void)? = nil) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)\(path)") else {
            completion?()
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15.0
        if let body = body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        URLSession.shared.dataTask(with: request) { _, _, _ in
            DispatchQueue.main.async {
                completion?()
            }
        }.resume()
    }

    /// 统一状态：与主界面左下角逐字一致。
    ///
    ///   绿灯「就绪」 / 红灯「离线」 / 黄灯「启动中」 / 黄灯「停止中」
    private func view(forStatus status: String?) -> ServiceView {
        switch status {
        case "running":
            return ServiceView(dot: .systemGreen, text: lblReady)
        // "start" / "restart" 是 pendingOp 的原始值（见 ttf_service/asr_service 的 getStatus）：
        // 启动动作进行中时 status 直接就是这两个词，漏掉会把「正在启动」误判成离线。
        case "loading", "starting", "start", "restart":
            return ServiceView(dot: .systemOrange, text: lblStarting)
        case "stopping", "stop":
            return ServiceView(dot: .systemOrange, text: lblStopping)
        default:
            // stopped 以及「接口不可达」：一律离线
            return ServiceView(dot: .systemRed, text: lblOffline)
        }
    }

    func refreshStatuses() {
        // 三项服务始终显示，状态同源同文案（与主界面左下角一致）
        fetchJSON("/api/wiki/status") { [weak self] json in
            guard let self = self else { return }
            if let enabled = json?["enabled"] as? Bool {
                self.kbEnabled = enabled
            }
            if !self.kbBusy {
                let view = self.view(forStatus: json?["status"] as? String)
                self.kbStatusItem.attributedTitle = self.statusLine(label: self.lblKB, view: view)
            }
        }

        fetchJSON("/api/model/status") { [weak self] json in
            guard let self = self else { return }
            if let enabled = json?["enabled"] as? Bool {
                self.modelEnabled = enabled
            }
            if !self.modelBusy {
                let view = self.view(forStatus: json?["status"] as? String)
                self.svcStatusItem.attributedTitle = self.statusLine(label: self.lblSvc, view: view)
            }
        }

        fetchJSON("/api/asr/status") { [weak self] json in
            guard let self = self else { return }
            if let enabled = json?["enabled"] as? Bool {
                self.asrEnabled = enabled
            }
            if !self.asrBusy {
                let view = self.view(forStatus: json?["status"] as? String)
                self.asrStatusItem.attributedTitle = self.statusLine(label: self.lblAsr, view: view)
            }
        }
    }

    // 彩色圆点 + 「服务名 · 状态」，菜单项高亮与常规态均能自适应颜色
    private func statusLine(label: String, view: ServiceView) -> NSAttributedString {
        let dot = NSAttributedString(
            string: "● ",
            attributes: [.foregroundColor: view.dot, .font: NSFont.systemFont(ofSize: 11)]
        )
        let body = NSAttributedString(
            string: "\(label)  ·  \(view.text)",
            attributes: [
                .font: NSFont.menuFont(ofSize: 13),
            ]
        )
        let result = NSMutableAttributedString()
        result.append(dot)
        result.append(body)
        return result
    }

    // ----------------------------- 图标（取自 App 图标的线条母题） -----------------------------

    // 优先使用预生成的 StatusBarIcon.png（22x22pt 画布，由 StatusBarIcon.svg 光栅化而来——
    // SVG 为设计源文件，内含 14x17pt 位图区；不能直接用 NSImage 加载该 SVG，
    // AppKit 的 _NSSVGImageRep 不支持 pattern+dataURI 组合，渲染会裁错（已实测），
    // 改几何后需重新光栅化：按 SVG 矩形参数把内嵌位图重采样进 22pt 画布即可）。
    // 缺资源时退回程序化绘制的三环结近似形。
    private static func makeIcon() -> NSImage {
        if let url = Bundle.main.url(forResource: "StatusBarIcon", withExtension: "png"),
           let img = NSImage(contentsOf: url) {
            img.size = NSSize(width: 22, height: 22)
            img.isTemplate = true
            return img
        }
        return makeFallbackIcon()
    }

    // 兜底：三个带缺口的圆弧环（120° 旋转对称）近似 App 图标的结母题
    private static func makeFallbackIcon() -> NSImage {
        let scale: CGFloat = 4.0
        let side: CGFloat = 18.0
        let px = side * scale
        let image = NSImage(size: NSSize(width: px, height: px))
        image.lockFocus()

        guard let ctx = NSGraphicsContext.current?.cgContext else {
            image.unlockFocus()
            return image
        }
        ctx.scaleBy(x: scale, y: scale)

        let stroke = NSColor.black
        stroke.setStroke()

        // 三环：中心距 d、半径 r 的取值使整体包围盒精确居中于 18pt 画布
        let center = NSPoint(x: 9.0, y: 8.3)
        let d: CGFloat = 2.9
        let r: CGFloat = 4.4
        for angleDeg in [90.0, 210.0, 330.0] {
            let a = angleDeg * .pi / 180
            let cx = center.x + d * CGFloat(cos(a))
            let cy = center.y + d * CGFloat(sin(a))
            let ring = NSBezierPath()
            // 缺口朝外（60°），弧从 A+30° 逆时针画到 A+330°
            ring.appendArc(withCenter: NSPoint(x: cx, y: cy), radius: r,
                           startAngle: CGFloat(angleDeg) + 30, endAngle: CGFloat(angleDeg) + 330,
                           clockwise: false)
            ring.lineWidth = 1.7
            ring.lineCapStyle = .round
            ring.stroke()
        }

        image.unlockFocus()
        image.size = NSSize(width: side, height: side)
        image.isTemplate = true
        return image
    }

    // ----------------------------- 钉到最左侧 -----------------------------

    // 状态栏没有公开的排序 API。优先把自身按钮重新插入 arrangedSubviews 首位
    // （若状态栏容器是 NSStackView，由系统重新布局，帧与居中都正确）；
    // 否则退回「摘出再插到最前」的视图重排，并触发一次重布局。
    // superview 需要等状态栏完成布局才存在，故带重试；每次打开菜单也顺带再钉一次。
    private func pinLeftmost() {
        guard pinAttempts < 12, let button = statusItem?.button else { return }
        pinAttempts += 1
        guard let statusBar = button.superview else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.pinLeftmost()
            }
            return
        }
        if let stack = statusBar as? NSStackView {
            stack.removeArrangedSubview(button)
            button.removeFromSuperview()
            stack.insertArrangedSubview(button, at: 0)
            stack.needsLayout = true
            stack.layoutSubtreeIfNeeded()
        } else {
            button.removeFromSuperview()
            statusBar.addSubview(button, positioned: .above, relativeTo: nil)
            statusBar.needsLayout = true
        }
    }
}
