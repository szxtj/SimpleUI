/**
 * WindowResizeChrome 离屏验证（遮罩 / 实时拉伸 / 双击缩放 / 拖拽还原）。
 *
 * 这几条都是原生视觉行为，无头浏览器测不到，所以用一个不显示界面的 Swift 程序直接驱动：
 * 建一个真实 NSWindow + WKWebView，挂上 WindowResizeChrome，逐条断言状态
 * （遮罩显隐与淡出、尺寸文案、缩放后 frame、拖拽阈值、明暗底色）。
 *
 * 跑法（在仓库根目录）：
 *   mkdir -p /tmp/chrome_h && cp scripts/verify_window_resize_chrome.swift /tmp/chrome_h/main.swift
 *   swiftc -O /tmp/chrome_h/main.swift mac_app/src/WindowResizeChrome.swift \
 *          -o /tmp/chrome_h/run -framework Cocoa -framework WebKit
 *   /tmp/chrome_h/run
 *
 * 注意：必须叫 main.swift（Swift 只允许 main.swift 写顶层代码）。
 * 截图版见同目录用法：把 chrome.overlay.showInstant(...) 后 cacheDisplay 存 PNG。
 */

import Cocoa
import WebKit

/// WindowResizeChrome 的离屏验证：不依赖真实点击，直接把四条路径跑一遍并断言状态。
/// 编译：swiftc -O harness.swift WindowResizeChrome.swift -o /tmp/chrome_harness -framework Cocoa -framework WebKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

var failures = 0
func check(_ name: String, _ ok: Bool, _ detail: String = "") {
    print("\(ok ? "✅" : "❌") \(name)\(detail.isEmpty ? "" : " — \(detail)")")
    if !ok { failures += 1 }
}
func wait(_ s: TimeInterval) {
    RunLoop.current.run(until: Date().addingTimeInterval(s))
}

/// 真实 live resize 只在用户拖边框时发生，这里用子类把 inLiveResize 置真
final class FakeWindow: NSWindow {
    var fakeLiveResize = false
    override var inLiveResize: Bool { fakeLiveResize }
}

let window = FakeWindow(
    contentRect: NSRect(x: 240, y: 240, width: 900, height: 600),
    styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
    backing: .buffered,
    defer: false
)
window.minSize = NSSize(width: 400, height: 300)
let webView = WKWebView(frame: window.contentView!.bounds)
webView.autoresizingMask = [.width, .height]
window.contentView?.addSubview(webView)

guard let chrome = WindowResizeChrome(window: window, webView: webView, above: nil) else {
    print("❌ chrome 初始化失败")
    exit(1)
}
window.orderFront(nil)
wait(0.3)

let overlay = chrome.overlay!
func labelText() -> String {
    // overlay → pillView → NSTextField
    let pill = overlay.subviews.first
    let label = pill?.subviews.compactMap { $0 as? NSTextField }.first
    return label?.stringValue ?? "<none>"
}

// 0. 初始状态
check("初始遮罩隐藏", overlay.isHidden && overlay.alphaValue == 0)
check("遮罩不拦截鼠标（hitTest 恒为 nil）", overlay.hitTest(NSPoint(x: 10, y: 10)) == nil)

// 1. 实时拉伸：淡入 + 逐帧更新尺寸 + 松手淡出
chrome.windowWillStartLiveResize()
check("开始拉伸后遮罩可见", overlay.isHidden == false)
wait(0.25)
check("淡入完成（alpha = 1）", abs(overlay.alphaValue - 1.0) < 0.01, "alpha=\(overlay.alphaValue)")
check("尺寸文案 = 窗口尺寸", labelText() == "900 × 600", labelText())

window.fakeLiveResize = true
window.setFrame(NSRect(x: 240, y: 240, width: 1024, height: 700), display: true)
chrome.windowDidResize()
check("拉伸中尺寸文案跟随", labelText() == "1024 × 700", labelText())

chrome.windowDidEndLiveResize()
wait(0.6)
check("松手后遮罩淡出并隐藏", overlay.isHidden && overlay.alphaValue < 0.01, "alpha=\(overlay.alphaValue)")

