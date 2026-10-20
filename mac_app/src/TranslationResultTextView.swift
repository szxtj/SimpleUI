import AppKit
import SwiftUI

/// 翻译面板始终是深色外观，结果区使用固定的浅色，避免跟随系统/主应用主题变成黑字。
private enum ResultColors {
    static let text = NSColor.white
    static let secondaryText = NSColor.white.withAlphaComponent(0.70)
    static let placeholder = NSColor.white.withAlphaComponent(0.45)
    static let rule = NSColor.white.withAlphaComponent(0.35)
    static let codeBackground = NSColor.white.withAlphaComponent(0.08)
    static let inlineCodeBackground = NSColor.white.withAlphaComponent(0.12)
    static let link = NSColor(calibratedRed: 0.42, green: 0.68, blue: 1.0, alpha: 1.0)
}

/// 翻译结果区：用 NSTextView 承载可选中文本，并把当前选区回传给 SwiftUI。
/// SwiftUI 自带的 `.textSelection(.enabled)` 无法把选中范围暴露出来，因此这里用原生文本视图。
struct TranslationResultTextView: NSViewRepresentable {
    let text: String
    let placeholder: String
    @Binding var selectedText: String
    /// 由外部递增，用于强制清空 NSTextView 里的选区（新结果、切换模式、关闭窗口等）。
    let resetToken: Int
    let onSubmit: () -> Void
    let onEscape: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true

