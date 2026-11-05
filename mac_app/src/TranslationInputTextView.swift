import AppKit
import SwiftUI

struct TranslationInputTextView: NSViewRepresentable {
    @Binding var text: String

    let focusToken: Int
    let isEditable: Bool
    let onSubmit: () -> Void
    let onEscape: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder

        let contentSize = scrollView.contentSize
        let textView = InnerTranslatorTextView(frame: NSRect(origin: .zero, size: contentSize))
        textView.minSize = NSSize(width: 0, height: contentSize.height)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]

        textView.textContainer?.containerSize = NSSize(width: contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true

        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.backgroundColor = .clear
        textView.font = .systemFont(ofSize: 15)
        textView.textColor = .white
        textView.insertionPointColor = .white
        textView.delegate = context.coordinator
        textView.string = text
        textView.textContainerInset = NSSize(width: 8, height: 10)
        textView.allowsUndo = true
        textView.onSubmit = onSubmit
        textView.onEscape = onEscape

        scrollView.documentView = textView
        context.coordinator.textView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = context.coordinator.textView else { return }

        if textView.string != text {
            textView.string = text
        }

        textView.textColor = .white
        textView.isEditable = isEditable
        textView.onSubmit = onSubmit
        textView.onEscape = onEscape

        if context.coordinator.lastFocusToken != focusToken {
            context.coordinator.lastFocusToken = focusToken
            DispatchQueue.main.async {
                scrollView.window?.makeFirstResponder(textView)
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TranslationInputTextView
        weak var textView: InnerTranslatorTextView?
        var lastFocusToken: Int = -1

        init(_ parent: TranslationInputTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            parent.text = textView?.string ?? ""
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            let modifiers = NSApp.currentEvent?.modifierFlags.intersection(.deviceIndependentFlagsMask) ?? []
            let imeEnter = (textView as? InnerTranslatorTextView)?.shouldIgnoreEnterForIme ?? false

            switch commandSelector {
            case #selector(NSResponder.insertNewline(_:)):
                // 输入管理器也可能不经 keyDown 直接派发 insertNewline: —— 合成态/级联回车
                // 一律吞掉：既不翻译，也不在候选词上屏后多插一个换行。
                if imeEnter { return true }
                if modifiers.contains(.command) {
                    textView.insertNewline(nil)
                } else {
                    parent.onSubmit()
                }
                return true
            case #selector(NSResponder.insertLineBreak(_:)),
                 #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
                textView.insertNewline(nil)
                return true
            case #selector(NSResponder.cancelOperation(_:)):
                parent.onEscape()
                return true
            default:
                return false
            }
        }
    }
}

final class InnerTranslatorTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onEscape: (() -> Void)?

    /// 输入法（中/日/韩）合成态。
    ///
    /// 旧实现无条件拦截 `keyDown(36/76)` → `onSubmit()`，于是在输入法里按回车确认候选词时，
    /// 会拿**合成前**的 inputText 去翻译（用户看到的就是「翻译了上次输入的内容」）。
    /// 这里对齐主界面对话输入框 `useImeInput` 的双锁逻辑：
    ///   1. 合成中（setMarkedText 起、unmarkText/insertText 止）→ 回车交还输入管理器让候选词上屏；
    ///   2. 合成刚结束的极短窗口内到达的回车属于同一次物理按键的级联事件 → 吞掉，
    ///      既不翻译也不插换行（对应 WebKit 端 compositionend 早于 keydown 的时序坑）；
    ///   3. 其余正常回车才走 onSubmit（保留「生成中按回车终止翻译」的原行为）。
    private var isComposingText = false
    private var lastMarkedTextUptime: TimeInterval = 0
    private var lastCompositionEndUptime: TimeInterval = 0
    private let compositionEndGrace: TimeInterval = 0.08
    private let compositionStaleTimeout: TimeInterval = 3.0

    private static var uptime: TimeInterval { ProcessInfo.processInfo.systemUptime }

    /// 回车是否属于输入法合成态的级联事件。
    var shouldIgnoreEnterForIme: Bool {
        // 生成中输入框不可编辑，不可能处于合成态；回车仍要能终止翻译。
        guard isEditable else { return false }
        reconcileCompositionState()
        if isComposingText || hasMarkedText() { return true }
        return Self.uptime - lastCompositionEndUptime < compositionEndGrace
    }

    /// 失焦 / 取消合成时输入管理器可能不发 unmarkText；超时自动解锁，避免回车永久失效。
    private func reconcileCompositionState() {
        if isComposingText && !hasMarkedText()
            && Self.uptime - lastMarkedTextUptime > compositionStaleTimeout
        {
            isComposingText = false
        }
    }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        isComposingText = true
        lastMarkedTextUptime = Self.uptime
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
    }

    override func unmarkText() {
        endComposition()
        super.unmarkText()
    }

    override func insertText(_ string: Any, replacementRange: NSRange) {
        // 部分输入法不调用 unmarkText，直接 insertText 提交候选词。
        if isComposingText { endComposition() }
        super.insertText(string, replacementRange: replacementRange)
    }

    private func endComposition() {
        isComposingText = false
        lastCompositionEndUptime = Self.uptime
    }

    override func keyDown(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let isEnterKey = event.keyCode == 36 || event.keyCode == 76
        let hasSubmitModifiers = modifiers.contains(.command) || modifiers.contains(.control)

        if isEnterKey && !hasSubmitModifiers {
            reconcileCompositionState()

            // 合成中（含 Shift+Enter）：回车必须交还 NSTextInputContext，让候选词正常上屏。
            if isComposingText || hasMarkedText() {
                super.keyDown(with: event)
                return
            }

            // Shift + Enter: 在可编辑状态下插入换行符
            if modifiers.contains(.shift) {
                if isEditable {
                    insertText("\n", replacementRange: selectedRange())
                }
                return
            }

            // 单按 Enter（回车键或小键盘回车键，无 Command/Control 修饰键）：
            // 无论是在就绪状态（触发翻译）还是在生成中（触发终止），均由 onSubmit 处理，避免禁用状态下系统发出嘟嘟报警音
            // 合成刚结束的级联回车在此被吞掉，既不翻译也不插换行。
            guard !shouldIgnoreEnterForIme else { return }
            onSubmit?()
            return
        }

        super.keyDown(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }
}
