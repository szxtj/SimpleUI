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
/// 采用 ScreenCaptureKit 原生无损系统音频流内录（Audio Loopback），
/// 直接捕获所有 App、浏览器视频、会议音频，完全不调用物理麦克风、零环境杂音。
class SubtitleOverlayPanelController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate, SCStreamOutput {
    private static let panelWidth: CGFloat = 800
    private static let panelHeight: CGFloat = 185
    private static let bottomInset: CGFloat = 48

    private var webView: WKWebView!
    private var webReady = false

    // MARK: - 系统音频内录状态
    private var scStream: SCStream?
    private var isRecording = false
    private let audioQueue = DispatchQueue(label: "com.simpleui.systemAudioCapture", qos: .userInitiated)
    private var samplesLock = NSLock()
    private var currentChunk: [Int16] = []
    private var isSpeaking = false
    private var silenceSampleCount = 0
    private var lastPartialFeedCount = 0
    private var isFeedingPartial = false
    private var pendingPartialSamples: [Int16]? = nil
    private let energyThreshold: Double = 0.015 // 系统数字音频信噪比极高

    // 静音兜底阈值：连续静音这么久，就通知服务端「说话人停了」，让它做 L2 兜底断句。
    // 注意这里**不是断句依据** —— 真正的断句由服务端的句末判定模型决定，
    // 说话人一口气讲三句也不会等到这里才切。这一条只用来补上「模型在文本截断处
    // 拒绝表态」的那部分句子。
    // 700ms 太短：句内换气停顿就会被当成「说完了」，实测切出过 "Of course two rows of"
    // 这种半句话。句内停顿多在 800ms 以内，句子之间通常在 1s 以上，取 1.2s。
    private let silenceFlushSamples = 19200 // 1.2s @16kHz
    // 纯安全网：说话人长时间不停顿、服务端也没断句时，防止音频缓冲无界增长。
    // 正常路径下几乎不会触发，触发也只是把当前缓冲整段交给服务端。
    private let maxBufferSamples = 16000 * 12 // 12s（ASR 耗时随音频长度增长，不能无限累积）
    // 收到 trimAudio 后保留的尾部音频，只用来兜住「说话人已经起了下一句的头」那几个字。
    // 刻意留得很短：实测保留 2s 时，ASR 每轮看到的都是「上一句的尾巴 + 新句的开头」，
    // 这种跨句边界的音频是它最容易崩的输入（"the first the middle" 就出自这里）。
    // 短一点没关系，服务端会用「已消费文本的后缀匹配」把这点重叠对齐掉。
    private let trimKeepSamples = 8000 // 0.5s @16kHz

    // 送 ASR 的最小音频长度与步进。音频太短是识别质量崩坏的主因：
    // 0.2s 音频喂给 ASR 只会得到碎片和幻觉，宁可让首字晚一点出来。
    private let minPartialSamples = 32000  // 首次送达 2s
    private let partialStepSamples = 12800 // 之后每新增 0.8s 送一次

    var isVisible: Bool {
        return window?.isVisible ?? false
    }

    init() {
        let panel = SubtitleOverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.panelWidth, height: Self.panelHeight),
            styleMask: [.nonactivatingPanel, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.minSize = NSSize(width: 480, height: 140)
        panel.maxSize = NSSize(width: 1920, height: 1080)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true // 允许用户点击背景拖动字幕条
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
        webView.setValue(false, forKey: "drawsBackground") // 纯透明 WebKit 背景
        panel.contentView?.addSubview(webView)
    }

    func loadContent() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/#/subtitles") else { return }
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

    func show() {
        guard let panel = window else { return }
        if !webReady {
            loadContent()
        }
        if !isVisible {
            panel.setFrame(bottomCenterFrame(on: currentScreen()), display: true)
        }
        panel.orderFrontRegardless()
        startAudioCapture()
    }

    func hide() {
        stopAudioCapture()
        window?.orderOut(nil)
    }

    func toggle() {
        if isVisible {
            hide()
        } else {
            show()
        }
    }

