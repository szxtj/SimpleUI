import Cocoa
import WebKit

/// 窗口缩放时的全屏纯色尺寸指示遮罩（极速覆盖并冻结底层 WebKit 逐帧排版，彻底消除卡顿）。
///
/// 三个窗口共用（主窗口 / 3D 场景构建 / Markdown 编辑器），由 `WindowResizeChrome` 托管。
class ResizeOverlayView: NSView {
    private let pillView = NSView()
    private let dimensionLabel = NSTextField(labelWithString: "")
    private var fadeWorkItem: DispatchWorkItem?
    private var appIsDark: Bool?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        autoresizingMask = [.width, .height]
        isHidden = true
        alphaValue = 0

        pillView.wantsLayer = true
        pillView.translatesAutoresizingMaskIntoConstraints = false
        pillView.layer?.cornerRadius = 19.0
        pillView.layer?.masksToBounds = false
        addSubview(pillView)

        dimensionLabel.isBezeled = false
        dimensionLabel.drawsBackground = false
        dimensionLabel.isEditable = false
        dimensionLabel.isSelectable = false
        dimensionLabel.alignment = .center
        dimensionLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 18, weight: .semibold)
        dimensionLabel.translatesAutoresizingMaskIntoConstraints = false
        pillView.addSubview(dimensionLabel)

        NSLayoutConstraint.activate([
            pillView.centerXAnchor.constraint(equalTo: centerXAnchor),
            pillView.centerYAnchor.constraint(equalTo: centerYAnchor),
            pillView.heightAnchor.constraint(equalToConstant: 38),

            dimensionLabel.leadingAnchor.constraint(equalTo: pillView.leadingAnchor, constant: 20),
            dimensionLabel.trailingAnchor.constraint(equalTo: pillView.trailingAnchor, constant: -20),
            dimensionLabel.centerYAnchor.constraint(equalTo: pillView.centerYAnchor)
        ])

        if let stored = UserDefaults.standard.object(forKey: "simpleui_is_dark") as? Bool {
            self.appIsDark = stored
        }
        applyTheme()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // 关键：返回 nil 绝不拦截底层边框缩放/光标追踪/拖拽事件
    override func hitTest(_ point: NSPoint) -> NSView? {
        return nil
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        if appIsDark == nil {
            applyTheme()
        }
    }

    func setIsDarkMode(_ isDark: Bool) {
        self.appIsDark = isDark
        applyTheme()
    }

    private var isDarkMode: Bool {
        if let custom = appIsDark {
            return custom
        }
        if let match = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) {
            return match == .darkAqua
        }
        return effectiveAppearance.name.rawValue.contains("Dark")
    }

    func update(size: NSSize) {
        let w = Int(round(size.width))
        let h = Int(round(size.height))
        dimensionLabel.stringValue = "\(w) × \(h)"
    }

    private func applyTheme() {
        let dark = isDarkMode
        // 底色与窗口 WebKit 背景完全保持一致（Light: #f8f9fb / Dark: #18191c）
        layer?.backgroundColor = dark
            ? NSColor(red: 24/255.0, green: 25/255.0, blue: 28/255.0, alpha: 1.0).cgColor
            : NSColor(red: 248/255.0, green: 249/255.0, blue: 251/255.0, alpha: 1.0).cgColor

        // 胶囊卡片（Pill Container）
        pillView.layer?.backgroundColor = dark
            ? NSColor(red: 34/255.0, green: 36/255.0, blue: 42/255.0, alpha: 0.95).cgColor
            : NSColor(red: 255/255.0, green: 255/255.0, blue: 255/255.0, alpha: 0.96).cgColor

        pillView.layer?.borderWidth = 1.0
        pillView.layer?.borderColor = dark
            ? NSColor(white: 1.0, alpha: 0.12).cgColor
            : NSColor(white: 0.0, alpha: 0.08).cgColor

        pillView.layer?.shadowColor = NSColor.black.cgColor
        pillView.layer?.shadowOpacity = dark ? 0.35 : 0.08
        pillView.layer?.shadowOffset = CGSize(width: 0, height: -2)
        pillView.layer?.shadowRadius = dark ? 10.0 : 8.0

        dimensionLabel.textColor = dark
            ? NSColor(red: 241/255.0, green: 243/255.0, blue: 247/255.0, alpha: 1.0)
            : NSColor(red: 31/255.0, green: 35/255.0, blue: 40/255.0, alpha: 1.0)
    }

    func showInstant(size: NSSize) {
        fadeWorkItem?.cancel()
        fadeWorkItem = nil
        update(size: size)
        applyTheme()
        alphaValue = 1.0
        isHidden = false
    }

    func showAnimated(size: NSSize, duration: TimeInterval = 0.10) {
        fadeWorkItem?.cancel()
        fadeWorkItem = nil
        update(size: size)
        applyTheme()
        isHidden = false
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = duration
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            animator().alphaValue = 1.0
        }
    }

    func hideAnimated(delay: TimeInterval = 0.08, duration: TimeInterval = 0.27, completion: (() -> Void)? = nil) {
        fadeWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = duration
                ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                self.animator().alphaValue = 0.0
            }, completionHandler: {
                if self.alphaValue == 0.0 {
                    self.isHidden = true
                }
                completion?()
            })
        }
        fadeWorkItem = work
        if delay > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        } else {
            work.perform()
        }
    }
}

