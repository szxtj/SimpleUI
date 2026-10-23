import Cocoa

// 菜单栏状态图标（单图标、无状态变化）
//
//  - 单击 / 右键行为一致：statusItem.menu 赋值后两种点击天然打开同一个菜单；
//  - 菜单内容：七项服务状态（知识库 / 基础模型 / 语音识别 / 语音合成 / 实时字幕 /
//    快速翻译 / 视觉图文识别，**始终显示**，顺序与服务管理面板的卡片顺序一致）、
//    打开主界面、打开小窗口、退出并停止所有服务；
//  - 前两项可点击启停（与面板开关等价）；后五项是纯按需服务，没有常驻开关，
//    故一律渲染成**不可点击**的状态行（isEnabled = false，无 action）；
//  - 状态文案与服务管理面板每张卡片右上角逐字一致（统一四态）：
//    绿「就绪 : 端口」/ 红「离线」/ 黄「启动中」/ 天蓝「待命」
//    （待命＝按需服务模型已就绪但未驻留内存，只有这类服务会出现）；
//  - 状态来源与前端同源：proxy 的 /api/{wiki,model,asr,subtitles,translate,tts,ocr}/status，
//    每 5s 轮询 + 菜单打开时立即刷新（异步回调直接改标题，菜单打开期间也会实时更新）；
//  - 中英文适配跟随系统首选语言（zh* → 中文，其余 → 英文），与前端 language=system 的默认行为一致；
//  - 「最靠左侧」：第三方状态项只能出现在系统项左侧的区域里，这里通过在状态栏
//    视图内重排自身按钮，把图标钉到所有第三方状态项的最左边（系统不提供公开 API）。
class StatusBarController: NSObject, NSMenuDelegate {
    var onOpenMainWindow: (() -> Void)?
    var onOpenSpotlight: (() -> Void)?
    var onToggleSubtitles: (() -> Void)?
    var onOpenTranslator: (() -> Void)?

    private var statusItem: NSStatusItem?
    private var kbStatusItem: NSMenuItem!
    private var svcStatusItem: NSMenuItem!
    private var asrStatusItem: NSMenuItem!
    private var ttsStatusItem: NSMenuItem!
    private var subtitlesStatusItem: NSMenuItem!
    private var translateStatusItem: NSMenuItem!
    private var ocrStatusItem: NSMenuItem!
    private var subtitleMenuItem: NSMenuItem!
    private var translatorMenuItem: NSMenuItem!
    private var pollTimer: Timer?
    private var pinAttempts = 0

    // 服务当前开启状态（对应服务控制面板里的各服务开关）与防重点击锁
    private var kbEnabled = false
    /// 面板的模型开关不是看配置旗，而是看「当前引擎是否活着」（isCurrentEngineActive）：
    /// enabled=true 但进程掉了时面板显示为关，点一下是「启动」。菜单照抄这个口径。
    private var modelActive = false
    private var kbBusy = false
    private var modelBusy = false
    /// 基础模型当前生效的引擎（/api/model/status 的 activeEngine）：
    /// 菜单里没有引擎选择器，启停就作用在「面板上当前选中的那一台」上，与面板开关等价
    private var modelEngine = "mference"

    // 状态缓存（菜单打开前最后一次轮询的结果；异步刷新会直接改已显示的标题）
    private struct ServiceView {
        var dot: NSColor
        var text: String
    }

    /// 统一四态，语义与前端 src/utils/serviceState.ts 完全一致：
    ///   online → 绿灯「就绪 : 端口」 / offline → 红灯「离线」 /
    ///   starting → 黄灯「启动中」 / standby → 天蓝灯「待命」
    private enum ServiceState {
        case online
        case offline
        case starting
        case standby
    }

    // 圆点颜色直接取服务管理面板的 Tailwind 色值，两处同色（系统语义色与面板不同色，
    // 例如 systemOrange 偏亮、systemRed 偏艳，肉眼看得出差别）
    private static let onlineDotColor = NSColor(
        srgbRed: 16.0 / 255.0, green: 185.0 / 255.0, blue: 129.0 / 255.0, alpha: 1.0
    )   // emerald-500
    private static let offlineDotColor = NSColor(
        srgbRed: 239.0 / 255.0, green: 68.0 / 255.0, blue: 68.0 / 255.0, alpha: 1.0
    )   // red-500
    private static let startingDotColor = NSColor(
        srgbRed: 245.0 / 255.0, green: 158.0 / 255.0, blue: 11.0 / 255.0, alpha: 1.0
    )   // amber-500
    private static let standbyDotColor = NSColor(
        srgbRed: 14.0 / 255.0, green: 165.0 / 255.0, blue: 233.0 / 255.0, alpha: 1.0
    )   // sky-500

