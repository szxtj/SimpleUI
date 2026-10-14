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
/// 按 160ms (2560 samples @ 16kHz) 增量切片无损流式推送至服务端 ANE 流式引擎。
class SubtitleOverlayPanelController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate, SCStreamOutput {
    private static let panelWidth: CGFloat = 800
    private static let panelHeight: CGFloat = 195
    private static let bottomInset: CGFloat = 48

    private var webView: WKWebView!
    private var webReady = false
    var onVisibilityChanged: ((Bool) -> Void)?

    // MARK: - 系统音频 160ms 增量流式内录状态
    private var scStream: SCStream?
    private var isRecording = false
    private let audioQueue = DispatchQueue(label: "com.simpleui.systemAudioCapture", qos: .userInitiated)
    private var samplesLock = NSLock()

    // 160ms @ 16kHz = 2560 采样点（与 Nemotron Streaming 160ms 帧严格对齐）
    private let chunkSamples = 2560
    // 160ms 前置环形缓冲：静默期持续保留最近 160ms 音频，人声触发瞬间一并送入，防止吞掉句首辅音
    private var preRollBuffer: [Int16] = []
    private var pendingSamples: [Int16] = []
    private var isSpeaking = false
    private var trailingSilentChunks = 0
    // 方案 B：9 * 160ms = 1440ms 尾随静音后发送 is_final=1，避免慢语速句中停顿误触发硬切与状态重置
    private let maxTrailingSilentChunks = 9
    private let energyThreshold: Double = 0.010

    // 严格 FIFO 串行发送队列，确保 160ms 增量音频帧绝不乱序或并发踩踏
    private var outboundQueue: [(samples: [Int16], isFinal: Bool)] = []
    private var isSendingFrame = false

    var isVisible: Bool {
        return window?.isVisible ?? false
    }

    init() {
        let panel = SubtitleOverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.panelWidth, height: Self.panelHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.minSize = NSSize(width: 480, height: 140)
        panel.maxSize = NSSize(width: 1920, height: 1080)
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
        onVisibilityChanged?(true)
        webView.evaluateJavaScript("window.onSubtitleOverlayShown && window.onSubtitleOverlayShown()") { _, _ in }
        // 触发服务端按阶段加载三个模型；待三个模型全部加载完成，前端将下发 startCapture 启动内录
        postControl(action: "start")
    }