        let contentSize = scrollView.contentSize
        let textView = SelectableResultTextView(frame: NSRect(origin: .zero, size: contentSize))
        textView.minSize = NSSize(width: 0, height: contentSize.height)
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(
            width: contentSize.width,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainerInset = NSSize(width: 12, height: 10)

        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.focusRingType = .none
        textView.allowsUndo = false
        textView.isAutomaticDataDetectionEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.font = .systemFont(ofSize: 13)
        textView.textColor = ResultColors.text
        textView.linkTextAttributes = [
            .foregroundColor: ResultColors.link,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
        // 轻微的强调色选区，配合外层容器边框一起提示「已选中」。
        textView.selectedTextAttributes = [
            .backgroundColor: NSColor.controlAccentColor.withAlphaComponent(0.24)
        ]
        textView.delegate = context.coordinator
        textView.onSubmit = { [weak coordinator = context.coordinator] in
            coordinator?.parent.onSubmit()
        }
        textView.onEscape = { [weak coordinator = context.coordinator] in
            coordinator?.parent.onEscape()
        }

        scrollView.documentView = textView
        context.coordinator.textView = textView
        context.coordinator.apply(
            text: text,
            placeholder: placeholder,
            resetToken: resetToken,
            force: true
        )
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.apply(
            text: text,
            placeholder: placeholder,
            resetToken: resetToken,
            force: false
        )
    }

    static func dismantleNSView(_ nsView: NSScrollView, coordinator: Coordinator) {
        coordinator.textView?.delegate = nil
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TranslationResultTextView
        weak var textView: SelectableResultTextView?
        private var lastDisplayText: String?
        private var lastResetToken: Int
        private var isProgrammaticUpdate = false

        init(_ parent: TranslationResultTextView) {
            self.parent = parent
            self.lastResetToken = parent.resetToken
        }

        func apply(text: String, placeholder: String, resetToken: Int, force: Bool) {
            guard let textView = textView else { return }

            let displayText = text.isEmpty ? placeholder : text
            let shouldReplace = force || lastDisplayText != displayText
            let shouldResetSelection = force || lastResetToken != resetToken

            if shouldReplace {
                isProgrammaticUpdate = true
                // textColor 会覆盖文本里已有的前景色，必须先设置默认色，再写入富文本。
                textView.textColor = ResultColors.text
                if text.isEmpty {
                    textView.textStorage?.setAttributedString(Self.placeholderAttributed(placeholder))
                    textView.isSelectable = false
                } else {
                    textView.textStorage?.setAttributedString(Self.renderedAttributed(text))
                    textView.isSelectable = true
                }
                textView.setSelectedRange(NSRange(location: 0, length: 0))
                textView.scrollRangeToVisible(NSRange(location: 0, length: 0))
                isProgrammaticUpdate = false

                lastDisplayText = displayText
            }

            if shouldResetSelection {
                isProgrammaticUpdate = true
                textView.setSelectedRange(NSRange(location: 0, length: 0))
                isProgrammaticUpdate = false
            }

            lastResetToken = resetToken
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard !isProgrammaticUpdate, let textView = textView else { return }

            let range = textView.selectedRange()
            let selected =
                range.length > 0
                ? (textView.string as NSString).substring(with: range)
                : ""
            let trimmed = selected.trimmingCharacters(in: .whitespacesAndNewlines)
            guard parent.selectedText != trimmed else { return }

            let resetToken = parent.resetToken
            // 选区变化来自用户事件；异步回写，避免在 SwiftUI 视图更新周期内直接改状态。
            // 同时校验 resetToken 和当前真实选区，防止清空动作被迟到的选区回调覆盖。
            DispatchQueue.main.async { [weak self] in
                guard let self = self, self.parent.resetToken == resetToken else { return }
                guard let textView = self.textView else { return }
                let currentRange = textView.selectedRange()
                let current =
                    currentRange.length > 0
                    ? (textView.string as NSString).substring(with: currentRange)
                    : ""
                let currentTrimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
                guard currentTrimmed == trimmed, self.parent.selectedText != trimmed else { return }
                self.parent.selectedText = trimmed
            }
        }

        private static func placeholderAttributed(_ text: String) -> NSAttributedString {
            NSAttributedString(
                string: text,
                attributes: [
                    .font: NSFont.systemFont(ofSize: 13),
                    .foregroundColor: ResultColors.placeholder,
                ]
            )
        }

        private static let bodyFont = NSFont.systemFont(ofSize: 13)

        /// 只处理最基本的 Markdown：标题、列表、引用、代码块、分割线，
        /// 以及粗体、斜体、行内代码、删除线和链接。表格和多级标题按普通文本显示。
        private static func renderedAttributed(_ markdown: String) -> NSAttributedString {
            let result = NSMutableAttributedString()
            let lines = markdown.components(separatedBy: "\n")
            var codeLines: [String] = []
            var inCodeBlock = false

            for line in lines {
                let trimmed = line.trimmingCharacters(in: .whitespaces)

                if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                    if inCodeBlock {
                        appendCodeBlock(codeLines, to: result)
                        codeLines.removeAll()
                        inCodeBlock = false
                    } else {
                        inCodeBlock = true
                        codeLines.removeAll()
                    }
                    continue
                }

                if inCodeBlock {
                    codeLines.append(line)
                    continue
                }

                appendLine(line, to: result)
            }

            if inCodeBlock || !codeLines.isEmpty {
                appendCodeBlock(codeLines, to: result)
            }

            if result.length > 0, result.string.hasSuffix("\n") {
                result.deleteCharacters(in: NSRange(location: result.length - 1, length: 1))
            }

            return result
        }

        private static func appendLine(_ line: String, to result: NSMutableAttributedString) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let leading = String(line.drop(while: { $0 == " " || $0 == "\t" }))

            if trimmed.isEmpty {
                let paragraph = baseParagraph()
                result.append(
                    NSAttributedString(
                        string: "\n",
                        attributes: [.font: bodyFont, .paragraphStyle: paragraph]
                    )
                )
                return
            }

            if isHorizontalRule(leading) {
                let paragraph = baseParagraph()
                paragraph.paragraphSpacing = 6
                result.append(
                    NSAttributedString(
                        string: String(repeating: "─", count: 40) + "\n",
                        attributes: [
                            .font: bodyFont,
                            .foregroundColor: ResultColors.rule,
                            .paragraphStyle: paragraph,
                        ]
                    )
                )
                return
            }

            if let (level, content) = headingContent(leading) {
                let size: CGFloat = level == 1 ? 18 : (level == 2 ? 16 : 14)
                let font = NSFont.systemFont(ofSize: size, weight: .bold)
                let paragraph = baseParagraph()
                paragraph.paragraphSpacing = 6
                result.append(inlineAttributed(content, font: font, paragraph: paragraph, color: ResultColors.text))
                result.append(
                    NSAttributedString(
                        string: "\n",
                        attributes: [.font: font, .paragraphStyle: paragraph]
                    )
                )
                return
            }

            if leading.hasPrefix(">") {
                var content = String(leading.dropFirst())
                if content.hasPrefix(" ") {
                    content.removeFirst()
                }
                let paragraph = baseParagraph()
                paragraph.headIndent = 16
                paragraph.firstLineHeadIndent = 16
                paragraph.paragraphSpacing = 2
                result.append(
                    NSAttributedString(
                        string: "▎ ",
                        attributes: [
                            .font: bodyFont,
                            .foregroundColor: ResultColors.secondaryText,
                            .paragraphStyle: paragraph,
                        ]
                    )
                )
                result.append(
                    inlineAttributed(
                        content,
                        font: bodyFont,
                        paragraph: paragraph,
                        color: ResultColors.secondaryText
                    )
                )
                result.append(
                    NSAttributedString(
                        string: "\n",
                        attributes: [
                            .font: bodyFont,
                            .foregroundColor: ResultColors.secondaryText,
                            .paragraphStyle: paragraph,
                        ]
                    )
                )
                return
            }

            if let content = unorderedListContent(leading) {
                let paragraph = listParagraph()
                result.append(
                    NSAttributedString(
                        string: "• ",
                        attributes: [
                            .font: bodyFont,
                            .foregroundColor: ResultColors.secondaryText,
                            .paragraphStyle: paragraph,
                        ]
                    )
                )
                result.append(
                    inlineAttributed(content, font: bodyFont, paragraph: paragraph, color: ResultColors.text)
                )
                result.append(
                    NSAttributedString(
                        string: "\n",
                        attributes: [.font: bodyFont, .paragraphStyle: paragraph]
                    )
                )
                return
            }

            if let (marker, content) = orderedListContent(leading) {
                let paragraph = listParagraph()
                result.append(
                    NSAttributedString(
                        string: "\(marker) ",
                        attributes: [
                            .font: bodyFont,
                            .foregroundColor: ResultColors.secondaryText,
                            .paragraphStyle: paragraph,
                        ]
                    )
                )
                result.append(
                    inlineAttributed(content, font: bodyFont, paragraph: paragraph, color: ResultColors.text)
                )
                result.append(
                    NSAttributedString(
                        string: "\n",
                        attributes: [.font: bodyFont, .paragraphStyle: paragraph]
                    )
                )
                return
            }

            let paragraph = baseParagraph()
            result.append(inlineAttributed(line, font: bodyFont, paragraph: paragraph, color: ResultColors.text))
            result.append(
                NSAttributedString(
                    string: "\n",
                    attributes: [.font: bodyFont, .paragraphStyle: paragraph]
                )
            )
        }

