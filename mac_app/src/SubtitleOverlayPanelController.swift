import Cocoa
import WebKit
import ScreenCaptureKit
import CoreMedia
import AVFoundation

/// 实时双语字幕悬浮面板：**不可成为 key、不抢夺焦点**。
/// 浮在所有 App（视频播放器、Zoom、浏览器）之上，不抢夺用户的光标焦点。
class SubtitleOverlayPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// 屏幕底部半透明双语字幕面板控制器。
/// 承载 `http://127.0.0.1:31235/#/subtitles`。
/// 特性：
/// 1. 窗体高度按行数档位（2+2、3+3、4+4...）与当前字号严格量化吸附，确保原文与译文行数始终一致，绝不留多余空白；
/// 2. 最大宽度锁死为当前所在屏幕宽度，最大高度锁死为当前所在屏幕高度的 2/3，最小宽度 520px，最小高度为当前字号下容纳 2+2 行的高度；
/// 3. ScreenCaptureKit 音频流无门控连续输送（仅在完全静音超时后休眠），消除轻音或句首漏字。
class SubtitleOverlayPanelController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate, SCStreamOutput {
    private static let defaultPanelWidth: CGFloat = 780
    private static let minPanelWidth: CGFloat = 520
    private static let bottomInset: CGFloat = 48

    private var webView: WKWebView!
    private var webReady = false
    /// 关窗卸载的核对批次号：每次开/关窗自增，旧的核对链看到编号变了就自行放弃，
    /// 避免「关→立刻开」时上一次的补发 /stop 把刚加载起来的新会话杀掉。
    private var stopVerifyToken = 0
    private static let maxStopAttempts = 3
    var onVisibilityChanged: ((Bool) -> Void)?

    // MARK: - 量化行数（2+2、3+3、4+4...）与排版高度自适应状态
    // 默认中号字体：顶部栏 38 + 上下内边距 22 + 间距 8 = 68；单对行高 = 26(英) + 28(中) = 54；2+2 行 = 176
    private var chromeHeight: CGFloat = 68
    private var pairHeight: CGFloat = 54
    private var currentLinePairs: Int = 2
    private var dragRawHeight: CGFloat = 176

    // MARK: - 系统音频 160ms 无门控连续流式内录状态
    private var scStream: SCStream?
    private var isRecording = false
    private let audioQueue = DispatchQueue(label: "com.simpleui.systemAudioCapture", qos: .userInitiated)
    private var samplesLock = NSLock()

    // 160ms @ 16kHz = 2560 采样点
    private let chunkSamples = 2560
    private var pendingSamples: [Int16] = []
    // 无 VAD、无静音门控：所有 PCM 都进入 FIFO。队列有上限，溢出直接 fatal。
    private let maxOutboundBatches = 64
    private var outboundQueue: [[Int16]] = []
    private var isSendingFrame = false

    var isVisible: Bool {
        return window?.isVisible ?? false
    }

    init() {
        let initialHeight: CGFloat = 176
        let panel = SubtitleOverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.defaultPanelWidth, height: initialHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.minSize = NSSize(width: Self.minPanelWidth, height: 110)
        panel.maxSize = NSSize(width: 4096, height: 2160)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isMovableByWindowBackground = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isOpaque = false
        panel.ignoresMouseEvents = false
        panel.hidesOnDeactivate = false
        panel.animationBehavior = .utilityWindow

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
        userContent.add(self, name: "subtitleOverlay")
        config.userContentController = userContent

        webView = WKWebView(frame: panel.contentView?.bounds ?? .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        panel.contentView?.wantsLayer = true
        panel.contentView?.layer?.backgroundColor = NSColor.clear.cgColor

        // 液态玻璃底：先垫一层原生材质，再把透明的 webView 盖上去。
        // CSS 的 backdrop-filter 只能采到「页面内部」的内容；本页面整体透明、
        // 面板又浮在别的 App 之上，所以真正的模糊/折射必须由原生材质提供。
        panel.contentView?.addSubview(makeGlassBackground(in: panel.contentView))
        panel.contentView?.addSubview(webView)
    }

    /// macOS 26+ 用系统 Liquid Glass（NSGlassEffectView），更早的系统退回
    /// NSVisualEffectView 的 .hudWindow 材质 —— 两者都是 .behindWindow 混合，
    /// 会真实采样面板后面的视频画面。
    private func makeGlassBackground(in container: NSView?) -> NSView {
        let radius: CGFloat = 16
        let bounds = container?.bounds ?? .zero

        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            // .clear 是给「压在媒体内容上」的档位：比 .regular 透得多，
            // 底下正在播的视频能透上来，白字靠页面上那层薄 scrim 保住对比。
            glass.style = .clear
            glass.cornerRadius = radius
            glass.frame = bounds
            glass.autoresizingMask = [.width, .height]
            return glass
        }

        let fx = NSVisualEffectView()
        fx.material = .hudWindow
        fx.blendingMode = .behindWindow
        fx.state = .active
        fx.frame = bounds
        fx.autoresizingMask = [.width, .height]
        fx.wantsLayer = true
        fx.layer?.cornerRadius = radius
        fx.layer?.masksToBounds = true
        return fx
    }