    private var openMainItem: NSMenuItem?
    private var openSpotlightItem: NSMenuItem?
    private var quitItem: NSMenuItem?

    // ----------------------------- 中英文 -----------------------------

    private var zh: Bool { AppLocale.isZh }

    private var lblKB: String { zh ? "知识库" : "Knowledge Base" }
    private var lblSvc: String { zh ? "基础模型" : "Base Model" }
    private var lblAsr: String { zh ? "语音输入" : "Speech Input" }
    private var lblTts: String { zh ? "语音合成" : "Voice Synthesis" }
    private var lblSubtitlesSvc: String { zh ? "实时字幕" : "Live Subtitles" }
    private var lblTranslateSvc: String { zh ? "快速翻译" : "Quick Translate" }
    private var lblOcr: String { zh ? "视觉图文识别" : "Visual OCR" }
    private var lblReady: String { zh ? "就绪" : "Ready" }
    private var lblOffline: String { zh ? "离线" : "Offline" }
    private var lblStarting: String { zh ? "启动中" : "Starting" }
    private var lblStandby: String { zh ? "待命" : "Standby" }
    private var lblStopping: String { zh ? "停止中" : "Stopping" }
    private var lblOpenMain: String { zh ? "打开主界面" : "Open Main Window" }
    private var lblOpenSpotlight: String { zh ? "打开小窗口" : "Open Mini Window" }
    private var lblTranslator: String { zh ? "快捷翻译" : "Quick Translate" }
    private var lblSubtitles: String { zh ? "实时双语字幕" : "Live Subtitles" }
    private var lblQuit: String { zh ? "退出并停止所有服务" : "Quit & Stop All Services" }

    private var tipKB: String { zh ? "点击开启或关闭知识库服务" : "Click to toggle Knowledge Base service" }
    private var tipSvc: String { zh ? "点击开启或关闭基础模型服务" : "Click to toggle Base Model service" }
    // 以下五项为按需服务，没有常驻开关，只做状态展示
    private var tipAsr: String {
        zh ? "按需加载：长按语音输入快捷键时启动，闲置超时自动卸载" : "On demand: starts on Speech Input, unloads after idle timeout"
    }
    private var tipTts: String {
        zh ? "按需加载：点击朗读按钮时启动，合成结束即卸载" : "On demand: starts on Read Aloud, unloads after synthesis"
    }
    private var tipSubtitlesSvc: String {
        zh ? "按需加载：打开字幕悬浮窗时启动" : "On demand: starts when the subtitle overlay opens"
    }
    private var tipTranslateSvc: String {
        zh ? "按需加载：划选翻译时启动，闲置超时自动卸载" : "On demand: starts on selection translate, unloads after idle timeout"
    }
    private var tipOcr: String {
        zh ? "按需加载：截图识别时启动，闲置超时自动卸载" : "On demand: starts on capture, unloads after idle timeout"
    }
    private var tipTranslator: String { zh ? "唤起或隐藏快捷翻译面板 (⌃Space)" : "Toggle quick translation overlay (⌃Space)" }
    private var tipSubtitles: String { zh ? "开启或关闭实时双语字幕悬浮窗" : "Toggle live bilingual subtitle overlay" }