/// 窗口尺寸变化的**一整套体验**，三个窗口共用（主窗口 / 3D 场景构建 / Markdown 编辑器）。
///
/// 四个场景：
///   1. **实时拉伸**（拖边框）：撕掉 webView 的 autoresizingMask（否则中间几十上百次鼠标移动
///      会逐帧触发 WebKit 重排），遮罩逐帧更新 `W × H`；松手后才做一次最终排版再淡出。
///   2. **非交互跳变**（系统分屏 / Magnet / 显示器切换 / 代码 setFrame）：瞬时拉起遮罩遮住单次重排。
///   3. **放大 / 缩小**：双击标题栏或点绿色按钮 → `toggleZoomAnimated()`，记忆原尺寸后再还原，
///      全程走遮罩（原生 `performZoom` 没有这层保护，WebKit 会明显卡一下）。
///   4. **缩放态拖标题栏**：先还原到记忆的原尺寸再续拖，光标相对标题栏的位置保持不变。
///
/// 内部触发的帧变化（如侧边栏伸缩）用 `performInternalFrameChange { }` 包起来，避免误显遮罩。
///
/// 窗口控制器只需在自己的 NSWindowDelegate 里转发四个回调，并把标题栏拖拽视图的
/// `resizeChrome` 指向本对象（双击缩放、拖拽还原都在那里生效）。
final class WindowResizeChrome {
    /// 缩放动画的前置延时：先让遮罩完全盖住，再动窗口（原实现就是 0.12s）
    private static let zoomTransitionDelay: TimeInterval = 0.12

    private weak var window: NSWindow?
    private weak var webView: WKWebView?
    private(set) var overlay: ResizeOverlayView!

    /// 双击缩放前的原帧（自定义 zoom 态，替代 performZoom）
    private var preZoomFrame: NSRect?
    private var zoomWorkItem: DispatchWorkItem?
    /// 内部帧切换计数（用计数而不是 Bool：允许嵌套，且不会被外层提前复位）
    private var internalFrameChanges = 0

    init?(window: NSWindow, webView: WKWebView, above: NSView?) {
        guard let contentView = window.contentView else { return nil }
        self.window = window
        self.webView = webView
        overlay = ResizeOverlayView(frame: contentView.bounds)
        contentView.addSubview(overlay, positioned: .above, relativeTo: above)
    }

    func setIsDarkMode(_ isDark: Bool) {
        overlay.setIsDarkMode(isDark)
    }

    // MARK: - 实时拉伸