    // MARK: - 系统音频内录 (ScreenCaptureKit Loopback)

    func startAudioCapture() {
        guard !isRecording else { return }
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else {
                    NSLog("[SubtitleOverlay] 未找到活动显示器")
                    return
                }
                let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                config.excludesCurrentProcessAudio = true // 排除自身声音，防止音频反馈循环
                config.sampleRate = 16000                 // 16kHz
                config.channelCount = 1                   // 单声道
                // 极小化不可见的画面捕获开销
                config.width = 100
                config.height = 100
                config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

                let stream = SCStream(filter: filter, configuration: config, delegate: nil)
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: audioQueue)
                try await stream.startCapture()

                self.audioQueue.async {
                    self.samplesLock.lock()
                    self.currentChunk.removeAll()
                    self.silenceSampleCount = 0
                    self.isSpeaking = false
                    self.lastPartialFeedCount = 0
                    self.isFeedingPartial = false
                    self.pendingPartialSamples = nil
                    self.samplesLock.unlock()
                }

                self.scStream = stream
                self.isRecording = true
                self.postControl(action: "start")
                NSLog("[SubtitleOverlay] ✅ 系统音频内录已成功启动 (ScreenCaptureKit Loopback)")
            } catch {
                NSLog("[SubtitleOverlay] ❌ 启动系统音频内录失败: \(error)")
            }
        }
    }

    func stopAudioCapture() {
        guard isRecording else { return }
        isRecording = false
        if let stream = scStream {
            scStream = nil
            Task {
                try? await stream.stopCapture()
                NSLog("[SubtitleOverlay] ⏹ 系统音频内录已停止")
            }
        }
        postControl(action: "stop")
    }

    // SCStreamOutput: 接收系统内部音频 PCM 缓冲区
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
        guard let ptr = dataPointer, actualLength > 0 else { return }

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

        guard !samples.isEmpty else { return }

        // 计算 RMS 能量
        var sumSquares: Double = 0
        for s in samples {
            let f = Double(s) / 32768.0
            sumSquares += f * f
        }
        let rms = sqrt(sumSquares / Double(samples.count))

        samplesLock.lock()
        defer { samplesLock.unlock() }

        if rms > energyThreshold {
            isSpeaking = true
            silenceSampleCount = 0
            currentChunk.append(contentsOf: samples)

            // 送 ASR 的节奏：先攒够 1.5s 再送第一次，之后每新增 0.8s 送一次。
            // 频率让位于质量 —— 半秒音频喂进去只会得到幻觉和伪句末。
            if currentChunk.count >= minPartialSamples &&
                (currentChunk.count - lastPartialFeedCount >= partialStepSamples) {
                lastPartialFeedCount = currentChunk.count
                let partialSlice = currentChunk
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    self?.feedAudioToService(samples: partialSlice, isFinal: false)
                }
            }
        } else {
            if isSpeaking {
                silenceSampleCount += samples.count
                currentChunk.append(contentsOf: samples)

                // 静音兜底：只负责告诉服务端「说话人停下了」，由它做 L2 兜底定稿。
                // 安全网：缓冲过长时强制送一次，避免无界增长（与断句无关）。
                let silenceReached = silenceSampleCount >= silenceFlushSamples
                let bufferTooLong = currentChunk.count >= maxBufferSamples

                if silenceReached || bufferTooLong {
                    let chunkToFeed = currentChunk
                    currentChunk.removeAll()
                    isSpeaking = false
                    silenceSampleCount = 0
                    lastPartialFeedCount = 0
                    if chunkToFeed.count >= 6400 { // 至少 400ms 保证有效语音
                        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                            self?.feedAudioToService(samples: chunkToFeed, isFinal: true)
                        }
                    }
                }
            }
        }
    }

    private func feedAudioToService(samples: [Int16], isFinal: Bool) {
        if !isFinal {
            if isFeedingPartial {
                // 当前正有推理在进行中，锁存最新采样的音频，待返回后立即紧跟补发
                pendingPartialSamples = samples
                return
            }
            isFeedingPartial = true
        } else {
            pendingPartialSamples = nil
        }
        let wav = Self.makeWAV(samples: samples, sampleRate: 16000)
        let endpoint = isFinal
            ? "\(ProcessManager.baseURLString)/api/subtitles/feed?is_final=1"
            : "\(ProcessManager.baseURLString)/api/subtitles/feed?is_partial=1"
        guard let url = URL(string: endpoint) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        req.httpBody = wav
        // 服务端现在是同步处理完 ASR 与句末判定才返回（响应里带 trimAudio），耗时以 ASR 为准
        req.timeoutInterval = 20.0
        let task = URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self = self else { return }

            // 服务端判定已成一整句：把对应音频丢掉，只留尾部一小段（说话人可能已起了下一句的头）。
            // 不截断的话，这一段语音会在后续每一轮被反复送进 ASR，长句时越来越慢。
            if let data = data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let trim = obj["trimAudio"] as? Bool, trim {
                self.samplesLock.lock()
                let keep = min(self.trimKeepSamples, self.currentChunk.count)
                if self.currentChunk.count > keep {
                    self.currentChunk = Array(self.currentChunk.suffix(keep))
                }
                self.lastPartialFeedCount = 0
                self.samplesLock.unlock()
            }

            if !isFinal {
                self.isFeedingPartial = false
                if let next = self.pendingPartialSamples {
                    self.pendingPartialSamples = nil
                    self.feedAudioToService(samples: next, isFinal: false)
                }
            }
        }
        task.resume()
    }


    private func postControl(action: String) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/subtitles/\(action)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
    }

    private static func makeWAV(samples: [Int16], sampleRate: Int) -> Data {
        let channels: Int16 = 1
        let bitsPerSample: Int16 = 16
        let byteRate = Int32(sampleRate) * Int32(channels) * Int32(bitsPerSample / 8)
        let blockAlign = Int16(channels * bitsPerSample / 8)
        let dataBytes = samples.count * 2

        var data = Data()
        func appendString(_ s: String) { data.append(contentsOf: Array(s.utf8)) }
        func appendUInt32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
        func appendUInt16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }

        appendString("RIFF")
        appendUInt32(UInt32(36 + dataBytes))
        appendString("WAVE")
        appendString("fmt ")
        appendUInt32(16)
        appendUInt16(1)
        appendUInt16(UInt16(channels))
        appendUInt32(UInt32(sampleRate))
        appendUInt32(UInt32(byteRate))
        appendUInt16(UInt16(bitPattern: blockAlign))
        appendUInt16(UInt16(bitsPerSample))
        appendString("data")
        appendUInt32(UInt32(dataBytes))
        samples.withUnsafeBytes { raw in
            data.append(contentsOf: raw)
        }
        return data
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "subtitleOverlay",
              let dict = message.body as? [String: Any],
              let action = dict["action"] as? String else { return }
        if action == "ready" {
            webReady = true
        } else if action == "close" {
            hide()
        } else if action == "startCapture" {
            startAudioCapture()
        } else if action == "stopCapture" {
            stopAudioCapture()
        } else if action == "moveWindow",
                  let dx = dict["dx"] as? Double,
                  let dy = dict["dy"] as? Double {
            if let panel = self.window {
                var origin = panel.frame.origin
                origin.x += CGFloat(dx)
                origin.y -= CGFloat(dy) // Cocoa Y 坐标系与屏幕反向
                panel.setFrameOrigin(origin)
            }
        } else if action == "resizeWindow",
                  let dw = dict["dw"] as? Double,
                  let dh = dict["dh"] as? Double {
            if let panel = self.window {
                var frame = panel.frame
                let newW = max(panel.minSize.width, min(panel.maxSize.width, frame.size.width + CGFloat(dw)))
                let newH = max(panel.minSize.height, min(panel.maxSize.height, frame.size.height - CGFloat(dh)))
                let dy = newH - frame.size.height
                frame.origin.y -= dy
                frame.size.width = newW
                frame.size.height = newH
                panel.setFrame(frame, display: true)
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