    // ---- 启停失败提示 ----
    // 菜单条目没有地方显示错误，静默失败会被当成「点了没反应」，所以点「开启」后回查一次并弹窗。
    // 三个服务的弹窗统一成「标题 = 服务名 + 没有启动」「正文 = 原因 + 提示」两段式，中英文逐项对应。
    private var lblKbStartFailed: String { zh ? "知识库没有启动" : "Knowledge Base Didn't Start" }
    private var lblModelStartFailed: String { zh ? "基础模型没有启动" : "Base Model Didn't Start" }
    private var lblAsrStartFailed: String { zh ? "语音识别没有启动" : "Speech Recognition Didn't Start" }
    private var lblReasonPrefix: String { zh ? "原因：" : "Reason: " }
    /// 后端日志是中文原文，英文界面下明确标注来源，避免"英文弹窗里突然出现一坨中文"
    private var lblBackendReasonPrefix: String { zh ? "原因（后端日志）：" : "Reason (backend log): " }
    private var lblHintPrefix: String { zh ? "提示：" : "Hint: " }
    private var msgNoReason: String { zh ? "后端没有返回具体原因。" : "The backend didn't return a reason." }
    private var msgKbNoZimReason: String { zh ? "还没有选择 .zim 文件。" : "No .zim file is selected." }
    private var hintKbNoZim: String {
        zh ? "请在「服务管理 → 知识库」里选择 .zim 文件后，再开启服务。"
            : "Choose a .zim file in Service Manager → Knowledge Base, then turn the service on again."
    }
    private var hintKbCheck: String {
        zh ? "请在「服务管理 → 知识库」里检查 ZIM 路径与端口后重试。"
            : "Check the ZIM path and port in Service Manager → Knowledge Base, then try again."
    }
    private var hintModelLog: String {
        zh ? "可在「服务管理 → 基础模型 → 运行日志」查看完整输出。"
            : "See Service Manager → Base Model → Service log for the full output."
    }
    private var hintAsrLog: String {
        zh ? "可在「服务管理 → 语音识别 → 运行日志」查看完整输出。"
            : "See Service Manager → Speech Recognition → Service log for the full output."
    }

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

