import AppKit
import SwiftUI

public final class TranslationPanelController: NSObject {
    private enum Layout {
        static let width: CGFloat = 620
        static let minHeight: CGFloat = 336
    }

    private let viewModel: TranslationViewModel
    private var panel: TranslationSpotlightPanel?
    /// 已消费过的剪贴板版本号：同一份复制内容只自动翻译一次，避免每次呼出重译同一个词。
    private var lastHandledClipboardChangeCount: Int = -1

    public init(viewModel: TranslationViewModel? = nil) {
        if let vm = viewModel {
            self.viewModel = vm
        } else {
            self.viewModel = MainActor.assumeIsolated {
                TranslationViewModel()
            }
        }
        super.init()
        setupNotifications()
    }

    private func setupNotifications() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onVoiceInsertText(_:)),
            name: VoiceInputManager.insertTextNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func onVoiceInsertText(_ note: Notification) {
        guard let text = note.object as? String, !text.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let p = self.panel, p.isVisible, p.isKeyWindow else { return }

            if let textView = p.firstResponder as? NSTextView, textView.isEditable {
                textView.insertText(text, replacementRange: textView.selectedRange())
            } else {
                MainActor.assumeIsolated {
                    if self.viewModel.inputText.isEmpty {
                        self.viewModel.inputText = text
                    } else {
                        self.viewModel.inputText += text
                    }
                    self.viewModel.requestFocus()
                }
            }
        }
    }

    /// 应用启动时在后台预创建并预热面板视图，确保首次呼出时尺寸已完全计算且居中无抖动
    public func preload() {
        if Thread.isMainThread {
            self.performPreload()
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.performPreload()
            }
        }
    }

    private func performPreload() {
        MainActor.assumeIsolated {
            let p = panel ?? makePanel()
            self.panel = p
            _ = p.contentView
            p.contentView?.layoutSubtreeIfNeeded()
            center(p)
            p.orderOut(nil)
        }
    }

    public func show() {
        if Thread.isMainThread {
            self.performShow()
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.performShow()
            }
        }
    }

    private func currentScreen() -> NSScreen {
        let mouseLocation = NSEvent.mouseLocation
        let screens = NSScreen.screens
        return screens.first(where: { NSPointInRect(mouseLocation, $0.frame) }) ?? NSScreen.main ?? screens[0]
    }

    /// 触发快速翻译模型后台静默预热（fire-and-forget，打开窗口时立即拉起模型，零额外翻译等待）
    private func warmupService() {
        guard let url = URL(string: "\(ProcessManager.baseURLString)/api/translate/warmup") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        URLSession.shared.dataTask(with: req).resume()
    }

    /// - Parameter applyClipboardQuickTranslate: 划选翻译 `present()` 自带原文，不能让剪贴板快译覆盖它。
    private func performShow(applyClipboardQuickTranslate: Bool = true) {
        // 调出翻译窗口时，在后台立即触发快速翻译模型按需预热
        warmupService()

        let p = panel ?? makePanel()
        self.panel = p

        MainActor.assumeIsolated {
            viewModel.refreshLocaleAndSettings()
            // 每次呼出都回到快速模式：包括普通呼出、划选翻译与剪贴板自动翻译，
            // 不保留上次窗口里选的「详解」。
            viewModel.selectedMode = .quick
            if applyClipboardQuickTranslate {
                self.loadClipboardForQuickTranslate()
            }
        }

        // 每次重新打开均强制全屏居中归位
        center(p)

        // 保持独立浮动且不激活主应用程序（与主窗口严格解耦，不拉起后台的主窗口）
        p.makeKeyAndOrderFront(nil)
        p.orderFrontRegardless()
        focusInput()
    }

    /// 「复制文本快速翻译」：设置里默认关闭；开启后采纳**首项是普通文字**的剪贴板内容
    /// （`TranslationClipboard` 负责筛选）。
    ///
    /// 关键约定：只要开关关闭、剪贴板不合格、是同一份剪贴板、或这段文字已经翻译过，
    /// 就**完全不碰 viewModel** —— 输入框与结果区原样保留上一次翻译的内容，绝不置空，
    /// 也绝不因为反复呼出窗口而把同一个词重复送去翻译。
    /// 只有「用户复制了新内容」（剪贴板 changeCount 变化）才会重新代入并翻译。
    @MainActor
    private func loadClipboardForQuickTranslate() {
        guard UserDefaults.standard.bool(
            forKey: TranslationClipboard.quickTranslateEnabledKey
        ) else { return }

        guard let snapshot = TranslationClipboard.plainTextSnapshot(from: NSPasteboard.general) else {
            return
        }

        // 1) 同一份剪贴板写入只消费一次：复制一次后反复呼出窗口不重译。
        guard snapshot.changeCount != lastHandledClipboardChangeCount else { return }

        let currentInput = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let previousOutput = viewModel.outputText.trimmingCharacters(in: .whitespacesAndNewlines)

        // 2) 这段文字已经在翻译中 / 已经有译文：即使重新复制了同一段也不重复发起请求。
        let alreadyTranslated = snapshot.text == currentInput
            && (viewModel.isLoading || !previousOutput.isEmpty)

        // 3) 底部「复制」按钮会把译文写回剪贴板；不能把译文当成新的待译原文反向翻译。
        let isSelfCopiedResult = !previousOutput.isEmpty && snapshot.text == previousOutput

        if alreadyTranslated || isSelfCopiedResult {
            lastHandledClipboardChangeCount = snapshot.changeCount
            return
        }

        lastHandledClipboardChangeCount = snapshot.changeCount
        // 模式由 performShow 统一置为 .quick，这里只代入原文并立即翻译。
        viewModel.loadSelectionText(snapshot.text, mode: viewModel.selectedMode)
        viewModel.startTranslation()
    }

    /// 从划选浮标一键呼出：代入纯文本、切换模式，并可直接开始翻译。
    public func present(text: String, mode: TranslationMode, autoTranslate: Bool) {
        if Thread.isMainThread {
            self.performPresent(text: text, mode: mode, autoTranslate: autoTranslate)
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.performPresent(text: text, mode: mode, autoTranslate: autoTranslate)
            }
        }
    }

    private func performPresent(text: String, mode: TranslationMode, autoTranslate: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        MainActor.assumeIsolated {
            viewModel.loadSelectionText(trimmed, mode: mode)
        }
        // 划选翻译自带原文；把当前剪贴板标记为已消费，避免下次呼出被旧剪贴板覆盖。
        lastHandledClipboardChangeCount = NSPasteboard.general.changeCount
        performShow(applyClipboardQuickTranslate: false)

        if autoTranslate {
            MainActor.assumeIsolated {
                viewModel.startTranslation()
            }
        }
    }

    public func hide() {
        if Thread.isMainThread {
            self.performHide()
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.performHide()
            }
        }
    }

    private func performHide() {
        panel?.orderOut(nil)
        MainActor.assumeIsolated {
            viewModel.stopSpeech()
            viewModel.clearOutputSelection()
        }
    }

    public func toggle() {
        if Thread.isMainThread {
            self.performToggle()
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.performToggle()
            }
        }
    }

    private func performToggle() {
        guard let p = panel else {
            performShow()
            return
        }

        if p.isVisible && p.isKeyWindow {
            performHide()
        } else {
            performShow()
        }
    }

    public func focusInput() {
        MainActor.assumeIsolated {
            viewModel.requestFocus()
        }
    }

    public func refreshLocaleAndSettings() {
        MainActor.assumeIsolated {
            viewModel.refreshLocaleAndSettings()
        }
    }

    private func makePanel() -> TranslationSpotlightPanel {
        return MainActor.assumeIsolated {
            let p = TranslationSpotlightPanel(
                contentRect: NSRect(x: 0, y: 0, width: Layout.width, height: Layout.minHeight),
                styleMask: [.titled, .nonactivatingPanel, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )

            p.appearance = NSAppearance(named: .darkAqua)
            p.isFloatingPanel = true
            p.level = .floating
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.titleVisibility = .hidden
            p.titlebarAppearsTransparent = true
            p.isReleasedWhenClosed = false
            p.hidesOnDeactivate = false
            p.isMovable = true
            p.isMovableByWindowBackground = true
            p.backgroundColor = .clear
            p.isOpaque = false
            p.hasShadow = true
            p.isRestorable = false
            p.animationBehavior = .none
            p.onEscape = { [weak self] in
                self?.hide()
            }

            let rootView = TranslationMainView(
                viewModel: viewModel,
                onPreferredHeightChange: { [weak self, weak p] height in
                    guard let self = self, let p = p else { return }
                    let targetHeight = max(Layout.minHeight, height)
                    if abs(p.frame.height - targetHeight) > 0.5 {
                        self.resize(p, toHeight: targetHeight)
                    }
                },
                onClose: { [weak self] in
                    self?.hide()
                }
            )
            .preferredColorScheme(.dark)

            p.contentViewController = NSHostingController(rootView: rootView)
            p.setContentSize(NSSize(width: Layout.width, height: Layout.minHeight))
            return p
        }
    }

    private func resize(_ p: NSPanel, toHeight targetHeight: CGFloat) {
        let currentFrame = p.frame
        let targetWidth = Layout.width
        let heightDiff = targetHeight - currentFrame.height
        let newOriginX = currentFrame.width > 50 ? currentFrame.origin.x : (currentScreen().visibleFrame.midX - targetWidth / 2)
        let newOrigin = NSPoint(x: newOriginX, y: currentFrame.origin.y - heightDiff)
        let newFrame = NSRect(origin: newOrigin, size: NSSize(width: targetWidth, height: targetHeight))
        p.setFrame(newFrame, display: true, animate: false)
    }

    private func center(_ p: NSPanel) {
        let screen = currentScreen()
        let screenRect = screen.visibleFrame
        let targetWidth = Layout.width
        let targetHeight = p.frame.height > 50 ? p.frame.height : Layout.minHeight
        let origin = NSPoint(
            x: screenRect.midX - targetWidth / 2,
            y: screenRect.midY - targetHeight / 2
        )
        p.setFrame(NSRect(origin: origin, size: NSSize(width: targetWidth, height: targetHeight)), display: true)
    }
}

final class TranslationSpotlightPanel: NSPanel {
    var onEscape: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }
}
