import AppKit
import SwiftUI

public final class TranslationPanelController {
    private enum Layout {
        static let width: CGFloat = 620
        static let minHeight: CGFloat = 290
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

        // 每次重新打开均强制全屏居中归位
        center(p)

        // 保持独立浮动且不激活主应用程序（与主窗口严格解耦，不拉起后台的主窗口）
        p.makeKeyAndOrderFront(nil)
        p.orderFrontRegardless()
        focusInput()
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

    private func makePanel() -> TranslationSpotlightPanel {
        return MainActor.assumeIsolated {
            let p = TranslationSpotlightPanel(
                contentRect: NSRect(x: 0, y: 0, width: Layout.width, height: Layout.minHeight),
                styleMask: [.titled, .nonactivatingPanel, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )

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
            p.onEscape = { [weak self] in
                self?.hide()
            }

            let isDark = UserDefaults.standard.object(forKey: "simpleui_is_dark") as? Bool ?? false
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
            .preferredColorScheme(isDark ? .dark : .light)

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