        svcStatusItem = NSMenuItem(title: "", action: #selector(toggleModel), keyEquivalent: "")
        svcStatusItem.target = self
        svcStatusItem.isEnabled = true
        svcStatusItem.toolTip = tipSvc
        menu.addItem(svcStatusItem)

        kbStatusItem = NSMenuItem(title: "", action: #selector(toggleKB), keyEquivalent: "")
        kbStatusItem.target = self
        kbStatusItem.isEnabled = true
        kbStatusItem.toolTip = tipKB
        menu.addItem(kbStatusItem)

        // 以下五项是纯按需服务（没有常驻开关）：只显示状态，不可点击。
        // 顺序与服务管理面板的卡片顺序一致；autoenablesItems 已关，isEnabled = false 即可稳定置灰。
        asrStatusItem = passiveStatusItem(toolTip: tipAsr)
        menu.addItem(asrStatusItem)

        ttsStatusItem = passiveStatusItem(toolTip: tipTts)
        menu.addItem(ttsStatusItem)

        subtitlesStatusItem = passiveStatusItem(toolTip: tipSubtitlesSvc)
        menu.addItem(subtitlesStatusItem)

        translateStatusItem = passiveStatusItem(toolTip: tipTranslateSvc)
        menu.addItem(translateStatusItem)

        ocrStatusItem = passiveStatusItem(toolTip: tipOcr)
        menu.addItem(ocrStatusItem)

        menu.addItem(NSMenuItem.separator())

        let openMain = NSMenuItem(title: lblOpenMain, action: #selector(openMainWindow), keyEquivalent: "")
        openMain.target = self
        openMainItem = openMain
        menu.addItem(openMain)

        let openSpotlight = NSMenuItem(title: "\(lblOpenSpotlight)  (⌥Space)", action: #selector(openSpotlightWindow), keyEquivalent: "")
        openSpotlight.target = self
        openSpotlightItem = openSpotlight
        menu.addItem(openSpotlight)

        let openTranslator = NSMenuItem(title: "\(lblTranslator)  (⌃Space)", action: #selector(openTranslatorWindow), keyEquivalent: "")
        openTranslator.target = self
        openTranslator.toolTip = tipTranslator
        translatorMenuItem = openTranslator
        menu.addItem(openTranslator)

        let openSubtitles = NSMenuItem(title: lblSubtitles, action: #selector(toggleSubtitles), keyEquivalent: "")
        openSubtitles.target = self
        openSubtitles.toolTip = tipSubtitles
        subtitleMenuItem = openSubtitles
        menu.addItem(openSubtitles)

        menu.addItem(NSMenuItem.separator())

        let quit = NSMenuItem(title: lblQuit, action: #selector(quitAndStopAll), keyEquivalent: "")
        quit.target = self
        quitItem = quit
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

    /// 纯状态行：无 action、无 target，isEnabled=false —— 点击不会有任何动作（菜单只会收起）
    private func passiveStatusItem(toolTip: String?) -> NSMenuItem {
        let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        item.isEnabled = false
        item.toolTip = toolTip
        return item
    }

    func updateSubtitleActiveState(_ active: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.subtitleMenuItem?.state = active ? .on : .off
        }
    }

    func refreshMenuLanguage() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.kbStatusItem?.toolTip = self.tipKB
            self.svcStatusItem?.toolTip = self.tipSvc
            self.asrStatusItem?.toolTip = self.tipAsr
            self.ttsStatusItem?.toolTip = self.tipTts
            self.subtitlesStatusItem?.toolTip = self.tipSubtitlesSvc
            self.translateStatusItem?.toolTip = self.tipTranslateSvc
            self.ocrStatusItem?.toolTip = self.tipOcr
            self.openMainItem?.title = self.lblOpenMain
            self.openSpotlightItem?.title = "\(self.lblOpenSpotlight)  (⌥Space)"
            self.translatorMenuItem?.title = "\(self.lblTranslator)  (⌃Space)"
            self.translatorMenuItem?.toolTip = self.tipTranslator
            self.subtitleMenuItem?.title = self.lblSubtitles
            self.subtitleMenuItem?.toolTip = self.tipSubtitles
            self.quitItem?.title = self.lblQuit
            self.refreshStatuses()
        }
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

    // 知识库：与面板 handleToggleWikiService 完全一致 —— 只 POST /api/wiki/config { enabled }
    // （后端开=拉起 kiwix、关=杀进程，没有独立的 start/stop 端点）
    @objc private func toggleKB() {
        guard !kbBusy else { return }
        kbBusy = true
        let next = !kbEnabled
        kbEnabled = next

        let tempView = ServiceView(
            dot: Self.startingDotColor,
            text: next ? lblStarting : lblStopping
        )
        kbStatusItem.attributedTitle = statusLine(label: lblKB, view: tempView)

        postJSON("/api/wiki/config", body: ["enabled": next]) { [weak self] in
            guard let self = self else { return }
            self.kbBusy = false
            self.refreshStatuses()
            if next { self.confirmStart(.kb) }
        }
    }

    // 基础模型：与面板 handleEngineToggle 完全一致 ——
    //   ① 先写「该引擎的 *Enabled + 切到该引擎」，② 再 start/stop 并带上 engine。
    // 只写 { enabled } 是错的：status 的 enabled 是按当前引擎的 ttfEnabled/mferenceEnabled 算出来的，
    // 写总开关不会改这两面旗，于是状态立刻回弹、看起来「点了没反应」。
    @objc private func toggleModel() {
        guard !modelBusy else { return }
        modelBusy = true
        let next = !modelActive
        modelActive = next
        let engine = modelEngine
        let config: [String: Any] = [
            "engine": engine,
            engine == "mference" ? "mferenceEnabled" : "ttfEnabled": next,
        ]

        let tempView = ServiceView(
            dot: Self.startingDotColor,
            text: next ? lblStarting : lblStopping
        )
        svcStatusItem.attributedTitle = statusLine(label: lblSvc, view: tempView)

        postJSON("/api/model/config", body: config) { [weak self] in
            guard let self = self else { return }
            let action = next ? "start" : "stop"
            self.postJSON("/api/model/\(action)", body: ["engine": engine]) { [weak self] in
                guard let self = self else { return }
                self.modelBusy = false
                self.refreshStatuses()
                if next { self.confirmStart(.model) }
            }
        }
    }

    // ----------------------------- 启动失败回查 -----------------------------

    private enum ServiceKind {
        case kb
        case model
    }

    /// 点「开启」后 1.2s 回查一次：仍处于离线就把原因弹出来，
    /// 否则用户看到的就是「点了没反应」（例如模型本体在未挂载的外置盘上、知识库还没选 ZIM）。
    private func confirmStart(_ kind: ServiceKind) {
        let path: String
        switch kind {
        case .kb: path = "/api/wiki/status"
        case .model: path = "/api/model/status"
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self = self else { return }
            self.fetchJSON(path) { [weak self] json in
                guard let self = self else { return }
                switch kind {
                case .kb:
                    let running = (json?["status"] as? String) == "running"
                    if !running {
                        let hasZim = !(((json?["zimPath"] as? String) ?? "").isEmpty)
                        self.showAlert(
                            title: self.lblKbStartFailed,
                            message: self.startFailureBody(
                                reason: hasZim ? self.msgNoReason : self.msgKbNoZimReason,
                                hint: hasZim ? self.hintKbCheck : self.hintKbNoZim
                            )
                        )
                    }
                case .model:
                    if self.state(forStatus: json?["status"] as? String) == .offline {
                        let reason = (json?["lastActionLog"] as? String) ?? self.msgNoReason
                        self.showAlert(
                            title: self.lblModelStartFailed,
                            message: self.startFailureBody(
                                reason: reason,
                                hint: self.hintModelLog,
                                fromBackendLog: true
                            )
                        )
                    }
                }
            }
        }
    }

    /// 统一的「原因 + 提示」两段式正文；reason 来自后端日志时换用带出处的标签
    private func startFailureBody(reason: String, hint: String, fromBackendLog: Bool = false) -> String {
        let prefix = fromBackendLog ? lblBackendReasonPrefix : lblReasonPrefix
        return "\(prefix)\(reason)\n\n\(lblHintPrefix)\(hint)"
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: zh ? "好" : "OK")
        // 不调用 NSApp.activate：用户可能正在别处输入，弹窗只作为浮动窗口出现，不切到主界面/不抢前台
        alert.window.level = .floating
        alert.window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        alert.runModal()
    }

    @objc private func openMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        onOpenMainWindow?()
    }

    @objc private func openSpotlightWindow() {
        onOpenSpotlight?()
    }

    @objc private func openTranslatorWindow() {
        onOpenTranslator?()
    }

    @objc private func toggleSubtitles() {
        onToggleSubtitles?()
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

    /// 统一状态：与服务管理面板每张卡片右上角逐字一致。
    ///
    ///   绿灯「就绪 : 端口」 / 红灯「离线」 / 黄灯「启动中」 / 天蓝灯「待命」
    ///   （端口只在 online 时追加：面板的写法就是 `就绪 : 1255`，其余状态没有冒号段）
    private func view(for state: ServiceState, port: String? = nil) -> ServiceView {
        switch state {
        case .online:
            return ServiceView(dot: Self.onlineDotColor, text: port.map { "\(lblReady) : \($0)" } ?? lblReady)
        case .starting:
            return ServiceView(dot: Self.startingDotColor, text: lblStarting)
        case .standby:
            return ServiceView(dot: Self.standbyDotColor, text: lblStandby)
        case .offline:
            return ServiceView(dot: Self.offlineDotColor, text: lblOffline)
        }
    }

    /// 六个服务共用的状态判定（每一档的判据都取自面板卡片右上角的原始逻辑）。
    ///
    /// 优先级自上而下，任意服务只提供自己接口里有的字段，其余保持默认值：
    ///   ① loading 标志 / status ∈ {loading, starting, start, restart} → 启动中
    ///   ② status == standby                                          → 待命
    ///   ③ status ∈ {running, ready} / running 或 paused 标志          → 就绪
    ///   ④ loaded（模型齐备但未驻留）                                   → 待命
    ///   ⑤ 其余（stopped / incomplete / 接口不可达）                    → 离线
    ///
    /// 说明：
    ///  - "start" / "restart" 是 pendingOp 的原始值（见 ttf_service / asr_service 的 getStatus），
    ///    启动动作进行中时 status 就是这两个词，漏掉会把「正在启动」误判成离线；
    ///  - 待命排在就绪之前只在 status 层生效（status='standby' 且 running=true 不可能同时出现，
    ///    tts/ocr 的 getStatus 里 running 为真时 status 一定是 ready）；
    ///  - 字幕没有 status 字段，全靠 loading / running / paused / allReady 四个布尔，
    ///    传空 status 后自然落到 ①③④⑤ 四档，与面板字幕卡片一一对应。
    private func state(
        forStatus status: String? = nil,
        running: Bool = false,
        loading: Bool = false,
        loaded: Bool = false,
        paused: Bool = false
    ) -> ServiceState {
        if loading {
            return .starting
        }
        switch status {
        case "loading", "starting", "start", "restart":
            return .starting
        case "standby":
            return .standby
        case "running", "ready":
            return .online
        default:
            break
        }
        // 字幕暂停只是停掉"收听"（abort ASR session、清定时器），模型与子进程、端口都还在，
        // 所以暂停算「就绪」而不是「待命」（见 subtitle_service.pause()：不调 stopServers）。
        if running || paused {
            return .online
        }
        if loaded {
            return .standby
        }
        return .offline
    }

    /// 端口字段。JSONSerialization 一般给 NSNumber，但历史/手改配置里出现过字符串形态
    /// （面板 ASR 卡片就有 `String(port).replace(/^:/, '')` 这层容错），这里一并接受。
    private func portValue(_ json: [String: Any]?, _ key: String) -> Int? {
        if let number = json?[key] as? NSNumber {
            return number.intValue
        }
        if let text = json?[key] as? String {
            return Int(text.trimmingCharacters(in: CharacterSet(charactersIn: ":")))
        }
        return nil
    }

    func refreshStatuses() {
        // 六项服务始终显示，调用同一个 state(forStatus:running:loading:loaded:paused:)
        fetchJSON("/api/wiki/status") { [weak self] json in
            guard let self = self else { return }
            if let enabled = json?["enabled"] as? Bool {
                self.kbEnabled = enabled
            }
            if !self.kbBusy {
                let state = self.state(forStatus: json?["status"] as? String)
                let port = self.portValue(json, "port").map { String($0) }
                self.kbStatusItem.attributedTitle = self.statusLine(label: self.lblKB, view: self.view(for: state, port: port))
            }
        }

        fetchJSON("/api/model/status") { [weak self] json in
            guard let self = self else { return }
            if let engine = json?["activeEngine"] as? String {
                self.modelEngine = engine
            }
            if !self.modelBusy {
                let state = self.state(forStatus: json?["status"] as? String)
                self.modelActive = state != .offline
                let port = self.portValue(json, "port").map { String($0) }
                self.svcStatusItem.attributedTitle = self.statusLine(label: self.lblSvc, view: self.view(for: state, port: port))
            }
        }

        // 语音输入（status: incomplete | loading | standby | ready，纯按需待命，另有 running / model.ready）
        fetchJSON("/api/asr/status") { [weak self] json in
            guard let self = self else { return }
            let state = self.state(
                forStatus: json?["status"] as? String,
                running: json?["running"] as? Bool ?? false,
                loaded: (json?["model"] as? [String: Any])?["ready"] as? Bool ?? (json?["modelsReady"] as? Bool ?? false)
            )
            let port = self.portValue(json, "port").map { String($0) }
            self.asrStatusItem.attributedTitle = self.statusLine(label: self.lblAsr, view: self.view(for: state, port: port))
        }

        // 语音合成（status: incomplete | loading | standby | ready，另有 running / model.ready）
        fetchJSON("/api/tts/status") { [weak self] json in
            guard let self = self else { return }
            let state = self.state(
                forStatus: json?["status"] as? String,
                running: json?["running"] as? Bool ?? false,
                loaded: (json?["model"] as? [String: Any])?["ready"] as? Bool ?? false
            )
            let port = self.portValue(json, "port").map { String($0) }
            self.ttsStatusItem.attributedTitle = self.statusLine(label: self.lblTts, view: self.view(for: state, port: port))
        }

        // 实时字幕（没有 status 字段：loading / running / paused / allReady，在线端口写 ASR/翻译）
        fetchJSON("/api/subtitles/status") { [weak self] json in
            guard let self = self else { return }
            let state = self.state(
                running: json?["running"] as? Bool ?? false,
                loading: json?["loading"] as? Bool ?? false,
                loaded: json?["allReady"] as? Bool ?? false,
                paused: json?["paused"] as? Bool ?? false
            )
            let asrPort = self.portValue(json, "asrPort")
            let port = self.portValue(json, "port")
            let portText: String? = {
                guard let port = port else { return nil }
                return asrPort.map { "\($0)/\(port)" } ?? String(port)
            }()
            self.subtitlesStatusItem.attributedTitle = self.statusLine(label: self.lblSubtitlesSvc, view: self.view(for: state, port: portText))
        }

        // 快速翻译（端侧翻译小模型：进程存活 = 就绪，模型齐备但未驻留 = 待命）
        fetchJSON("/api/translate/status") { [weak self] json in
            guard let self = self else { return }
            let quick = json?["quick"] as? [String: Any]
            let state = self.state(
                running: quick?["serverReady"] as? Bool ?? false,
                loading: quick?["starting"] as? Bool ?? false,
                loaded: quick?["modelReady"] as? Bool ?? false
            )
            let port = self.portValue(quick, "port").map { String($0) }
            self.translateStatusItem.attributedTitle = self.statusLine(label: self.lblTranslateSvc, view: self.view(for: state, port: port))
        }

        // 视觉图文识别（与 tts 同构：status + running + model.ready）
        fetchJSON("/api/ocr/status") { [weak self] json in
            guard let self = self else { return }
            let state = self.state(
                forStatus: json?["status"] as? String,
                running: json?["running"] as? Bool ?? false,
                loaded: (json?["model"] as? [String: Any])?["ready"] as? Bool ?? false
            )
            let port = self.portValue(json, "port").map { String($0) }
            self.ocrStatusItem.attributedTitle = self.statusLine(label: self.lblOcr, view: self.view(for: state, port: port))
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