    func hide() {
        stopAudioCapture()
        // 关闭窗口时立刻通知服务端停止并卸载全部三个字幕模型与子进程
        postControl(action: "stop")
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

    // MARK: - 系统音频内录 (ScreenCaptureKit Loopback)

    func startAudioCapture() {
        guard !isRecording, isVisible else { return }
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
                config.excludesCurrentProcessAudio = true
                config.sampleRate = 16000
                config.channelCount = 1
                config.width = 100
                config.height = 100
                config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

                let stream = SCStream(filter: filter, configuration: config, delegate: nil)
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: audioQueue)
                try await stream.startCapture()

                self.audioQueue.async {
                    self.samplesLock.lock()
                    self.preRollBuffer.removeAll()
                    self.pendingSamples.removeAll()
                    self.outboundQueue.removeAll()
                    self.isSpeaking = false
                    self.trailingSilentChunks = 0
                    self.isSendingFrame = false
                    self.samplesLock.unlock()
                }

                self.scStream = stream
                self.isRecording = true
                NSLog("[SubtitleOverlay] ✅ 系统音频 160ms 流式内录已启动 (ScreenCaptureKit Loopback)")
            } catch {
                NSLog("[SubtitleOverlay] ❌ 启动系统音频内录失败: \(error)")
            }
        }
    }

    func stopAudioCapture() {
        guard isRecording else { return }
        isRecording = false
        self.audioQueue.async {
            self.samplesLock.lock()
            self.preRollBuffer.removeAll()
            self.pendingSamples.removeAll()
            self.outboundQueue.removeAll()
            self.isSpeaking = false
            self.trailingSilentChunks = 0
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

    // SCStreamOutput: 接收系统内部音频 PCM 缓冲区并按 160ms 切片流式发送
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

        samplesLock.lock()
        pendingSamples.append(contentsOf: samples)

        while pendingSamples.count >= chunkSamples {
            let slice = Array(pendingSamples.prefix(chunkSamples))
            pendingSamples.removeFirst(chunkSamples)

            // 计算该 160ms 切片的 RMS 能量
            var sumSq: Double = 0
            for s in slice {
                let f = Double(s) / 32768.0
                sumSq += f * f
            }
            let rms = sqrt(sumSq / Double(slice.count))

            if rms >= energyThreshold {
                if !isSpeaking {
                    isSpeaking = true
                    trailingSilentChunks = 0
                    // 将触发前 160ms 的前置缓冲一并推入，防止吞掉句首辅音
                    if !preRollBuffer.isEmpty {
                        outboundQueue.append((samples: preRollBuffer, isFinal: false))
                        preRollBuffer.removeAll(keepingCapacity: true)
                    }
                } else {
                    trailingSilentChunks = 0
                }
                outboundQueue.append((samples: slice, isFinal: false))
            } else {
                if isSpeaking {
                    trailingSilentChunks += 1
                    let reachedFinalSilence = trailingSilentChunks >= maxTrailingSilentChunks
                    outboundQueue.append((samples: slice, isFinal: reachedFinalSilence))
                    if reachedFinalSilence {
                        isSpeaking = false
                        trailingSilentChunks = 0
                    }
                } else {
                    // 静默期仅更新 160ms 前置环形缓冲，不向服务端发无效请求
                    preRollBuffer = slice
                }
            }
        }

        // 限制积压队列上限（超过 25 帧即 4s 时丢弃最旧的非 final 帧防滞后）
        if outboundQueue.count > 25 {
            outboundQueue.removeFirst(outboundQueue.count - 15)
        }
        samplesLock.unlock()

        drainOutboundQueue()
    }

    private func drainOutboundQueue() {
        samplesLock.lock()
        if isSendingFrame || outboundQueue.isEmpty {
            samplesLock.unlock()
            return
        }
        isSendingFrame = true
        let item = outboundQueue.removeFirst()
        samplesLock.unlock()

        var rawData = Data(capacity: item.samples.count * 2)
        item.samples.withUnsafeBytes { raw in
            rawData.append(contentsOf: raw)
        }

        let endpoint = item.isFinal
            ? "\(ProcessManager.baseURLString)/api/subtitles/feed?format=pcm&is_final=1"
            : "\(ProcessManager.baseURLString)/api/subtitles/feed?format=pcm"
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

        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            guard let self = self else { return }
            self.samplesLock.lock()
            self.isSendingFrame = false
            self.samplesLock.unlock()
            self.drainOutboundQueue()
        }.resume()
    }

    private func postControl(action: String) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/subtitles/\(action)") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        URLSession.shared.dataTask(with: req).resume()
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "subtitleOverlay",
              let dict = message.body as? [String: Any],
              let action = dict["action"] as? String else { return }
        if action == "ready" {
            webReady = true
            if isVisible {
                postControl(action: "start")
            }
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
                origin.y -= CGFloat(dy)
                panel.setFrameOrigin(origin)
            }
        } else if action == "resizeWindow",
                  let dw = dict["dw"] as? Double,
                  let dh = dict["dh"] as? Double {
            if let panel = self.window {
                var frame = panel.frame
                let topY = frame.origin.y + frame.size.height
                let newW = max(panel.minSize.width, min(panel.maxSize.width, frame.size.width + CGFloat(dw)))
                // 鼠标向下拖拽时 dh > 0，窗口高度应随之增大（frame.size.height + CGFloat(dh)），并锚定顶部边缘 topY 不动
                let newH = max(panel.minSize.height, min(panel.maxSize.height, frame.size.height + CGFloat(dh)))
                frame.origin.y = topY - newH
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
