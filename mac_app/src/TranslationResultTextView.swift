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
    // 表格：表头 / 斑马纹 / 列分隔线都只用极淡的白色叠加，保持深色面板的一致性。
    static let tableHeaderBackground = NSColor.white.withAlphaComponent(0.10)
    static let tableRowBackground = NSColor.white.withAlphaComponent(0.035)
    static let tableBorder = NSColor.white.withAlphaComponent(0.30)
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

        /// 结果区的轻量 Markdown 排版：标题、列表、引用、代码块、分割线、GFM 表格，
        /// 以及粗体、斜体、行内代码、删除线和链接。多级标题按普通文本显示。
        ///
        /// 表格不用 NSTextTable：结果区要求整段可选中、可复制（⌘C）与划选朗读，
        /// NSTextTable 会把单元格拆成独立文本块，破坏这三条既有行为。
        /// 这里改成「等宽字体 + 列宽对齐的 Markdown 管道表」：内容仍是合法 Markdown，
        /// 但列对齐、表头加粗、超长单元格按列宽折行，不再把 `| --- |` 原样糊在屏幕上。
        private static func renderedAttributed(_ markdown: String) -> NSAttributedString {
            let result = NSMutableAttributedString()
            let lines = markdown.components(separatedBy: "\n")
            var codeLines: [String] = []
            var inCodeBlock = false
            var index = 0

            while index < lines.count {
                let line = lines[index]
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
                    index += 1
                    continue
                }

                if inCodeBlock {
                    codeLines.append(line)
                    index += 1
                    continue
                }

                // 表头行 + 分隔行同时成立才算表格，避免把正文里含竖线的句子误判成表。
                if let (table, nextIndex) = tableBlock(in: lines, at: index) {
                    appendTable(table, to: result)
                    index = nextIndex
                    continue
                }

                appendLine(line, to: result)
                index += 1
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

        // MARK: - GFM 表格
        //
        // 详解模式的「表达推荐 / 简要辨析 / 双语例句」经常被模型输出成 Markdown 表格。
        // 结果区是 NSTextView，用等宽字体 + 列宽对齐渲染成**仍是合法 Markdown 的纯文本**：
        // 表头加粗、支持 :--- / :---: / ---: 对齐、超长单元格按列宽折行（不截断），
        // 因此整段仍可选中、⌘C 复制、划选朗读，行为与原来一致。

        private enum TableAlignment {
            case left, center, right
        }

        private struct MarkdownTable {
            let header: [String]
            let alignments: [TableAlignment]
            let rows: [[String]]

            var columnCount: Int {
                Swift.max(
                    header.count,
                    Swift.max(alignments.count, rows.map(\.count).max() ?? 0)
                )
            }
        }

        private static let tableFont = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
        private static let tableBoldFont = NSFont.monospacedSystemFont(
            ofSize: 11.5,
            weight: .semibold
        )

        /// 结果区可用宽度（窗口 620 - 外层 padding 36 - textContainerInset 24 - 余量 ≈ 540pt）
        /// 换算成等宽字符数，保证表格不横向溢出、不需要横向滚动。
        private static func tableWidthBudget() -> Int {
            let charWidth = (" " as NSString).size(withAttributes: [.font: tableFont]).width
            guard charWidth > 0 else { return 76 }
            return Swift.max(32, Int(floor(540 / charWidth)))
        }

        /// 按未转义、且不在行内代码里的竖线切分；GFM 允许首尾各带一个管道符。
        private static func tableCells(_ line: String) -> [String]? {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.contains("|") else { return nil }

            let chars = Array(trimmed)
            var cells: [String] = []
            var current = ""
            var inCode = false
            var index = 0

            while index < chars.count {
                let ch = chars[index]
                // 只吞掉转义竖线的反斜杠，其它反斜杠原样保留（例如 Windows 路径）。
                if ch == "\\", index + 1 < chars.count, chars[index + 1] == "|" {
                    current.append("|")
                    index += 2
                    continue
                }
                if ch == "`" {
                    inCode.toggle()
                    current.append(ch)
                    index += 1
                    continue
                }
                if ch == "|" && !inCode {
                    cells.append(current.trimmingCharacters(in: .whitespaces))
                    current = ""
                    index += 1
                    continue
                }
                current.append(ch)
                index += 1
            }
            cells.append(current.trimmingCharacters(in: .whitespaces))

            if cells.first?.isEmpty == true { cells.removeFirst() }
            if cells.last?.isEmpty == true { cells.removeLast() }
            return cells.isEmpty ? nil : cells
        }

        private static func separatorAlignments(_ line: String) -> [TableAlignment]? {
            guard let cells = tableCells(line), !cells.isEmpty else { return nil }
            var alignments: [TableAlignment] = []
            for cell in cells {
                var body = cell.filter { $0 != " " && $0 != "\t" }
                guard body.count >= 3 else { return nil }
                var hasLeftColon = false
                var hasRightColon = false
                if body.hasPrefix(":") {
                    hasLeftColon = true
                    body.removeFirst()
                }
                if body.hasSuffix(":") {
                    hasRightColon = true
                    body.removeLast()
                }
                guard body.count >= 3, body.allSatisfy({ $0 == "-" }) else { return nil }
                alignments.append(
                    hasLeftColon && hasRightColon
                        ? .center
                        : (hasRightColon ? .right : .left)
                )
            }
            return alignments
        }

        private static func tableBlock(in lines: [String], at start: Int)
            -> (MarkdownTable, Int)?
        {
            guard start + 1 < lines.count,
                let header = tableCells(lines[start]), !header.isEmpty,
                let alignments = separatorAlignments(lines[start + 1]),
                alignments.count == header.count
            else { return nil }

            var rows: [[String]] = []
            var index = start + 2
            while index < lines.count {
                let line = lines[index]
                if line.trimmingCharacters(in: .whitespaces).isEmpty { break }
                guard let cells = tableCells(line) else { break }
                rows.append(cells)
                index += 1
            }
            return (MarkdownTable(header: header, alignments: alignments, rows: rows), index)
        }

        /// 等宽字体下 CJK / 全角字符占两列，按显示宽度填充空格才能真正对齐。
        private static func displayWidth(_ text: String) -> Int {
            var width = 0
            for scalar in text.unicodeScalars {
                let value = scalar.value
                let isWide = (value >= 0x1100 && value <= 0x115F)
                    || (value >= 0x2E80 && value <= 0xA4CF)
                    || (value >= 0xAC00 && value <= 0xD7A3)
                    || (value >= 0xF900 && value <= 0xFAFF)
                    || (value >= 0xFE10 && value <= 0xFE19)
                    || (value >= 0xFE30 && value <= 0xFE6F)
                    || (value >= 0xFF00 && value <= 0xFF60)
                    || (value >= 0xFFE0 && value <= 0xFFE6)
                    || (value >= 0x1F300 && value <= 0x1FAFF)
                    || (value >= 0x20000 && value <= 0x3FFFD)
                width += isWide ? 2 : 1
            }
            return width
        }

        /// 按显示宽度把单元格折成多段 attributed string：内容完整保留，不截断。
        /// 英文优先在空格处断行，避免把 `take care of` 拆成 `take car` / `e of`；
        /// 中文等无空格文本按字符折行。
        private static func wrapAttributed(_ attr: NSAttributedString, width: Int)
            -> [NSAttributedString]
        {
            guard width > 0 else { return [attr] }
            let source = attr.string as NSString
            guard source.length > 0 else { return [attr] }

            func trimEndWhitespace(_ text: NSMutableAttributedString) {
                while text.length > 0 {
                    let last = (text.string as NSString).substring(
                        with: NSRange(location: text.length - 1, length: 1)
                    )
                    guard last == " " || last == "\t" else { break }
                    text.deleteCharacters(in: NSRange(location: text.length - 1, length: 1))
                }
            }

            var pieces: [NSAttributedString] = []
            var current = NSMutableAttributedString()
            var currentWidth = 0
            var location = 0

            while location < source.length {
                let range = source.rangeOfComposedCharacterSequence(at: location)
                let pieceWidth = displayWidth(source.substring(with: range))

                if currentWidth + pieceWidth > width, current.length > 0 {
                    // 回溯到最近的空格作为断点；没有空格就整行硬折。
                    var cut = current.length
                    let currentString = current.string as NSString
                    if current.length > 1 {
                        for index in stride(from: current.length - 1, through: 1, by: -1) {
                            let ch = currentString.substring(with: NSRange(location: index - 1, length: 1))
                            if ch == " " || ch == "\t" {
                                cut = index
                                break
                            }
                        }
                    }

                    let head = NSMutableAttributedString(
                        attributedString: current.attributedSubstring(
                            from: NSRange(location: 0, length: cut)
                        )
                    )
                    trimEndWhitespace(head)
                    if head.length > 0 { pieces.append(head) }

                    let tail = NSMutableAttributedString(
                        attributedString: current.attributedSubstring(
                            from: NSRange(location: cut, length: current.length - cut)
                        )
                    )
                    while tail.length > 0 {
                        let first = (tail.string as NSString).substring(
                            with: NSRange(location: 0, length: 1)
                        )
                        guard first == " " || first == "\t" else { break }
                        tail.deleteCharacters(in: NSRange(location: 0, length: 1))
                    }
                    current = tail
                    currentWidth = displayWidth(current.string)
                }

                current.append(attr.attributedSubstring(from: range))
                currentWidth += pieceWidth
                location = NSMaxRange(range)
            }

            trimEndWhitespace(current)
            pieces.append(current)
            return pieces
        }

        private static func tableParagraph() -> NSMutableParagraphStyle {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 1
            paragraph.paragraphSpacing = 0
            paragraph.headIndent = 0
            paragraph.firstLineHeadIndent = 0
            return paragraph
        }

        private static func tablePlain(_ text: String, color: NSColor)
            -> NSMutableAttributedString
        {
            NSMutableAttributedString(
                string: text,
                attributes: [
                    .font: tableFont,
                    .foregroundColor: color,
                    .paragraphStyle: tableParagraph(),
                ]
            )
        }

        private static func tableCellAttributed(_ raw: String, bold: Bool) -> NSAttributedString {
            inlineAttributed(
                raw,
                font: bold ? tableBoldFont : tableFont,
                paragraph: tableParagraph(),
                color: ResultColors.text
            )
        }

        private static func paddedCell(
            _ attr: NSAttributedString,
            width: Int,
            alignment: TableAlignment
        ) -> NSMutableAttributedString {
            let padding = Swift.max(0, width - displayWidth(attr.string))
            let left: Int
            let right: Int
            switch alignment {
            case .left:
                left = 0
                right = padding
            case .right:
                left = padding
                right = 0
            case .center:
                left = padding / 2
                right = padding - left
            }

            let out = NSMutableAttributedString()
            if left > 0 {
                out.append(tablePlain(String(repeating: " ", count: left), color: ResultColors.text))
            }
            out.append(attr)
            if right > 0 {
                out.append(tablePlain(String(repeating: " ", count: right), color: ResultColors.text))
            }
            return out
        }

        private static func appendTableRow(
            _ cells: [NSAttributedString],
            widths: [Int],
            alignments: [TableAlignment],
            columns: Int,
            isHeader: Bool,
            rowIndex: Int,
            to result: NSMutableAttributedString
        ) {
            let wrapped: [[NSAttributedString]] = (0..<columns).map { column in
                let attr = column < cells.count
                    ? cells[column]
                    : NSAttributedString(string: "")
                return wrapAttributed(attr, width: widths[column])
            }
            let lineCount = Swift.max(1, wrapped.map(\.count).max() ?? 1)
            let background: NSColor? = isHeader
                ? ResultColors.tableHeaderBackground
                : (rowIndex % 2 == 1 ? ResultColors.tableRowBackground : nil)

            for line in 0..<lineCount {
                let row = NSMutableAttributedString()
                row.append(tablePlain("| ", color: ResultColors.tableBorder))
                for column in 0..<columns {
                    let piece = line < wrapped[column].count
                        ? wrapped[column][line]
                        : NSAttributedString(string: "")
                    row.append(
                        paddedCell(piece, width: widths[column], alignment: alignments[column])
                    )
                    row.append(
                        tablePlain(
                            column == columns - 1 ? " |" : " | ",
                            color: ResultColors.tableBorder
                        )
                    )
                }
                row.append(tablePlain("\n", color: ResultColors.text))
                if let background {
                    row.addAttribute(
                        .backgroundColor,
                        value: background,
                        range: NSRange(location: 0, length: row.length - 1)
                    )
                }
                result.append(row)
            }
        }

        private static func appendTableSeparator(
            widths: [Int],
            columns: Int,
            to result: NSMutableAttributedString
        ) {
            let row = NSMutableAttributedString()
            row.append(tablePlain("|", color: ResultColors.tableBorder))
            for column in 0..<columns {
                row.append(
                    tablePlain(
                        String(repeating: "-", count: widths[column] + 2),
                        color: ResultColors.tableBorder
                    )
                )
                row.append(tablePlain("|", color: ResultColors.tableBorder))
            }
            row.append(tablePlain("\n", color: ResultColors.text))
            result.append(row)
        }

        private static func appendTable(_ table: MarkdownTable, to result: NSMutableAttributedString) {
            let columns = table.columnCount
            guard columns > 0 else { return }
            let alignments: [TableAlignment] = (0..<columns).map {
                $0 < table.alignments.count ? table.alignments[$0] : .left
            }

            let headerCells = table.header.map { tableCellAttributed($0, bold: true) }
            let bodyCells = table.rows.map { row in
                row.map { tableCellAttributed($0, bold: false) }
            }

            // 列宽：
            //   1. 先取该列内容的自然宽度，但单个超长单元格不能吃掉整表预算（否则其它列会被压到
            //      4 字符，把 handle 拆成 hand/le）——给每列一个上限，长文本改用折行解决。
            //   2. 每列有下限，保证常见短词/中文词组不被硬拆。
            //   3. 总宽仍超预算时才按比例压缩，并逐格回收最宽列的多余宽度。
            var natural = Array(repeating: 0, count: columns)
            for (column, attr) in headerCells.enumerated() where column < columns {
                natural[column] = Swift.max(natural[column], displayWidth(attr.string))
            }
            for row in bodyCells {
                for (column, attr) in row.enumerated() where column < columns {
                    natural[column] = Swift.max(natural[column], displayWidth(attr.string))
                }
            }

            let budget = Swift.max(columns * 10, tableWidthBudget() - (columns * 3 + 1))
            let perColumnCap = Swift.max(12, (budget / columns) * 2)
            let minWidth = Swift.min(12, Swift.max(6, budget / columns))
            let lowerBound = Swift.min(6, minWidth)
            var widths = natural.map { Swift.max(minWidth, Swift.min($0, perColumnCap)) }
            let total = widths.reduce(0, +)
            if total > budget {
                widths = widths.map {
                    Swift.max(
                        lowerBound,
                        Int(floor(Double($0) * Double(budget) / Double(total)))
                    )
                }
                while widths.reduce(0, +) > budget,
                    let widest = widths.indices.max(by: { widths[$0] < widths[$1] }),
                    widths[widest] > lowerBound
                {
                    widths[widest] -= 1
                }
            }

            let spacer = NSAttributedString(
                string: "\n",
                attributes: [.font: bodyFont, .paragraphStyle: baseParagraph()]
            )
            appendTableRow(
                headerCells,
                widths: widths,
                alignments: alignments,
                columns: columns,
                isHeader: true,
                rowIndex: 0,
                to: result
            )
            appendTableSeparator(widths: widths, columns: columns, to: result)
            for (index, row) in bodyCells.enumerated() {
                appendTableRow(
                    row,
                    widths: widths,
                    alignments: alignments,
                    columns: columns,
                    isHeader: false,
                    rowIndex: index,
                    to: result
                )
            }
            result.append(spacer)
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