    func loadContent() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/#/subtitles") else { return }
        webView.load(URLRequest(url: url))
    }

    // MARK: - 屏幕边界与 2+2 / 3+3 / 4+4 量化尺寸计算

    private func activeScreen() -> NSScreen {
        if let panel = window, let s = panel.screen {
            return s
        }
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { NSPointInRect(mouse, $0.frame) }) ?? NSScreen.main ?? NSScreen.screens[0]
    }

    /// 计算当前所在屏幕允许的最大行数档位（锁死最大高度 <= 当前屏幕高度的 2/3，最小行数档位 = 2 即 2+2 行）
    private func maxAllowedLinePairs(on screen: NSScreen) -> Int {
        let maxScreenH = floor(screen.frame.height * (2.0 / 3.0))
        let safePairH = max(20.0, pairHeight)
        let maxPairs = Int(floor((maxScreenH - chromeHeight) / safePairH))
        return max(2, maxPairs)
    }

    /// 计算指定行数档位 N 对应的精确窗口像素高度
    private func exactHeightForLinePairs(_ pairs: Int, on screen: NSScreen) -> (clampedPairs: Int, height: CGFloat) {
        let maxPairs = maxAllowedLinePairs(on: screen)
        let clamped = max(2, min(maxPairs, pairs))
        let h = round(chromeHeight + CGFloat(clamped) * pairHeight)
        return (clamped, h)
    }

    /// 将当前行数档位同步通知前端，确保原文与译文始终渲染完全一致的 N+N 行
    private func notifyFrontendLinePairs(_ pairs: Int) {
        webView.evaluateJavaScript("window.onSubtitleLinePairsChanged && window.onSubtitleLinePairsChanged(\(pairs))") { _, _ in }
    }

    private func bottomCenterFrame(on screen: NSScreen) -> NSRect {
        let v = screen.visibleFrame
        let maxW = v.width
        let w = min(max(Self.minPanelWidth, Self.defaultPanelWidth), maxW)
        let (clampedPairs, h) = exactHeightForLinePairs(currentLinePairs, on: screen)
        currentLinePairs = clampedPairs
        dragRawHeight = h
        let x = v.origin.x + (v.width - w) / 2
        let y = v.origin.y + Self.bottomInset
        return NSRect(x: x, y: y, width: w, height: h)
    }

    /// 根据当前字号排版参数与档位，自适应调整窗体尺寸并严格限制在当前屏幕范围内
    private func applyQuantizedFrame(targetPairs: Int, customWidth: CGFloat? = nil, anchorTop: Bool = false, animate: Bool = false) {
        guard let panel = window else { return }
        let screen = activeScreen()
        let sFrame = screen.frame
        let maxW = sFrame.width
        let minW = min(Self.minPanelWidth, maxW)

        let (clampedPairs, snappedH) = exactHeightForLinePairs(targetPairs, on: screen)
        currentLinePairs = clampedPairs

        let (minPairs, minH) = exactHeightForLinePairs(2, on: screen)
        _ = minPairs
        let (_, maxH) = exactHeightForLinePairs(maxAllowedLinePairs(on: screen), on: screen)
        panel.minSize = NSSize(width: minW, height: minH)
        panel.maxSize = NSSize(width: maxW, height: max(minH, maxH))

        var frame = panel.frame
        let topY = frame.origin.y + frame.size.height
        let newW = max(minW, min(maxW, customWidth ?? frame.size.width))
        let newH = snappedH

        frame.size.width = newW
        frame.size.height = newH
        if anchorTop {
            frame.origin.y = topY - newH
        }

        // 确保窗口水平方向不超出当前屏幕边界
        if frame.origin.x + newW > sFrame.maxX {
            frame.origin.x = max(sFrame.minX, sFrame.maxX - newW)
        }
        if frame.origin.x < sFrame.minX {
            frame.origin.x = sFrame.minX
        }
        // 确保窗口垂直方向不超出当前屏幕上下边界
        if frame.origin.y < sFrame.minY {
            frame.origin.y = sFrame.minY
        }
        if frame.origin.y + newH > sFrame.maxY {
            frame.origin.y = max(sFrame.minY, sFrame.maxY - newH)
        }

        panel.setFrame(frame, display: true, animate: animate)
        notifyFrontendLinePairs(clampedPairs)
    }

    func show() {
        guard let panel = window else { return }
        // 作废上一次关窗遗留的卸载核对（它可能正打算补发 /stop）
        stopVerifyToken &+= 1
        if !webReady {
            loadContent()
        }
        let screen = activeScreen()
        if !isVisible {
            currentLinePairs = 2
            panel.setFrame(bottomCenterFrame(on: screen), display: true)
        } else {
            applyQuantizedFrame(targetPairs: currentLinePairs, animate: false)
        }
        panel.orderFrontRegardless()
        onVisibilityChanged?(true)
        // 通知前端清空上一轮历史记录并同步当前行数档位
        webView.evaluateJavaScript("window.onSubtitleOverlayShown && window.onSubtitleOverlayShown(\(currentLinePairs))") { _, _ in }
        postControl(action: "start")
    }

    func hide() {
        stopAudioCapture()
        requestServiceStop()
        window?.orderOut(nil)
        onVisibilityChanged?(false)
    }

    func toggle() {
        if isVisible {
            hide()
        } else {
            show()
        }
    }

    // MARK: - 系统音频内录 (ScreenCaptureKit 无门控连续流)

    func startAudioCapture() {
        guard !isRecording, isVisible else { return }
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else {
                    self.notifyFatal(stage: "capture", code: "NO_DISPLAY", message: "未找到活动显示器")
                    return
                }
                let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                config.excludesCurrentProcessAudio = true
                config.sampleRate = 16000
                config.channelCount = 1
                config.width = 2
                config.height = 2
                config.minimumFrameInterval = CMTime(value: 60, timescale: 1)

                let stream = SCStream(filter: filter, configuration: config, delegate: nil)
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: audioQueue)
                try await stream.startCapture()

                self.audioQueue.async {
                    self.samplesLock.lock()
                    self.pendingSamples.removeAll()
                    self.outboundQueue.removeAll()
                    self.isSendingFrame = false
                    self.samplesLock.unlock()
                }

                self.scStream = stream
                self.isRecording = true
                NSLog("[SubtitleOverlay] ✅ 系统音频 160ms 无门控连续内录已启动")
            } catch {
                self.notifyFatal(stage: "capture", code: "CAPTURE_START_FAILED", message: "启动系统音频内录失败: \(error.localizedDescription)")
            }
        }
    }

    func stopAudioCapture() {
        guard isRecording else { return }
        isRecording = false
        self.audioQueue.async {
            self.samplesLock.lock()
            self.pendingSamples.removeAll()
            self.outboundQueue.removeAll()
            self.isSendingFrame = false
            self.samplesLock.unlock()
        }
        if let stream = scStream {
            scStream = nil
            Task {
                try? await stream.stopCapture()
                NSLog("[SubtitleOverlay] ⏹ 系统音频内录已停止")
            }
        }
    }

    // SCStreamOutput: 无门控连续流式推送系统内部音频，杜绝吞字与漏字
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, isRecording else { return }
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let totalLength = CMBlockBufferGetDataLength(blockBuffer)
        guard totalLength > 0 else { return }

        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return }

        var dataPointer: UnsafeMutablePointer<Int8>?
        var actualLength = 0
        CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &actualLength, dataPointerOut: &dataPointer)
        guard let ptr = dataPointer, actualLength > 0 else {
            notifyFatal(stage: "capture", code: "AUDIO_BUFFER_EMPTY", message: "系统音频缓冲区为空")
            return
        }

        let isFloat = (asbd.pointee.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let bitsPerChannel = Int(asbd.pointee.mBitsPerChannel)

        var samples: [Int16] = []
        if isFloat && bitsPerChannel == 32 {
            let floatPtr = UnsafeRawPointer(ptr).bindMemory(to: Float32.self, capacity: actualLength / 4)
            let count = actualLength / 4
            samples.reserveCapacity(count)
            for i in 0..<count {
                let clamped = max(-1.0, min(1.0, floatPtr[i]))
                samples.append(Int16(clamped * 32767.0))
            }
        } else if !isFloat && bitsPerChannel == 16 {
            let int16Ptr = UnsafeRawPointer(ptr).bindMemory(to: Int16.self, capacity: actualLength / 2)
            let count = actualLength / 2
            samples.reserveCapacity(count)
            for i in 0..<count {
                samples.append(int16Ptr[i])
            }
        }

        guard !samples.isEmpty else {
            notifyFatal(stage: "capture", code: "AUDIO_FORMAT_UNSUPPORTED", message: "系统音频格式不受支持")
            return
        }

        samplesLock.lock()
        pendingSamples.append(contentsOf: samples)

        while pendingSamples.count >= chunkSamples {
            let slice = Array(pendingSamples.prefix(chunkSamples))
            pendingSamples.removeFirst(chunkSamples)
            outboundQueue.append(slice)
        }
        let overflow = outboundQueue.count > maxOutboundBatches
        samplesLock.unlock()

        if overflow {
            notifyFatal(stage: "capture", code: "CAPTURE_BACKLOG", message: "系统音频发送队列积压超过上限")
            return
        }
        drainOutboundQueue()
    }

    private func drainOutboundQueue() {
        samplesLock.lock()
        if isSendingFrame || outboundQueue.isEmpty {
            samplesLock.unlock()
            return
        }
        isSendingFrame = true

        // 合并队列中待发的最多 4 个 160ms 切片（640ms），既保证实时性，又避免 HTTP 排队。
        let batchCount = min(4, outboundQueue.count)
        var combinedSamples: [Int16] = []
        combinedSamples.reserveCapacity(batchCount * chunkSamples)
        for _ in 0..<batchCount {
            combinedSamples.append(contentsOf: outboundQueue.removeFirst())
        }
        samplesLock.unlock()

        var rawData = Data(capacity: combinedSamples.count * 2)
        combinedSamples.withUnsafeBytes { raw in
            rawData.append(contentsOf: raw)
        }

        let endpoint = "\(ProcessManager.baseURLString)/api/subtitles/feed?format=pcm"
        guard let url = URL(string: endpoint) else {
            samplesLock.lock()
            isSendingFrame = false
            samplesLock.unlock()
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.httpBody = rawData
        req.timeoutInterval = 5.0

        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            guard let self = self else { return }
            self.samplesLock.lock()
            self.isSendingFrame = false
            self.samplesLock.unlock()
            if let error = error {
                self.notifyFatal(stage: "feed", code: "FEED_REQUEST_FAILED", message: "音频上传失败: \(error.localizedDescription)")
                return
            }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                self.notifyFatal(stage: "feed", code: "FEED_HTTP_ERROR", message: "音频上传返回 HTTP \(code)")
                return
            }
            if let data = data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               (obj["ok"] as? Bool) != true {
                self.notifyFatal(stage: "feed", code: "FEED_REJECTED", message: "字幕服务拒绝音频帧")
                return
            }
            self.drainOutboundQueue()
        }.resume()
    }

    private func notifyFatal(stage: String, code: String, message: String) {
        NSLog("[SubtitleOverlay] ❌ FATAL \(stage)/\(code): \(message)")
        stopAudioCapture()
        let payload: [String: Any] = ["stage": stage, "code": code, "message": message]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript("window.onSubtitleFatalError && window.onSubtitleFatalError(\(json))")
        }
    }

    private func postControl(action: String) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/subtitles/\(action)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
    }

    // MARK: - 关窗卸载的确认与补发

    /// `postControl` 是 fire-and-forget：请求若丢失（代理正好在重启、端口瞬断），
    /// R2T2（2.3 GB）与 Index-Translate（1.3 GB）会一直驻留内存直到退出 App。
    /// 所以关窗后主动核对一次服务状态，确认仍有进程/模型在跑就重发，最多 3 次；
    /// 代理不可达时不再重试 —— 退出路径的 `forceSweepResidualProcesses()` 会兜底清进程。
    private func requestServiceStop() {
        stopVerifyToken &+= 1
        let token = stopVerifyToken
        postControl(action: "stop")
        verifyServiceStopped(token: token, sent: 1)
    }

    private func verifyServiceStopped(token: Int, sent: Int) {
        guard sent <= Self.maxStopAttempts else { return }
        let delay: TimeInterval = sent == 1 ? 0.5 : 1.0
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.stopVerifyToken == token, !self.isVisible else { return }
            self.fetchSubtitlesRunState { stillActive, reachable in
                guard reachable, self.stopVerifyToken == token, !self.isVisible else { return }
                guard stillActive else {
                    NSLog("[SubtitleOverlay] ✅ 字幕服务已确认卸载（第 \(sent) 次 stop）")
                    return
                }
                guard sent < Self.maxStopAttempts else {
                    NSLog("[SubtitleOverlay] ⚠️ 连续 \(sent) 次 stop 后服务仍在运行，交由退出清扫兜底")
                    return
                }
                NSLog("[SubtitleOverlay] ⚠️ stop 未生效，重发（第 \(sent + 1) 次）")
                self.postControl(action: "stop")
                self.verifyServiceStopped(token: token, sent: sent + 1)
            }
        }
    }

    /// 读取字幕服务运行状态：`completion(是否仍有进程/模型在运行, 代理是否可达)`，始终在主线程回调。
    /// 判定不能只看 `modelsLoaded` —— 模型还在加载时它同样是 false，那会被误判成“已卸载”而跳过重发，
    /// 所以按 `state == idle` 才算真的停干净。
    private func fetchSubtitlesRunState(completion: @escaping (Bool, Bool) -> Void) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/subtitles/status") else {
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
                let state = (obj["state"] as? String) ?? ""
                let loaded = (obj["modelsLoaded"] as? Bool) ?? false
                let loading = (obj["loading"] as? Bool) ?? false
                stillActive = loaded || loading || (!state.isEmpty && state != "idle")
            }
            DispatchQueue.main.async { completion(stillActive, reachable) }
        }.resume()
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "subtitleOverlay",
              let dict = message.body as? [String: Any],
              let action = dict["action"] as? String else { return }
        if action == "ready" {
            webReady = true
            if isVisible {
                notifyFrontendLinePairs(currentLinePairs)
                postControl(action: "start")
            }
        } else if action == "close" {
            hide()
        } else if action == "startCapture" {
            startAudioCapture()
        } else if action == "stopCapture" {
            stopAudioCapture()
        } else if action == "syncLayoutMetrics" {
            // 前端切换字号或开关原文时同步行高参数，窗体按当前行数档位（2+2、3+3、4+4...）自动吸附高度
            if let ch = dict["chromeHeight"] as? Double, ch > 20 {
                chromeHeight = CGFloat(ch)
            }
            if let ph = dict["pairHeight"] as? Double, ph > 16 {
                pairHeight = CGFloat(ph)
            }
            if let pairs = dict["linePairs"] as? Int, pairs >= 2 {
                currentLinePairs = pairs
            }
            applyQuantizedFrame(targetPairs: currentLinePairs, animate: true)
            if let panel = self.window {
                dragRawHeight = panel.frame.size.height
            }
        } else if action == "moveWindow",
                  let dx = dict["dx"] as? Double,
                  let dy = dict["dy"] as? Double {
            if let panel = self.window {
                var origin = panel.frame.origin
                origin.x += CGFloat(dx)
                origin.y -= CGFloat(dy)
                panel.setFrameOrigin(origin)
            }
        } else if action == "resizeStart" {
            if let panel = self.window {
                dragRawHeight = panel.frame.size.height
            }
        } else if action == "resizeWindow",
                  let dw = dict["dw"] as? Double,
                  let dh = dict["dh"] as? Double {
            if let panel = self.window {
                let screen = activeScreen()
                let maxW = screen.frame.width
                let minW = min(Self.minPanelWidth, maxW)
                let newW = max(minW, min(maxW, panel.frame.size.width + CGFloat(dw)))

                // 累积用户垂直拖拽量，但窗体高度不任意停留，而是按 (2+2, 3+3, 4+4...) 阶梯自适应吸附
                dragRawHeight += CGFloat(dh)
                let rawPairs = Int(round((dragRawHeight - chromeHeight) / max(20.0, pairHeight)))
                applyQuantizedFrame(targetPairs: rawPairs, customWidth: newW, anchorTop: true, animate: false)
            }
        }
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
}
