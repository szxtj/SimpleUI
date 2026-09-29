import Cocoa
import AVFoundation
import ApplicationServices
import CoreGraphics

/// 语音输入状态（驱动屏幕底部悬浮 UI 的外观）
enum VoiceInputState: String {
    case idle
    case recording
    case transcribing
    case done
    case error
}

/// 全局语音输入（长按右侧 Command 键）
///
/// 交互契约（用户需求）：
///   - 在**全系统任何输入框**长按右 ⌘ → 录音 → 转写 → 直接写入该输入框；
///   - 焦点**不在**输入框时 → 转写后直接复制到剪贴板（一键复制）；
///   - 录音 / 转写 / 完成 的状态实时推给屏幕底部居中的悬浮胶囊 UI。
///
/// 实现要点：
///   1. 右 ⌘ 是**修饰键**，不是普通热键，因此不能用 RegisterEventHotKey；
///      改为在会话级事件流上挂一个只读 CGEventTap，监听 flagsChanged（keyCode 54）
///      与 keyDown——长按超过阈值即进入录音；若期间按下了任何其它键（说明是 ⌘C 这类
///      组合键）则立刻取消，绝不抢用户的组合键。
///   2. 录音用 AVAudioEngine，硬件格式经 AVAudioConverter 转 16kHz 单声道 Int16，
///      再封装成 WAV 交给本地代理的 /api/asr/transcribe（Node 侧再转给 audiocpp）。
///   3. 是否「在输入框中」用辅助功能（AXUIElement）判定：先看角色是否文本类控件，
///      否则回退到「有选中文本范围且 value 可写」。
///   4. 写入方式：把文本放剪贴板后合成 ⌘V —— 与系统听写一致，兼容所有 App；
///      不在输入框时只放剪贴板（即「一键复制」）。
///
/// 权限（三件套，缺一不可）：
///   - 麦克风（AVCaptureDevice）：录音；
///   - 辅助功能（AXIsProcessTrusted）：读焦点控件 + 合成 ⌘V；
///   - 输入监控（CGPreflightListenEventAccess）：挂全局只读事件监听。
class VoiceInputManager {
    static let shared = VoiceInputManager()

    /// 把转写结果插入本 App 自身输入框时，由 MainWindowController 监听并桥给前端
    static let insertTextNotification = Notification.Name("SimpleUIVoiceInsertText")

    /// 状态变化回调：(状态, 音量 0~1, 文本/错误信息, 落点 paste|copy|insert)
    var onStateChange: ((VoiceInputState, Float, String?, String?) -> Void)?

    /// 右 ⌘ 长按触发阈值（秒）——低于此值视为普通修饰键，不触发
    private let holdThreshold: TimeInterval = 0.35
    /// 录音时长下限：过短（误触）直接丢弃
    private let minRecordingDuration: TimeInterval = 0.3

    private let rightCommandKeyCode: Int64 = 54

    // 事件监听
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var globalMonitors: [Any] = []

    // 长按状态机
    private var rightCommandDown = false
    private var holdWorkItem: DispatchWorkItem?
    private var isCapturing = false
    private var recordingStartedAt: Date?

    // 录音
    private let audioEngine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var pcmSamples: [Int16] = []
    private var samplesLock = NSLock()
    private var lastLevelEmit = Date.distantPast

    /// 本次录音的落点：true = 写入焦点输入框；false = 仅复制到剪贴板
    private var pasteTarget = false

    private init() {}

    // MARK: - 生命周期

    /// 安装全局监听（App 启动时调用一次）
    func install() {
        installEventTap()
        // 权限是「事后才授予」的常态：用户在系统设置里勾选后回到本 App，
        // 必须重新安装监听才会真正生效（无权限时 tap 创建失败、兜底监视器也静默失效）。
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationDidBecomeActive),
            name: NSApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    @objc private func applicationDidBecomeActive() {
        refreshInstallation()
        VoiceInputManager.broadcastPermissionUpdate()
    }

    /// 权限变化后重装监听（幂等：已就绪时直接返回）
    func refreshInstallation() {
        guard AXIsProcessTrusted() || CGPreflightListenEventAccess() else { return }
        installEventTap()
    }

