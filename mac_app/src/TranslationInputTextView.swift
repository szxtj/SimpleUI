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

            switch commandSelector {
            case #selector(NSResponder.insertNewline(_:)):
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

    override func keyDown(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

        // Shift + Enter: 在可编辑状态下插入换行符
        if modifiers.contains(.shift), (event.keyCode == 36 || event.keyCode == 76) {
            if isEditable {
                insertText("\n", replacementRange: selectedRange())
            }
            return
        }

        // 单按 Enter（回车键或小键盘回车键，无 Command/Control 修饰键）：
        // 无论是在就绪状态（触发翻译）还是在生成中（触发终止），均由 onSubmit 处理，避免禁用状态下系统发出嘟嘟报警音
        if (event.keyCode == 36 || event.keyCode == 76) && !modifiers.contains(.command) && !modifiers.contains(.control) {
            onSubmit?()
            return
        }

        super.keyDown(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }
}