    func windowWillStartLiveResize() {
        guard let win = window else { return }
        // 1. 暂时剥离 webView 的自适应，避免中间几十次鼠标移动逐帧触发 WebKit 重排
        webView?.autoresizingMask = []
        // 2. 快速淡入纯色尺寸遮罩
        overlay.showAnimated(size: win.frame.size, duration: 0.10)
    }

    func windowDidResize() {
        guard let win = window, let contentView = win.contentView else { return }
        if win.inLiveResize {
            overlay.update(size: win.frame.size)
        } else if overlay.isHidden && internalFrameChanges == 0 {
            // 只要有尺寸变化就加遮罩（系统分屏 / Magnet / Rectangle / 显示器切换等跳变）
            webView?.autoresizingMask = []
            overlay.showInstant(size: win.frame.size)
            webView?.frame = contentView.bounds
            webView?.autoresizingMask = [.width, .height]
            overlay.hideAnimated(delay: 0.08, duration: 0.24)
        }
    }

    func windowDidEndLiveResize() {
        guard let win = window, let contentView = win.contentView else { return }
        // 1. 一次性设置到最终尺寸并恢复自适应，整个拖拽过程只触发 1 次最终排版
        webView?.frame = contentView.bounds
        webView?.autoresizingMask = [.width, .height]
        // 2. 等 WebKit 单次重排绘制完成后平滑淡出
        overlay.hideAnimated(delay: 0.08, duration: 0.27)
    }

    // MARK: - 放大 / 缩小

    var isZoomed: Bool { preZoomFrame != nil }

    func cancelZoomAnimation() {
        zoomWorkItem?.cancel()
        zoomWorkItem = nil
    }

    /// 取走记忆的原尺寸（拖动还原用）；取走即清空，避免重复还原到过期帧
    func consumePreZoomFrame() -> NSRect? {
        defer { preZoomFrame = nil }
        return preZoomFrame
    }

    func toggleZoomAnimated() {
        guard let win = window, let screen = win.screen ?? NSScreen.main else { return }
        // 原生全屏态下不做自定义缩放（全屏有自己的进出场动画）
        guard !win.styleMask.contains(.fullScreen) else { return }

        cancelZoomAnimation()

        let startFrame = win.frame
        let targetFrame: NSRect
        if let restore = preZoomFrame {
            // 已是缩放态 → 回到之前的尺寸
            targetFrame = restore
            preZoomFrame = nil
        } else {
            preZoomFrame = startFrame
            targetFrame = screen.visibleFrame
        }
        guard startFrame != targetFrame else { return }

        // 极速遮罩过渡：留存时间比实时拉伸更长，彻底盖住窗口放大/还原过程中的重排
        webView?.autoresizingMask = []
        overlay.showAnimated(size: targetFrame.size, duration: 0.12)

        let work = DispatchWorkItem { [weak self] in
            guard let self = self, let win = self.window, let contentView = win.contentView else { return }
            self.performInternalFrameChange {
                win.setFrame(targetFrame, display: false)
            }
            self.webView?.frame = contentView.bounds
            self.webView?.autoresizingMask = [.width, .height]
            self.overlay.hideAnimated(delay: 0.08, duration: 0.24)
        }
        zoomWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.zoomTransitionDelay, execute: work)
    }

    /// 绿色交通灯：接管成与双击一致的动画缩放（返回 false 阻止系统的 performZoom）
    func handleWindowShouldZoom() -> Bool {
        toggleZoomAnimated()
        return false
    }

    // MARK: - 缩放态拖标题栏还原

    /// 缩放态下拖标题栏：位移超过阈值就还原到记忆的原尺寸。
    /// - Returns: 还原后的新帧（调用方据此续拖）；未还原时为 nil。
    @discardableResult
    func unzoomForTitleBarDrag(at mouse: NSPoint, start: NSPoint, threshold: CGFloat = 4) -> NSRect? {
        guard let win = window, let restoreFrame = preZoomFrame else { return nil }
        let dx = mouse.x - start.x
        let dy = mouse.y - start.y
        guard sqrt(dx * dx + dy * dy) >= threshold else { return nil }

        preZoomFrame = nil
        var restore = restoreFrame
        restore.size.width = max(restore.width, win.minSize.width)
        restore.size.height = max(restore.height, win.minSize.height)
        // 光标在标题栏上的相对水平位置、距顶边高度都保持不变（与原生 macOS 一致）
        let relativeX = (mouse.x - win.frame.minX) / max(win.frame.width, 1)
        let topOffset = win.frame.maxY - mouse.y
        restore.origin.x = mouse.x - restore.width * relativeX
        restore.origin.y = mouse.y - restore.height + topOffset

        applyFrameWithOverlay(restore)
        return restore
    }

    // MARK: - 内部帧切换

    /// 应用目标帧并带遮罩（非交互式跳变的通用入口）
    func applyFrameWithOverlay(
        _ target: NSRect,
        fadeDelay: TimeInterval = 0.08,
        fadeDuration: TimeInterval = 0.24
    ) {
        guard let win = window, let contentView = win.contentView else { return }
        webView?.autoresizingMask = []
        overlay.showInstant(size: target.size)
        performInternalFrameChange {
            win.setFrame(target, display: false)
        }
        webView?.frame = contentView.bounds
        webView?.autoresizingMask = [.width, .height]
        overlay.hideAnimated(delay: fadeDelay, duration: fadeDuration)
    }

    /// 内部触发的帧变化：不显示遮罩
    func performInternalFrameChange(_ body: () -> Void) {
        internalFrameChanges += 1
        body()
        internalFrameChanges -= 1
    }

    func beginInternalFrameChange() {
        internalFrameChanges += 1
    }

    func endInternalFrameChange() {
        internalFrameChanges = max(0, internalFrameChanges - 1)
    }
}


