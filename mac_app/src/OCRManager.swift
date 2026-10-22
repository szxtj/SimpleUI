import Cocoa
import ApplicationServices

/// 截图识别状态
public enum OCRState {
    case recognizing
    case success(chars: Int, durationMs: Int)
    case error(String)
    case modelMissing
}

/// 屏幕底部的非激活 HUD 提示面板（不抢夺当前活动 App 焦点）
final class OCRHUDPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// PaddleOCR-VL 全屏框选截图与 Markdown 极速链路管理器
public class OCRManager: NSObject {
    public static let shared = OCRManager()

    private var hudPanel: OCRHUDPanel?
    private var effectView: NSVisualEffectView?
    private var iconView: NSImageView?
    private var labelView: NSTextField?
    private var progressIndicator: NSProgressIndicator?
    private var autoHideWorkItem: DispatchWorkItem?

    private var isCapturing = false

    private static let panelWidth: CGFloat = 320
    private static let panelHeight: CGFloat = 46
    private static let bottomInset: CGFloat = 40

    override init() {
        super.init()
        setupHUD()
    }

    // MARK: - HUD 界面构建

    private func setupHUD() {
        let panel = OCRHUDPanel(
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
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.ignoresMouseEvents = true
        panel.animationBehavior = .none

        let effect = NSVisualEffectView(frame: panel.contentView?.bounds ?? .zero)
        effect.autoresizingMask = [.width, .height]
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 23
        effect.layer?.masksToBounds = true
        effect.layer?.borderWidth = 1
        effect.layer?.borderColor = NSColor.white.withAlphaComponent(0.2).cgColor

        // 容器 Stack
        let stack = NSStackView(frame: effect.bounds)
        stack.autoresizingMask = [.width, .height]
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 16, bottom: 8, right: 16)

        // 状态图标
        let iv = NSImageView()
        iv.imageScaling = .scaleProportionallyDown
        iv.setContentHuggingPriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            iv.widthAnchor.constraint(equalToConstant: 22),
            iv.heightAnchor.constraint(equalToConstant: 22),
        ])
        stack.addArrangedSubview(iv)

        // 加载圈（识别中展示）
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        NSLayoutConstraint.activate([
            spinner.widthAnchor.constraint(equalToConstant: 20),
            spinner.heightAnchor.constraint(equalToConstant: 20),
        ])
        stack.addArrangedSubview(spinner)

        // 文本提示
        let lbl = NSTextField(labelWithString: "")
        lbl.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        lbl.textColor = .labelColor
        lbl.lineBreakMode = .byTruncatingTail
        stack.addArrangedSubview(lbl)

        effect.addSubview(stack)
        panel.contentView?.addSubview(effect)

        self.hudPanel = panel
        self.effectView = effect
        self.iconView = iv
        self.labelView = lbl
        self.progressIndicator = spinner
    }

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

    private func showHUD(state: OCRState) {
        guard let panel = hudPanel else { return }
        autoHideWorkItem?.cancel()
        autoHideWorkItem = nil

        let isZh = AppLocale.isZh

        switch state {
        case .recognizing:
            iconView?.isHidden = true
            progressIndicator?.isHidden = false
            progressIndicator?.startAnimation(nil)
            labelView?.stringValue = isZh ? "PaddleOCR 正在解析 Markdown..." : "PaddleOCR recognizing Markdown..."
            labelView?.textColor = .labelColor

        case .success(let chars, let durationMs):
            progressIndicator?.stopAnimation(nil)
            progressIndicator?.isHidden = true
            iconView?.isHidden = false
            if #available(macOS 11.0, *) {
                let img = NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: nil)
                iconView?.image = img
                iconView?.contentTintColor = .systemGreen
            }
            labelView?.stringValue = isZh
                ? "已复制到剪贴板 (\(chars) 字 · \(durationMs)ms)"
                : "Copied to clipboard (\(chars) chars · \(durationMs)ms)"
            labelView?.textColor = .labelColor
            scheduleAutoHide(after: 1.8)

        case .error(let msg):
            progressIndicator?.stopAnimation(nil)
            progressIndicator?.isHidden = true
            iconView?.isHidden = false
            if #available(macOS 11.0, *) {
                let img = NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: nil)
                iconView?.image = img
                iconView?.contentTintColor = .systemRed
            }
            labelView?.stringValue = (isZh ? "识别失败: " : "Failed: ") + msg
            labelView?.textColor = .systemRed
            scheduleAutoHide(after: 2.5)

        case .modelMissing:
            progressIndicator?.stopAnimation(nil)
            progressIndicator?.isHidden = true
            iconView?.isHidden = false
            if #available(macOS 11.0, *) {
                let img = NSImage(systemSymbolName: "arrow.down.circle.fill", accessibilityDescription: nil)
                iconView?.image = img
                iconView?.contentTintColor = .systemOrange
            }
            labelView?.stringValue = isZh
                ? "PaddleOCR 模型未下载，请在服务面板下载"
                : "PaddleOCR model not downloaded, check panel"
            labelView?.textColor = .systemOrange
            scheduleAutoHide(after: 3.0)
        }

        panel.setFrame(bottomCenterFrame(on: currentScreen()), display: true)
        panel.orderFrontRegardless()
    }

    private func hideHUD() {
        autoHideWorkItem?.cancel()
        autoHideWorkItem = nil
        hudPanel?.orderOut(nil)
        progressIndicator?.stopAnimation(nil)
    }

    private func scheduleAutoHide(after seconds: TimeInterval) {
        let item = DispatchWorkItem { [weak self] in
            self?.hideHUD()
        }
        autoHideWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
    }

    // MARK: - 截图与识别主入口

    /// 触发 ⌘⇧2 截屏识别主入口
    public func startCapture() {
        guard !isCapturing else { return }
        isCapturing = true

        let tempPath = "/tmp/simpleui_ocr_\(UUID().uuidString).png"

        // 异步在全局队列调用 macOS 原生交互式框选截图 /usr/sbin/screencapture
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            task.arguments = ["-i", "-s", tempPath]

            do {
                try task.run()
                task.waitUntilExit()
            } catch {
                DispatchQueue.main.async {
                    self.isCapturing = false
                    self.showHUD(state: .error(error.localizedDescription))
                }
                return
            }

            // 检查文件是否生成：若用户按 Esc 取消，screencapture 不会写出文件
            guard FileManager.default.fileExists(atPath: tempPath) else {
                DispatchQueue.main.async {
                    self.isCapturing = false
                }
                return
            }

            // 展示识别中 HUD
            DispatchQueue.main.async {
                self.showHUD(state: .recognizing)
            }

            // 向本地 Node.js 代理发起识别请求
            self.requestRecognize(imagePath: tempPath) { [weak self] result in
                guard let self = self else { return }
                DispatchQueue.main.async {
                    self.isCapturing = false
                    // 清理本地截图临时文件
                    try? FileManager.default.removeItem(atPath: tempPath)

                    switch result {
                    case .success(let payload):
                        let text = payload.text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if text.isEmpty {
                            self.showHUD(state: .error("未识别到文字"))
                            return
                        }
                        // 一键写入系统剪贴板
                        let pb = NSPasteboard.general
                        pb.clearContents()
                        pb.setString(text, forType: .string)

                        // 只更新 HUD，不播放提示音
                        self.showHUD(state: .success(chars: text.count, durationMs: payload.durationMs))

                    case .failure(let err):
                        if err.isModelMissing {
                            self.showHUD(state: .modelMissing)
                        } else {
                            self.showHUD(state: .error(err.localizedDescription))
                        }
                    }
                }
            }
        }
    }

    // MARK: - HTTP 识别请求

    private struct RecognizePayload {
        let text: String
        let durationMs: Int
    }

    private enum OCRError: LocalizedError {
        case modelMissing
        case serverError(String)
        case networkError(String)

        var isModelMissing: Bool {
            if case .modelMissing = self { return true }
            return false
        }

        var errorDescription: String? {
            switch self {
            case .modelMissing: return "模型未下载"
            case .serverError(let s): return s
            case .networkError(let s): return s
            }
        }
    }

    private func requestRecognize(
        imagePath: String,
        completion: @escaping (Result<RecognizePayload, OCRError>) -> Void
    ) {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/ocr/recognize") else {
            completion(.failure(.networkError("URL 无效")))
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 120 // 首次拉起模型可能需要 15 秒

        let bodyObj: [String: Any] = ["imagePath": imagePath]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: bodyObj) else {
            completion(.failure(.networkError("序列化请求失败")))
            return
        }
        req.httpBody = bodyData

        URLSession.shared.dataTask(with: req) { data, resp, error in
            if let error = error {
                completion(.failure(.networkError(error.localizedDescription)))
                return
            }

            guard let http = resp as? HTTPURLResponse else {
                completion(.failure(.networkError("无效响应")))
                return
            }

            if http.statusCode == 409 {
                completion(.failure(.modelMissing))
                return
            }

            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                completion(.failure(.serverError("HTTP \(http.statusCode)")))
                return
            }

            if http.statusCode != 200 {
                let errMsg = (json["error"] as? String) ?? "HTTP \(http.statusCode)"
                if errMsg == "MODEL_MISSING" {
                    completion(.failure(.modelMissing))
                } else {
                    completion(.failure(.serverError(errMsg)))
                }
                return
            }

            let text = (json["text"] as? String) ?? ""
            let dur = (json["durationMs"] as? Int) ?? 0
            completion(.success(RecognizePayload(text: text, durationMs: dur)))
        }.resume()
    }
}