        private static func appendCodeBlock(
            _ lines: [String],
            to result: NSMutableAttributedString
        ) {
            guard !lines.isEmpty else { return }

            let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 1
            paragraph.headIndent = 10
            paragraph.firstLineHeadIndent = 10
            paragraph.paragraphSpacing = 0

            let attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: ResultColors.text,
                .backgroundColor: ResultColors.codeBackground,
                .paragraphStyle: paragraph,
            ]

            for (index, line) in lines.enumerated() {
                if index > 0 {
                    result.append(NSAttributedString(string: "\n", attributes: attributes))
                }
                result.append(NSAttributedString(string: line, attributes: attributes))
            }
            result.append(NSAttributedString(string: "\n", attributes: attributes))

            // 代码块和下一段之间留一个空行，避免紧贴在一起。
            result.append(
                NSAttributedString(
                    string: "\n",
                    attributes: [.font: bodyFont, .paragraphStyle: baseParagraph()]
                )
            )
        }

        private static func inlineAttributed(
            _ text: String,
            font: NSFont,
            paragraph: NSParagraphStyle,
            color: NSColor?
        ) -> NSAttributedString {
            let result: NSMutableAttributedString
            if let attributed = try? AttributedString(
                markdown: text,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
            ) {
                result = NSMutableAttributedString(attributedString: NSAttributedString(attributed))
            } else {
                result = NSMutableAttributedString(string: text)
            }

            let fullRange = NSRange(location: 0, length: result.length)
            guard fullRange.length > 0 else { return result }

            var baseAttributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .paragraphStyle: paragraph,
            ]
            if let color {
                baseAttributes[.foregroundColor] = color
            }
            result.addAttributes(baseAttributes, range: fullRange)

            // AttributedString 的 Markdown 内联样式桥接后是 InlinePresentationIntent，
            // NSTextView 不会自动把它变成粗体/斜体/等宽字体，这里显式转换。
            result.enumerateAttribute(.inlinePresentationIntent, in: fullRange, options: []) {
                value, range, _ in
                guard let raw = value as? UInt else { return }
                let intent = InlinePresentationIntent(rawValue: raw)

                var intentFont = font
                if intent.contains(.stronglyEmphasized) {
                    intentFont = NSFontManager.shared.convert(
                        intentFont,
                        toHaveTrait: .boldFontMask
                    )
                }
                if intent.contains(.emphasized) {
                    intentFont = NSFontManager.shared.convert(
                        intentFont,
                        toHaveTrait: .italicFontMask
                    )
                }
                if intent.contains(.code) {
                    intentFont = NSFont.monospacedSystemFont(
                        ofSize: max(11, font.pointSize - 1),
                        weight: .regular
                    )
                    result.addAttribute(
                        .backgroundColor,
                        value: ResultColors.inlineCodeBackground,
                        range: range
                    )
                }
                result.addAttribute(.font, value: intentFont, range: range)

                if intent.contains(.strikethrough) {
                    result.addAttribute(
                        .strikethroughStyle,
                        value: NSUnderlineStyle.single.rawValue,
                        range: range
                    )
                }
            }

            // 链接使用固定亮蓝色，避免深色背景下落到系统深色模式的暗色链接。
            result.enumerateAttribute(.link, in: fullRange, options: []) { value, range, _ in
                guard value != nil else { return }
                result.addAttributes(
                    [
                        .foregroundColor: ResultColors.link,
                        .underlineStyle: NSUnderlineStyle.single.rawValue,
                    ],
                    range: range
                )
            }

            return result
        }

        private static func headingContent(_ text: String) -> (Int, String)? {
            let hashes = text.prefix(while: { $0 == "#" }).count
            guard (1...3).contains(hashes) else { return nil }

            let afterHashes = text.index(text.startIndex, offsetBy: hashes)
            guard afterHashes < text.endIndex, text[afterHashes] == " " else { return nil }

            let content = String(text[text.index(after: afterHashes)...])
                .trimmingCharacters(in: .whitespaces)
            return (hashes, content)
        }

        private static func unorderedListContent(_ text: String) -> String? {
            guard let first = text.first, "-*+".contains(first) else { return nil }
            let rest = text.dropFirst()
            guard rest.first == " " || rest.first == "\t" else { return nil }
            return String(rest).trimmingCharacters(in: .whitespaces)
        }

        private static func orderedListContent(_ text: String) -> (String, String)? {
            guard let first = text.first, first.isNumber else { return nil }

            var index = text.startIndex
            var digits = ""
            while index < text.endIndex, text[index].isNumber {
                digits.append(text[index])
                index = text.index(after: index)
            }

            guard !digits.isEmpty, index < text.endIndex else { return nil }
            let delimiter = text[index]
            guard delimiter == "." || delimiter == ")" else { return nil }

            let afterDelimiter = text.index(after: index)
            guard afterDelimiter < text.endIndex else { return nil }
            let space = text[afterDelimiter]
            guard space == " " || space == "\t" else { return nil }

            let content = String(text[text.index(after: afterDelimiter)...])
                .trimmingCharacters(in: .whitespaces)
            return ("\(digits)\(delimiter)", content)
        }

        private static func isHorizontalRule(_ text: String) -> Bool {
            let compact = text.filter { $0 != " " && $0 != "\t" }
            guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else {
                return false
            }
            return compact.allSatisfy { $0 == first }
        }

        private static func baseParagraph() -> NSMutableParagraphStyle {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 2
            paragraph.paragraphSpacing = 4
            return paragraph
        }

        private static func listParagraph() -> NSMutableParagraphStyle {
            let paragraph = baseParagraph()
            paragraph.headIndent = 18
            paragraph.firstLineHeadIndent = 0
            paragraph.paragraphSpacing = 2
            return paragraph
        }
    }
}

/// 结果文本视图：
///   - 单击结果区会由 NSTextView 原生取消选区；
///   - Esc 关闭翻译窗口；
///   - 保留 NSTextView 原生的 ⌘C / ⌘A / 右键复制。
final class SelectableResultTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onEscape: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

        // 结果区获得焦点后，回车仍然触发翻译，并把焦点交还输入框。
        if (event.keyCode == 36 || event.keyCode == 76)
            && !modifiers.contains(.command)
            && !modifiers.contains(.control)
            && !modifiers.contains(.shift)
        {
            onSubmit?()
            return
        }

        super.keyDown(with: event)
    }

    /// 有选区时，⌘C 优先复制选中内容，避免被底部「复制」按钮的快捷键抢走。
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if modifiers == .command,
            event.charactersIgnoringModifiers?.lowercased() == "c",
            selectedRange().length > 0
        {
            copy(nil)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }
}
