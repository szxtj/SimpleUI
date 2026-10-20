import AppKit
import SwiftUI

public final class TranslationPanelController: NSObject {
    private enum Layout {
        static let width: CGFloat = 620
        static let minHeight: CGFloat = 336
    }

    private let viewModel: TranslationViewModel
    private var panel: TranslationSpotlightPanel?

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

    private func performShow() {
        let p = panel ?? makePanel()
        self.panel = p

        MainActor.assumeIsolated {
            viewModel.refreshLocaleAndSettings()
        }

        // 每次重新打开均强制全屏居中归位
        center(p)

        // 保持独立浮动且不激活主应用程序（与主窗口严格解耦，不拉起后台的主窗口）
        p.makeKeyAndOrderFront(nil)
        p.orderFrontRegardless()
        focusInput()
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
        performShow()

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