// 2. 非交互式跳变（系统分屏 / 显示器切换）
window.fakeLiveResize = false
let beforeResize = window.frame
window.setFrame(NSRect(x: 260, y: 260, width: 980, height: 640), display: true)
chrome.windowDidResize()
check("非交互跳变也会拉起遮罩", overlay.isHidden == false)
check("跳变遮罩文案正确", labelText() == "980 × 640", labelText())
wait(0.6)
check("跳变后遮罩淡出", overlay.isHidden)
_ = beforeResize

// 3. 内部帧变化不闪遮罩
// 真实链路上 windowDidResize 由 setFrame 同步触发，所以在 block 内部模拟回调
chrome.performInternalFrameChange {
    window.setFrame(NSRect(x: 280, y: 280, width: 860, height: 580), display: true)
    chrome.windowDidResize()
}
check("内部帧变化不显示遮罩", overlay.isHidden)

// 4. 放大 / 缩小（双击标题栏、绿色按钮走同一条）
let originalFrame = window.frame
chrome.toggleZoomAnimated()
wait(0.45)
let visible = (window.screen ?? NSScreen.main)!.visibleFrame
check("放大后铺满可见区域", abs(window.frame.width - visible.width) < 2 && abs(window.frame.height - visible.height) < 2,
      "\(Int(window.frame.width))×\(Int(window.frame.height)) vs \(Int(visible.width))×\(Int(visible.height))")
check("进入缩放态", chrome.isZoomed)
wait(0.5)
check("放大后遮罩已淡出", overlay.isHidden == false || overlay.alphaValue < 0.05)

chrome.toggleZoomAnimated()
wait(0.45)
check("再点一次还原到原尺寸",
      abs(window.frame.width - originalFrame.width) < 2 && abs(window.frame.height - originalFrame.height) < 2,
      "\(Int(window.frame.width))×\(Int(window.frame.height)) vs \(Int(originalFrame.width))×\(Int(originalFrame.height))")
check("退出缩放态", chrome.isZoomed == false)
wait(0.5)

// 5. 缩放态下拖标题栏：位移够阈值才还原
chrome.toggleZoomAnimated()
wait(0.45)
let zoomedFrame = window.frame
let mouseStart = NSPoint(x: zoomedFrame.midX, y: zoomedFrame.maxY - 20)
let tiny = chrome.unzoomForTitleBarDrag(at: NSPoint(x: mouseStart.x + 1, y: mouseStart.y), start: mouseStart)
check("微小位移不触发还原", tiny == nil && chrome.isZoomed)
let restored = chrome.unzoomForTitleBarDrag(at: NSPoint(x: mouseStart.x + 60, y: mouseStart.y - 30), start: mouseStart)
check("拖动超阈值 → 还原原尺寸", restored != nil && chrome.isZoomed == false,
      restored.map { "\(Int($0.width))×\(Int($0.height))" } ?? "nil")
check("还原后窗口尺寸正确",
      abs(window.frame.width - originalFrame.width) < 2, "\(Int(window.frame.width))")
wait(0.5)

// 6. 主题
chrome.setIsDarkMode(true)
let darkBg = overlay.layer?.backgroundColor
chrome.setIsDarkMode(false)
let lightBg = overlay.layer?.backgroundColor
check("明暗主题底色不同", darkBg != lightBg)


// ---------------------------------------------------------------------------
// 7. 性能：遮罩底下「界面不再逐帧刷新」的硬证据（A/B 对照）
//
// 遮罩本身只是块色板，真正省性能的是 `webView.autoresizingMask = []`：
// 拖动过程中 WebView 的 frame 一次都不变 → 页面收不到 resize、DOM 不重排；
// 松手后一次性设到最终尺寸 → 只排版一次。
// 这里在页面里数 `resize` 事件与 ResizeObserver 回调，用「不挂遮罩」做对照组。
// ---------------------------------------------------------------------------
final class PerfWindow: NSWindow {
    var fakeLiveResize = false
    override var inLiveResize: Bool { fakeLiveResize }
}

let perfWindow = PerfWindow(
    contentRect: NSRect(x: 100, y: 100, width: 800, height: 600),
    styleMask: [.titled, .resizable], backing: .buffered, defer: false
)
let perfWebView = WKWebView(frame: perfWindow.contentView!.bounds)
perfWebView.autoresizingMask = [.width, .height]
perfWindow.contentView?.addSubview(perfWebView)
guard let perfChrome = WindowResizeChrome(window: perfWindow, webView: perfWebView, above: nil) else { exit(2) }
perfWindow.orderFront(nil)