/// 独立窗口的「全屏下关窗」兜底 —— 处理逻辑提取自主窗口的 windowShouldClose，供所有共用窗口复用。
///
/// 背景：原生全屏下直接 orderOut 会把全屏 Space 留在屏幕上（表现为整面黑屏，App 还活着）。
/// macOS 惯例是先退全屏、动画收完再隐藏窗口 —— 由 `didExitFullScreen` 通知收尾。
///
/// 用法（三个独立窗口同构）：
/// 1. makePanel 里 `fullscreenCloser = FullscreenAwareCloser(window: p)`，
///    需要收尾动作（停索引 / 卸载模型）的窗口设置 `onClosed`；
/// 2. windowShouldClose 里**最先**调用 `handleCloseRequest()`：返回 true 表示已代为
///    启动退全屏动画，本轮直接 return false，不要 orderOut。
final class FullscreenAwareCloser {
    /// 延迟关窗的收尾动作（如：请求服务释放 / 停索引 + 卸载模型），在窗口真正隐藏前执行
    var onClosed: (() -> Void)?

    private weak var window: NSWindow?
    private var pendingCloseAfterFullscreenExit = false
    private var exitObserver: (any NSObjectProtocol)?

    init(window: NSWindow) {
        self.window = window
        exitObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didExitFullScreenNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            guard let self = self, self.pendingCloseAfterFullscreenExit else { return }
            self.pendingCloseAfterFullscreenExit = false
            // 等系统跑完 Space 收起的收尾帧，再隐藏窗口并执行各窗口自己的收尾
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                guard let self = self else { return }
                self.onClosed?()
                self.window?.orderOut(nil)
            }
        }
    }

    deinit {
        if let exitObserver = exitObserver {
            NotificationCenter.default.removeObserver(exitObserver)
        }
    }

    /// 在 windowShouldClose 里最先调用。返回 true 表示窗口当前处于原生全屏、
    /// 已代为启动退全屏动画 —— 本轮不要 orderOut（否则黑屏 Space 残留）。
    func handleCloseRequest() -> Bool {
        guard let win = window else { return false }
        guard win.styleMask.contains(.fullScreen) else { return false }
        pendingCloseAfterFullscreenExit = true
        win.toggleFullScreen(nil)
        return true
    }
}