    func uninstall() {
        NotificationCenter.default.removeObserver(self)
        holdWorkItem?.cancel()
        holdWorkItem = nil
        removeGlobalMonitors()
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let src = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), src, .commonModes)
        }
        eventTap = nil
        runLoopSource = nil
        stopEngineIfNeeded()
    }

    /// 挂只读事件监听：优先 CGEventTap；无权限时退回 NSEvent 全局监视器。
    /// 幂等——已有可用事件源时直接返回；tap 成功后撤掉兜底监视器，避免双重处理。
    private func installEventTap() {
        if eventTap != nil { return }

        let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        if let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(mask),
            callback: simpleUIVoiceEventTapCallback,
            userInfo: nil
        ) {
            removeGlobalMonitors()
            eventTap = tap
            let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            runLoopSource = src
            CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            return
        }

        // 兜底已装则不再重复挂（NSEvent 全局监视器在无权限时也会返回对象但永不触发）
        guard globalMonitors.isEmpty else { return }

        // 兜底：NSEvent 全局监视器（同样依赖辅助功能权限，但不依赖输入监控）
        let flagsMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] ev in
            // NSEvent.ModifierFlags 与 CGEventFlags 的位定义一致，可直接按 rawValue 互转
            self?.handleFlagsChanged(keyCode: Int64(ev.keyCode), flags: CGEventFlags(rawValue: UInt64(ev.modifierFlags.rawValue)))
        }
        let keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] _ in
            self?.handleForeignKeyDown()
        }
        if let f = flagsMonitor { globalMonitors.append(f) }
        if let k = keyMonitor { globalMonitors.append(k) }
    }

    private func removeGlobalMonitors() {
        for m in globalMonitors { NSEvent.removeMonitor(m) }
        globalMonitors.removeAll()
    }

    // MARK: - 事件处理

    fileprivate func handleEvent(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = eventTap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        if type == .flagsChanged {
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            handleFlagsChanged(keyCode: keyCode, flags: event.flags)
        } else if type == .keyDown {
            handleForeignKeyDown()
        }
    }

    /// 修饰键变化：只关心右 ⌘（keyCode 54）
    private func handleFlagsChanged(keyCode: Int64, flags: CGEventFlags) {
        guard keyCode == rightCommandKeyCode else { return }

        let commandDown = flags.contains(.maskCommand)
        // 若同时还有 control / option / shift，视为组合键，完全不介入
        let hasOtherModifier =
            flags.contains(.maskControl) || flags.contains(.maskAlternate) || flags.contains(.maskShift)

        if commandDown && !hasOtherModifier {
            guard !rightCommandDown else { return }
            rightCommandDown = true
            scheduleHoldTrigger()
        } else if commandDown && hasOtherModifier {
            // 按右 ⌘ 的同时还按了别的修饰键 → 组合键，取消
            cancelHoldTrigger()
            rightCommandDown = true
        } else {
            // 右 ⌘ 抬起
            rightCommandDown = false
            cancelHoldTrigger()
            if isCapturing { finishCapture() }
        }
    }

    /// 长按期间按下了普通按键 → 是组合键（如 ⌘C），取消触发
    private func handleForeignKeyDown() {
        guard rightCommandDown, !isCapturing else { return }
        cancelHoldTrigger()
    }

    private func scheduleHoldTrigger() {
        cancelHoldTrigger()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.rightCommandDown, !self.isCapturing else { return }
            self.beginCapture()
        }
        holdWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + holdThreshold, execute: work)
    }

    private func cancelHoldTrigger() {
        holdWorkItem?.cancel()
        holdWorkItem = nil
    }

    // MARK: - 采集流程

    private func beginCapture() {
        // 麦克风权限：未授权则发起申请并提示
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async {
                    if granted {
                        self.beginCapture()
                    } else {
                        self.emit(.error, 0, "未获得麦克风权限")
                    }
                }
            }
            return
        default:
            emit(.error, 0, "未获得麦克风权限")
            return
        }

        // 判定落点：焦点是否在文本输入框
        pasteTarget = VoiceInputManager.focusedElementIsTextInput()

        guard startRecording() else {
            emit(.error, 0, "无法访问麦克风")
            return
        }
        isCapturing = true
        recordingStartedAt = Date()
        emit(.recording, 0, nil)
    }

    private func finishCapture() {
        guard isCapturing else { return }
        isCapturing = false
        cancelHoldTrigger()

        let duration = recordingStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        recordingStartedAt = nil
        let wav = stopRecording()

        guard duration >= minRecordingDuration, let data = wav, data.count > 1024 else {
            // 误触 / 太短：静默收场
            emit(.idle, 0, nil)
            return
        }

        emit(.transcribing, 0, nil)
        transcribe(wav: data) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let text):
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else {
                    self.emit(.error, 0, "未识别到语音")
                    return
                }
                if VoiceInputManager.isSelfAppFocused() {
                    // 本 App 自身的输入框在 WKWebView 内，AX 判定为 AXWebArea 会被误判非文本，
                    // 因此走前端桥把文本直接插入光标处；同时兜底复制到剪贴板（插入失败仍可取用）。
                    NotificationCenter.default.post(name: VoiceInputManager.insertTextNotification, object: trimmed)
                    self.copyToClipboard(trimmed)
                    self.emit(.done, 0, trimmed, "insert")
                } else if self.pasteTarget {
                    self.pasteToFocusedApp(trimmed)
                    self.emit(.done, 0, trimmed, "paste")
                } else {
                    self.copyToClipboard(trimmed)
                    self.emit(.done, 0, trimmed, "copy")
                }
            case .failure(let err):
                self.emit(.error, 0, err.localizedDescription)
            }
        }
    }

    private func emit(_ state: VoiceInputState, _ level: Float, _ text: String?, _ action: String? = nil) {
        DispatchQueue.main.async {
            self.onStateChange?(state, level, text, action)
        }
    }

    // MARK: - 录音（AVAudioEngine → 16kHz 单声道 Int16）

    private func startRecording() -> Bool {
        let input = audioEngine.inputNode
        let hwFormat = input.outputFormat(forBus: 0)
        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else { return false }

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16000,
            channels: 1,
            interleaved: true
        ), let conv = AVAudioConverter(from: hwFormat, to: targetFormat) else {
            return false
        }
        converter = conv
        samplesLock.lock()
        pcmSamples.removeAll(keepingCapacity: true)
        samplesLock.unlock()

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: hwFormat) { [weak self] buffer, _ in
            self?.handleAudioBuffer(buffer, hwFormat: hwFormat, targetFormat: targetFormat)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            input.removeTap(onBus: 0)
            return false
        }
        return true
    }

    private func handleAudioBuffer(_ buffer: AVAudioPCMBuffer, hwFormat: AVAudioFormat, targetFormat: AVAudioFormat) {
        guard let converter = converter else { return }
        let ratio = targetFormat.sampleRate / hwFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var consumed = false
        var convErr: NSError?
        converter.convert(to: out, error: &convErr) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard convErr == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }

        let n = Int(out.frameLength)
        let ptr = ch[0]
        var sumSquares: Double = 0
        samplesLock.lock()
        pcmSamples.reserveCapacity(pcmSamples.count + n)
        for i in 0..<n {
            let s = ptr[i]
            pcmSamples.append(s)
            let f = Double(s) / 32768.0
            sumSquares += f * f
        }
        samplesLock.unlock()

        // 音量（RMS → 0~1，做一次平方根压扩让视觉更灵敏），限频 ~20Hz 推送
        let now = Date()
        if now.timeIntervalSince(lastLevelEmit) > 0.05 {
            lastLevelEmit = now
            let rms = sqrt(sumSquares / Double(max(1, n)))
            let level = Float(min(1.0, rms * 4.0))
            emit(.recording, level, nil)
        }
    }

    private func stopRecording() -> Data? {
        audioEngine.inputNode.removeTap(onBus: 0)
        stopEngineIfNeeded()
        samplesLock.lock()
        let samples = pcmSamples
        pcmSamples.removeAll(keepingCapacity: false)
        samplesLock.unlock()
        guard !samples.isEmpty else { return nil }
        return VoiceInputManager.makeWAV(samples: samples, sampleRate: 16000)
    }

    private func stopEngineIfNeeded() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.reset()
        converter = nil
    }

    /// 把 Int16 PCM 封装为 16kHz 单声道 16bit WAV
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
        appendUInt32(16)                      // PCM chunk size
        appendUInt16(1)                       // PCM
        appendUInt16(UInt16(channels))
        appendUInt32(UInt32(sampleRate))
        appendUInt32(UInt32(byteRate))
        appendUInt16(UInt16(bitPattern: blockAlign))
        appendUInt16(UInt16(bitsPerSample))
        appendString("data")
        appendUInt32(UInt32(dataBytes))
        // arm64 原生小端，与 WAV 约定一致，直接按字节追加
        samples.withUnsafeBytes { raw in
            data.append(contentsOf: raw)
        }
        return data
    }

    // MARK: - 转写

    private func transcribe(wav: Data, completion: @escaping (Result<String, Error>) -> Void) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/asr/transcribe") else {
            completion(.failure(VoiceInputError("无效的本地服务地址")))
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        req.httpBody = wav
        req.timeoutInterval = 60

        URLSession.shared.dataTask(with: req) { data, _, error in
            if let error = error {
                completion(.failure(error))
                return
            }
            guard let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                completion(.failure(VoiceInputError("转写服务无响应")))
                return
            }
            if (obj["ok"] as? Bool) == true, let text = obj["text"] as? String {
                completion(.success(text))
            } else {
                let code = (obj["error"] as? String) ?? "unknown"
                let msg: String
                switch code {
                case "service_not_ready": msg = "语音识别服务未启动"
                case "upstream_unavailable": msg = "语音识别服务未就绪"
                case "upstream_timeout": msg = "语音识别超时"
                case "empty_audio": msg = "录音数据为空"
                default: msg = "转写失败"
                }
                completion(.failure(VoiceInputError(msg)))
            }
        }.resume()
    }

    // MARK: - 焦点判定与写入

    /// 焦点元素是否为「可写入的文本输入框」
    private static func focusedElementIsTextInput() -> Bool {
        guard AXIsProcessTrusted() else { return false }
        let system = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
              let focusedRef = focusedRef else {
            return false
        }
        let element = unsafeBitCast(focusedRef, to: AXUIElement.self)

        let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
        let nonTextRoles: Set<String> = [
            "AXStaticText", "AXHeading", "AXImage", "AXButton", "AXLink", "AXMenuItem",
            "AXMenuBar", "AXMenu", "AXList", "AXRow", "AXTable", "AXWindow", "AXWebArea",
            "AXScrollArea", "AXGroup", "AXSplitGroup", "AXTabGroup", "AXToolbar",
        ]

        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        let role = (roleRef as? String) ?? ""

        if textRoles.contains(role) { return true }
        if nonTextRoles.contains(role) { return false }

        // 兜底：同时具备「可写的 value」与「选中文本范围」才算可编辑文本上下文
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        var rangeRef: CFTypeRef?
        let hasRange = AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success
        return settable.boolValue && hasRange
    }

    /// 当前前台 App 是否为本 App 自身（语音目标是本 App 自己的输入框时走前端桥插入）
    private static func isSelfAppFocused() -> Bool {
        guard let front = NSWorkspace.shared.frontmostApplication else { return false }
        return front.bundleIdentifier == Bundle.main.bundleIdentifier
    }

    private func copyToClipboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }

    /// 写入焦点 App：置剪贴板后合成 ⌘V（与系统听写一致，兼容所有 App）
    private func pasteToFocusedApp(_ text: String) {
        copyToClipboard(text)
        // 稍等一拍让剪贴板落定，再合成按键
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
            let src = CGEventSource(stateID: .combinedSessionState)
            let vKey: CGKeyCode = 9 // 'V'
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: true),
                  let up = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: false) else { return }
            down.flags = .maskCommand
            up.flags = .maskCommand
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    // MARK: - 权限

    /// 三件套权限快照（供设置页展示）
    func permissionSnapshot() -> [String: Any] {
        let mic: String
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: mic = "granted"
        case .denied: mic = "denied"
        case .restricted: mic = "restricted"
        case .notDetermined: mic = "undetermined"
        @unknown default: mic = "undetermined"
        }
        return [
            "microphone": mic,
            "accessibility": AXIsProcessTrusted(),
            "inputMonitoring": CGPreflightListenEventAccess(),
            // 全局监听是否已真正挂上（诊断用：授权后若为 false 说明需要重装监听）
            "eventTapActive": eventTap != nil,
        ]
    }

    /// 发起麦克风权限申请（系统弹窗）
    func requestMicrophone() {
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            DispatchQueue.main.async { VoiceInputManager.broadcastPermissionUpdate() }
        }
    }

    /// 发起辅助功能权限申请（跳系统设置并高亮）
    func requestAccessibility() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let options = [key: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        // 用户在系统设置里勾选后回到 App，didBecomeActive 会重装监听；这里再兜一次
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            VoiceInputManager.shared.refreshInstallation()
            VoiceInputManager.broadcastPermissionUpdate()
        }
    }

    /// 发起输入监控权限申请（系统弹窗）
    func requestInputMonitoring() {
        _ = CGRequestListenEventAccess()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            VoiceInputManager.shared.refreshInstallation()
            VoiceInputManager.broadcastPermissionUpdate()
        }
    }

    /// 打开系统设置的对应隐私面板
    func openPrivacyPane(_ pane: String) {
        let map = [
            "microphone": "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            "accessibility": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            "inputMonitoring": "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
        ]
        guard let s = map[pane], let url = URL(string: s) else { return }
        NSWorkspace.shared.open(url)
    }

    /// 权限变化后广播给两个窗口（设置页据此刷新）
    static func broadcastPermissionUpdate() {
        NotificationCenter.default.post(name: .simpleUIVoicePermissionsChanged, object: nil)
    }
}

struct VoiceInputError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

extension Notification.Name {
    static let simpleUIVoicePermissionsChanged = Notification.Name("SimpleUIVoicePermissionsChanged")
}

/// CGEventTap 的 C 回调（必须是无捕获的顶层函数）
private func simpleUIVoiceEventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    VoiceInputManager.shared.handleEvent(type: type, event: event)
    return Unmanaged.passUnretained(event)
}