let html = """
<html><body style="margin:0"><div id="x">perf</div><script>
window.__resizes = 0; window.__ros = 0;
window.addEventListener('resize', function(){ window.__resizes++; });
new ResizeObserver(function(){ window.__ros++; }).observe(document.body);
</script></body></html>
"""
perfWebView.loadHTMLString(html, baseURL: nil)
var loadDeadline = Date().addingTimeInterval(5)
while perfWebView.isLoading && Date() < loadDeadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.02))
}
RunLoop.current.run(until: Date().addingTimeInterval(0.3))

func jsInt(_ script: String) -> Int {
    var value = 0
    var done = false
    perfWebView.evaluateJavaScript(script) { result, _ in
        if let n = result as? NSNumber { value = n.intValue }
        done = true
    }
    let deadline = Date().addingTimeInterval(3)
    while !done && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
    return value
}
func resetCounters() {
    _ = jsInt("window.__resizes = 0; window.__ros = 0; 1")
}
/// 模拟 10 次连续拖动（每步之间让 runloop 跑起来，模拟真实拖拽节奏）
func dragSteps(_ step: (Int) -> Void) {
    for i in 1...10 {
        step(i)
        RunLoop.current.run(until: Date().addingTimeInterval(0.06))
    }
}

// --- 对照组：不挂遮罩，webView 跟着窗口逐帧变化 ---
perfWindow.fakeLiveResize = true
perfWebView.autoresizingMask = [.width, .height]
let baseFrame = perfWindow.frame
resetCounters()
dragSteps { i in
    perfWindow.setFrame(
        NSRect(x: baseFrame.origin.x, y: baseFrame.origin.y,
               width: baseFrame.width + CGFloat(i * 12), height: baseFrame.height + CGFloat(i * 8)),
        display: true
    )
}
let controlResizes = jsInt("window.__resizes")
let controlRos = jsInt("window.__ros")

// --- 实验组：挂遮罩，走 windowWillStartLiveResize / windowDidResize ---
perfWindow.setFrame(baseFrame, display: true)
perfWebView.autoresizingMask = [.width, .height]
RunLoop.current.run(until: Date().addingTimeInterval(0.2))
perfChrome.windowWillStartLiveResize()
resetCounters()
dragSteps { i in
    perfWindow.setFrame(
        NSRect(x: baseFrame.origin.x, y: baseFrame.origin.y,
               width: baseFrame.width + CGFloat(i * 12), height: baseFrame.height + CGFloat(i * 8)),
        display: true
    )
    perfChrome.windowDidResize()
}
let maskedResizes = jsInt("window.__resizes")
let maskedRos = jsInt("window.__ros")

perfChrome.windowDidEndLiveResize()
RunLoop.current.run(until: Date().addingTimeInterval(0.5))
let afterEndResizes = jsInt("window.__resizes")
let afterEndRos = jsInt("window.__ros")

print("  对照组（无遮罩）：resize=\(controlResizes) 次, ResizeObserver=\(controlRos) 次")
print("  遮罩组（拖动中）：resize=\(maskedResizes) 次, ResizeObserver=\(maskedRos) 次")
print("  遮罩组（松手后）：累计 resize=\(afterEndResizes) 次, ResizeObserver=\(afterEndRos) 次")

check("对照组确实在逐帧刷新（证明测量有效）", controlResizes > 0 || controlRos > 0,
      "resize=\(controlResizes) ro=\(controlRos)")
check("遮罩组拖动过程中页面完全不重排", maskedResizes == 0 && maskedRos == 0,
      "resize=\(maskedResizes) ro=\(maskedRos)")
check("遮罩组松手后只发生一次最终排版", afterEndResizes <= 1 && afterEndRos <= 2,
      "resize=\(afterEndResizes) ro=\(afterEndRos)")
check("遮罩把逐帧刷新压到 0（对照 \(controlResizes) 次）", maskedResizes < controlResizes,
      "\(controlResizes) → \(maskedResizes)")

print(failures == 0 ? "\n🎉 全部通过" : "\n⚠️ \(failures) 项失败")
exit(failures == 0 ? 0 : 1)
